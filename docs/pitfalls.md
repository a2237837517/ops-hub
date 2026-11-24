# ops-hub 客户端操作踩坑记录

> **适用范围：仅限本仓库 ops-hub。**
> 以下每条都是「用 ops-hub 的 MCP / HTTP / agent 去操作客户端」时踩的坑。
> 不适用于 server-ops 的 SSH 直连运维，也不适用于其它项目，别搬迁结论。

**一句话原则：先读 ops-hub 的状态再动手；解析放本地，别靠客户端原生命令的输出直接下结论；做完检查残留。**

---

## 0. 动手前（ops-hub 侧固定动作）

1. `ops_list_clients` 确认目标 `status=online`。离线就停，不要重试。
2. 目标机器当前 job 数不能到 `limits.maxConcurrentJobsPerClient`（默认 4），否则 `startJob` 直接抛「并发任务已达上限」。
3. 用 `clientId` 定位，不要用中文显示名。

---

## 1. `ops_exec` / `/api/clients/:id/exec`

| 坑 | 现象 | 规避 |
|---|---|---|
| `ops_exec` 默认只等 15s | 返回时 job 还是 `running`，只拿到前半段输出 | 用返回的 `job_id` 轮询 `/api/jobs/:id/output`，直到状态进入 `exited/failed/cancelled/interrupted/lost/disconnected` |
| 分页重复 | 输出重复或跳字 | 每轮把上一轮的 `nextOffset` 当 `offset` |
| 输出混流 | 文本夹 `[stderr] ` / `[stdout] ` | 这是 job-manager 加的分界标记，不是命令输出 |
| 命令超长 | `command 太长` | 超过 20000 字符会被拒，改写成文件再执行 |
| 高危命令 | `DANGEROUS_COMMAND` | 命中 `security.dangerousPatterns` 时必须显式 `approveDangerous:true` |
| 任务其实是 agent 侧超时 | `job.error === 'timeout'` | 这是 agent 杀的进程树，不是 hub 断线 |

轮询模板：

```python
job = post(f'/clients/{cid}/exec',
           {'command': cmd, 'timeoutMs': 120000, 'approveDangerous': True})['job']
offset = 0
while True:
    o = get(f"/jobs/{job['id']}/output?offset={offset}")
    offset = o['nextOffset']
    if o['job']['status'] in ('exited','failed','cancelled','interrupted','lost','disconnected'):
        break
```

---

## 2. 中文 Windows 输出乱码（ops-hub agent 的编码嗅探导致）

**现象**：`��ɾ p2p.exe`、`? �˿���ռ��`

**ops-hub 侧原因**：agent 的 `newDecodedReader` 只嗅探前 4KB。命令开头是 ASCII
（如 `=== SERVER02 ===`）时会判成 UTF-8，后面的 GBK 字节原样上传；
hub 的 `JobManager._onChunk` 再按 UTF-8 解码，就成乱码。

**规避（按优先级）**：

1. **不要用中文输出判断成败**。用 `exitCode`，或自己 `echo DELETED` / `echo MISSING` 这类 ASCII 标记。
2. PowerShell 命令开头统一加：
   ```
   [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
   ```
3. 要读中文内容时，先 `Out-File -Encoding utf8` 写到文件，再用 `ops_read_file`（agent 会正确转码）。
4. 已知编码就显式传 `encoding`；`ops_read_file` 支持 `utf-8` / `gbk` / `gb18030` / `utf-16le`。
5. 用 `ConvertTo-Json -Compress` 出结构化结果，彻底绕开文本解析。

---

## 3. 端口判断（ops-hub 上误判过的一类）

### 坑 A：远端 `findstr` 把执行脚本自己算成占用者

```
powershell -Command "netstat -ano | findstr :19002"
```

输出里会出现 `powershell.exe` 自己（PID 就是当前执行进程），看起来「端口仍被占用」。
我在 ops-hub 上实际因此误报过一次 19002。

**规避**：`exec` 只负责取全量 `netstat -ano` 和 `tasklist /fo csv /nh`，
关联和过滤放在 hub 侧或本地脚本：

- 只认 `LISTENING`（UDP 看 `UDP`）且 `PID > 0`；
- 进程名是 `powershell / pwsh / cmd / bash / sh` 的一律排除；
- 不要在一条命令里把取数和 grep 混着做。

### 坑 B：`TIME_WAIT` / `pid=0` 不是占用

`netstat` 里常有几十行 `127.0.0.1:19002 TIME_WAIT 0`（系统内核条目）。
只保留 `LISTENING` / `ESTABLISHED`。

### 坑 C：`tasklist /fi "PID eq 112988"` 报错

```
错误: 无效参数/选项 - 'eq'
```

部分客户端环境解析不了 `/fi` 的 `eq`。改用：

