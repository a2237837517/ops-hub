# Agent ↔ Hub 协议

传输：WebSocket over TLS（`wss://ops.example.com/agent`），JSON 文本帧。  
大块数据（命令输出、文件块）用 base64 放在 JSON 里；单块默认 256KB，避免内存暴涨。

## 认证与注册

Agent 连接后第一条消息必须是 `hello`：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "clientId": "customerA-app01-1a2b3c4d5e",
  "name": "customerA-app01",
  "hostname": "app01",
  "os": "windows Server 2012 R2",
  "arch": "amd64",
  "version": "0.1.0",
  "tags": ["customer:A", "prod"],
  "enrollmentToken": "一次性注册令牌",
  "agentToken": "已注册客户端的 token；首次为空",
  "jobs": [
    { "jobId": "job_xxx", "status": "running", "agentOffset": 12345 }
  ]
}
```

Hub 校验：

- 已注册的 `clientId`：必须匹配已保存的 `agentToken`。
- 新客户端：必须匹配 `auth.enrollmentToken`；通过后 Hub 生成独立 token，在 `hello_ack` 返回，Agent 持久化到 `agent-state.json`。
- 同一个 `clientId` 重复连接：新连接替换旧连接。

`hello_ack`：

```json
{
  "type": "hello_ack",
  "protocolVersion": 1,
  "clientId": "...",
  "agentToken": "首次注册时下发",
  "heartbeatIntervalSec": 15,
  "serverTime": "2026-11-11T07:00:00.000Z"
}
```

心跳：Agent 每 15s 发 `heartbeat`，Hub 回 `heartbeat_ack`；45s 无心跳标记离线。

## RPC

Hub → Agent：

```json
{ "type": "rpc", "requestId": "rpc_xxx", "method": "file.read", "params": { ... } }
```

Agent → Hub：

```json
{ "type": "rpc_result", "requestId": "rpc_xxx", "ok": true, "result": { ... } }
```

方法：

| method | params | 说明 |
|---|---|---|
| `client.info` | `{include?:["disks","network","cpu","users"]}` | 主机信息 |
| `client.stats` | `{}` | 实时 CPU/内存/磁盘/负载 |
| `file.read` | `{path,offset,maxBytes,encoding}` | 分页读文本 |
| `file.tail` | `{path,lines,cursor,encoding}` | 滚动日志 |
| `file.search` | `{path,pattern,regex,caseSensitive,before,after,maxMatches,encoding}` | 搜索 |
| `file.list` | `{path,pattern,recursive,maxEntries}` | 目录 |
| `file.stat` | `{path,hash}` | 文件信息 |
| `file.write` | `{path,content,encoding,append,createDirs}` | 写文本 |

## 命令执行

Hub → Agent：

```json
{
  "type": "exec.start",
  "jobId": "job_xxx",
  "command": "echo hello",
  "shell": "bash",
  "cwd": "/tmp",
  "env": { "FOO": "bar" },
  "timeoutMs": 3600000,
  "maxOutputBytes": 52428800
}
```

Agent → Hub：

```json
{"type":"exec.started","jobId":"job_xxx","pid":1234,"startedAt":"..."}
```

输出分块：

```json
{
  "type": "exec.chunk",
  "jobId": "job_xxx",
  "offset": 0,
  "endOffset": 26,
  "seq": 0,
  "stream": "stdout",
  "data": "aGVsbG8K",
  "truncated": false
}
```

- `offset` / `endOffset` 是 Agent spool 文件里的字节偏移，包含 13 字节帧头。
- Hub 回 `exec.chunk.ack {jobId, offset}`。
- Hub 把输出追加到 `data/jobs/<jobId>.log`，`ops_exec_output` 的 offset 是这个文本文件的字节 offset。

退出：

```json
{
  "type": "exec.exit",
  "jobId": "job_xxx",
  "exitCode": 0,
  "cancelled": false,
  "error": null,
  "endedAt": "..."
}
```

取消：Hub → Agent `{"type":"exec.cancel","jobId":"job_xxx"}`，Agent 杀进程树。

断线恢复：Hub → Agent：

```json
{ "type": "exec.resume", "jobId": "job_xxx", "offset": 12345 }
```

Agent 从 spool 的 `offset` 开始重放帧；如果任务已经退出，再补发一次 `exec.exit`。  
Agent 重启后找不到 job，回 `exec.lost`，Hub 标记 `lost/interrupted`。

## 文件传输

上传（Hub → Agent）：

```json
{"type":"file.upload.start","transferId":"up_xxx","path":"C:\\tmp\\a.log","size":123,"sha256":"...","overwrite":true,"createDirs":true}
```
```json
{"type":"file.upload.chunk","transferId":"up_xxx","offset":0,"data":"..."}
```
```json
{"type":"file.upload.ack","transferId":"up_xxx","received":131072}
```
```json
{"type":"file.upload.done","transferId":"up_xxx","size":123,"sha256":"..."}
```

Agent 先写 `<target>.opshubpart`，校验 size/sha256 后原子 rename；失败发 `file.upload.error`。

下载（Agent → Hub）：

```json
{"type":"file.download.start","transferId":"down_xxx","path":"/var/log/app.log","offset":0}
```
```json
{"type":"file.download.chunk","transferId":"down_xxx","offset":0,"data":"..."}
```
```json
{"type":"file.download.ack","transferId":"down_xxx","offset":262144}
```
```json
{"type":"file.download.done","transferId":"down_xxx","size":123,"sha256":"..."}
```

Hub 写 `*.part-<transferId>`，校验后 rename。

## 日志 cursor

`file.tail` 返回的 `cursor` 是 base64url(JSON)：

```json
{ "offset": 12345, "fileId": "66306:29622660", "pending": "半行内容" }
```

- `offset`：下一次从文件哪个字节开始读。
- `fileId`：Linux `dev:ino`，Windows volume/file index；用于检测轮转。
- `pending`：文件末尾没有换行的半行，下次拼到新内容前面。
- 文件变小或 `fileId` 变化 → `rotated: true`，重置 cursor。

## 限制

- 文本输出默认按 UTF-8 传输；Agent 负责把 GBK/GB18030/UTF-16 转成 UTF-8。
- 单条 WebSocket 消息上限 16MB；文件块默认 256KB。
- 单任务输出默认上限 50MB，超过后 Agent 写截断标记。
- 命令不是 PTY；需要交互输入的命令会挂起，需后续扩展 `exec.input`。