- `tasklist /fo csv /nh` 取全量，本地按 PID 过滤；或
- `Get-CimInstance Win32_Process -Filter "ProcessId=112988"`（最稳）。

### 坑 D：把 `UDP` 行当 `TCP` 解析

`netstat` 的 `TCP` 有 5 列（多一个状态），`UDP` 只有 4 列。按协议分开取，否则 PID 取错列。

---

## 4. 进程与残留（ops-hub job 相关）

| 坑 | 现象 | 规避 |
|---|---|---|
| `cancel` 后进程还活着 | 实测 cancel 后 19001 仍被 `p2p.exe` 占着 | cancel 之后必须复查端口，必要时 `taskkill /PID <pid> /T /F` |
| 并发起两个监听 | `bind: Only one usage of each socket address` | 起监听前先查端口，先杀旧进程 |
| 上传的测试程序忘删 | `C:\Windows\Temp\p2p.exe` 一直留着 | 收尾固定两步：删文件 + 确认端口 |
| 按名字杀进程 | `taskkill /IM xxx.exe` 名字撞车会误杀业务进程 | 按 PID 杀；按名字杀前先 `tasklist` 确认只有目标 |

**ops-hub 侧收尾必查**：自己上传的文件、自己用过的测试端口、是否还有 `running` / `queued` job。

---

## 5. 文件传输（ops-hub 接口细节）

| 项 | 说明 |
|---|---|
| `path` 编码 | `/files/upload?path=` 的 path 必须 URL 编码（反斜杠、中文都要 encode） |
| Content-Type | 上传走原始流（hub 对 `/files/upload` 跳过了 JSON parser），必须 `application/octet-stream` |
| 大文件 | `upload/init` → `upload/chunk` → `upload/complete`；单次 `upload` 适合小文件 |
| 覆盖 | 已存在文件需 `overwrite=1`，默认不覆盖会报错 |
| 下载落点 | 限制在 `data/downloads/<clientId>/` 内 |
| 远端路径 | 必须在 agent 的 `allowedRoots` 内，否则报「路径不在 allowedRoots 内」 |
| 接口不存在 | `/files/upload/init` 之类 404 说明连的 hub 版本没这个路由，先 `curl /health` 和 `ops_access_info` 对版本 |

---

## 6. 客户端身份（ops-hub 规则）

- `clientId` = `sanitizeID(hostname) + "-" + sha256(machineID|hostname)[:10]`；重装可复现，但**改主机名会变**。
- `store.findAgent` 只做**精确**匹配（id / name / hostname，大小写不敏感），**不支持模糊**。先 `ops_list_clients` 拿准确 id。
- 重命名只改 `displayName`，`clientId` 不变；`group` 仍是安装包 `config.json` 里的 `name`。
- 同一 `clientId` 从另一台机器接入会被拒（防顶号）。整机克隆后必须删掉 `agent-state.json` 重新注册。

---

## 7. 限制值（改行为前先看）

| 限制 | 默认值 | 超了会怎样 |
|---|---|---|
| 每客户端并发 job | 4 | `startJob` 抛错 |
| 单 job 输出 | 50MB | 标记 `truncated` |
| 单次读取 | 256KB | 需要 `offset` 分页 |
| `command` 长度 | 20000 | 直接拒 |
| job 超时 | 24h 上限 | agent 杀进程树，`error=timeout` |
| 上传单文件 | 2GB | `maxFileBytes` 拒 |

轮询间隔 1 秒足够，别空转。

---

## 8. 环境结论（ops-hub 在这批客户端上实测）

- **Windows Server 2012 R2 只能用 Go 1.20 构建的 agent**，Go 1.24 二进制起不来。
- 隧道访问公网目标要**客户端** `config.json` 的 `allowPublicTargets: true`；
  hub 的 `tunnel.allowedCidrs` 只是前置条件，两者都要满足。
- 这批学校机器都在运营商/教育网大 NAT 后：无公网 IPv4，**也无公网 IPv6**
  （网卡启用了 IPv6，但无地址、无默认路由）。P2P 打洞实测全失败，别再投入。

---

## 9. ops-hub 侧安全红线

- 不要 stop / restart 正在跑业务的客户端服务。
- **只删文件不删目录**；不要 `del /s *.log`、`rd /s /q`。
- agent 会拒绝受保护路径（`C:\Windows`、`/`、`/etc`、`/home` 等），不要试图绕过。
- 生产机器优先只读排查，写操作先确认。
- 动作都进 `data/audit.jsonl`，用 `/api/audit` 核对。

---

## 10. 收尾检查单（每次 ops-hub 操作后）

```
□ 测试端口已释放（LISTENING 里没有）
□ 测试进程已退出（按名字查不到）
□ 上传的临时文件已删除
□ 没有遗留 running / queued job
□ 没有动过业务服务
```
