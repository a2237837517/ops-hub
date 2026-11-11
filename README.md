# Ops Hub

**Self-hosted reverse-connection remote operations hub with MCP tools for AI agents.**

Ops Hub lets you manage Windows and Linux machines that are behind NAT, firewalls, or have no SSH/WinRM access. The Agent only makes an **outbound WebSocket connection** to your hub; you do not need a public IP, inbound port, port forwarding, or a VPN on the target machine.

The hub exposes the managed machines as **MCP (Model Context Protocol) tools**, so AI agents (Claude, OpenAI-compatible agents, OpenCode, MCP gateways, etc.) can:

- list clients and read host information
- run commands and stream/poll output
- upload and download files with chunking and SHA-256 verification
- page through text files
- tail logs with a cursor that survives reconnects and log rotation
- search logs on the Agent side (grep-like, with context)
- survive network drops and replay unfinished command output

> This is **not** a remote desktop or GUI tool. Keep using RDP/VNC/Sunflower/ToDesk for GUI access. Ops Hub is for CLI, files, logs, and automation.

---

## ⚠️ Authorized Use Only / 合法使用声明

**Read this before deploying.**

Ops Hub can execute commands and transfer files on remote machines. That is a powerful capability and can be misused. It is intended **only** for:

- IT administrators managing machines they own
- managed service providers managing customer machines with **explicit written authorization**
- lab, test, and internal automation environments
- incident response and maintenance on systems you are responsible for

**Do not use Ops Hub for:**

- unauthorized access to computers, accounts, or data
- covert surveillance, stalking, harassment, or monitoring people without consent
- deploying malware, ransomware, miners, or persistence mechanisms
- bypassing security controls, license checks, or access restrictions
- violating privacy laws, computer-misuse laws, contracts, or customer policies
- any activity that is illegal in your jurisdiction

You are solely responsible for:

- obtaining authorization from the system owner and the customer
- complying with laws and regulations (e.g. computer fraud/abuse laws, GDPR, China PIPL, data protection and privacy rules)
- customer contracts, data-processing agreements, and security policies
- securing the hub, tokens, TLS certificates, audit logs, and downloaded data

The software is provided **“AS IS”**, without warranty of any kind. The author is **not liable** for misuse, data loss, service interruption, legal claims, or damages caused by this software. See [LICENSE](LICENSE).

If you are not sure whether you are allowed to manage a machine, **do not install the Agent**.

---

## Keywords

`MCP` · `Model Context Protocol` · `MCP server` · `MCP tools` · `AI agent` · `AI operations` · `AIOps` · `remote operations` · `remote administration` · `RMM` · `IT operations` · `DevOps` · `SRE` · `infrastructure management` · `self-hosted` · `WebSocket` · `reverse connection` · `NAT traversal` · `remote shell` · `command execution` · `file transfer` · `log tail` · `log viewer` · `Windows Server` · `Linux` · `Golang` · `Node.js` · `MCP gateway` · `MCPHub` · `Claude` · `OpenAI` · `automation`

GitHub topics are configured on the repository page. The project is designed to be discoverable by people looking for **self-hosted MCP remote operations**, **AI agent server management**, and **reverse-connection RMM**.

---

## Features

### Hub (Node.js)

- Agent WebSocket gateway with registration, per-agent tokens, heartbeat, and reconnect
- Command jobs with on-disk spool, incremental output, byte offsets, timeout, cancel, and process-tree termination
- Chunked file upload/download with SHA-256 and atomic writes
- MCP server over **Streamable HTTP** (and legacy-compatible JSON-RPC behavior)
- 15 MCP tools covering inventory, command execution, files, logs, and search
- Web admin UI: clients, terminal, files, jobs, audit
- Rename clients (Hub display name) and view OS/IP/CPU/memory/disk info
- File browser with parent-directory navigation, left-side upload/download, drag-and-drop upload, and download-only handling for archives/binaries (`.gz`, `.zip`, images, etc.)
- Delete files or directories from the UI (with confirmation); protected system roots are refused by the Agent
- JSON state persistence + JSONL audit log
- Dangerous-command approval policy
- Client revocation list
- No inbound connection to agents

### Agent (Go, single binary)

- Windows amd64 / 386, Linux amd64 / arm64 / 386
- Native Windows service (no nssm/Node/Python dependency)
- Linux systemd installer
- Host info: OS, CPU, memory, disks, network, users, uptime
- Command execution: cmd / PowerShell / bash / sh
- stdout/stderr framing and replay after reconnect
- File read/tail/search/list/stat/write
- Upload/download with SHA-256
- UTF-8 / GBK / GB18030 / UTF-16 detection
- Log rotation/truncation and partial-line handling
- `allowedRoots` path sandbox for file APIs
- TLS 1.2+, custom CA, HTTP proxy support
- Exponential backoff reconnect

---

## Architecture

```text
AI agent / OpenCode / Claude / MCP client
   │  MCP over HTTPS
   ▼
MCP gateway (MCPHub, etc.)  ── mcp.example.com
   │  MCP Streamable HTTP (private network)
   ▼
ops-hub  ── 127.0.0.1:7100
   ▲
   │  WSS 443, outbound only
   │
┌──┴──────────────┬─────────────────┬──────────────┐
│ Windows Agent   │ Linux Agent     │ Windows Agent│
│ customer A      │ customer B      │ lab machine  │
└─────────────────┴─────────────────┴──────────────┘
```

Physical path:

```text
Agent  →  wss://ops.example.com/agent  →  edge nginx  →  127.0.0.1:7100
MCP gateway →  http://127.0.0.1:7100/mcp
```

The Agent never listens on an inbound port. The hub never dials the Agent. This is what makes NAT/firewall traversal possible without a VPN or port mapping.

---

## Quick Start (local)

Requirements: Node.js >= 20.

```bash
git clone https://github.com/a2237837517/ops-hub.git
cd ops-hub
npm install
cp config.example.json config.local.json
```

Edit `config.local.json` and change all three tokens:

```json
{
  "hub": {
    "host": "0.0.0.0",
    "port": 7100,
    "publicUrl": "wss://ops.example.com/agent"
  },
  "auth": {
    "enrollmentToken": "replace-with-a-random-enrollment-token",
    "mcpToken": "replace-with-a-random-mcp-token",
    "adminToken": "replace-with-a-random-admin-token"
  }
}
```

Start:

```bash
node index.js serve
```

Open `http://127.0.0.1:7100` and log in with `adminToken`.

After login, click **下载客户端** in the top bar to download the Windows/Linux
Agent package and a ready-to-edit `config.json` (the config includes the current
enrollment token, so only share it with authorized machines).

If the download page says no packages are available, build them first:

```bash
./scripts/package-agent.sh
```

The script writes packages to `dist/packages/` and copies them to
`public/downloads/` for the Hub UI.

### Web terminal shortcuts

The admin UI terminal works like a shell prompt:

- `cd <path>` changes the working directory for subsequent commands
- `Enter` executes the current command
- `↑` / `↓` browse command history (stored per client in the browser)
- `Ctrl+L` clears the screen
- `Ctrl+C` cancels the running job (when no text is selected)
- `help` prints the built-in shortcut help

Click anywhere in the terminal panel to focus the prompt.

CLI:

```bash
node index.js clients
node index.js exec <clientId> "uname -a" --shell bash
node index.js doctor
node index.js token
```

---

## Build the Agent

Requirements: Go 1.20 (the last Go release supporting Windows 7 / Server 2008 R2).

```bash
./scripts/build-agent.sh
./scripts/package-agent.sh
```

Outputs:

```text
dist/agent/ops-agent-windows-amd64.exe
dist/agent/ops-agent-windows-386.exe
dist/agent/ops-agent-linux-amd64
dist/agent/ops-agent-linux-arm64
dist/agent/ops-agent-linux-386
dist/packages/*.zip
dist/packages/*.tar.gz
```

If Go is not installed, use the official Go 1.20 tarball or a `golang:1.20` container. The build script uses `GO_BIN` or `go` from `PATH`.

---

## Agent Installation

### Windows / Windows Server

Supported: Windows Server 2008 R2 and later (amd64/386). Windows Server 2008 (non-R2) is outside Go 1.20's support range.

1. Extract the zip.
2. Copy `config.example.json` to `config.json`.
3. Fill in `server`, `enrollmentToken`, `name`, `tags`, and `allowedRoots`.
4. Right-click `install.bat` → **Run as administrator**.

The Agent installs as the `OpsHubAgent` Windows service and writes logs to:

```text
C:\ProgramData\OpsHubAgent\logs\agent.log
```

State (client ID + token):

```text
C:\ProgramData\OpsHubAgent\agent-state.json
```

Do not delete `agent-state.json` unless you intend to re-enroll the client.

Uninstall:

```text
Right-click uninstall.bat → Run as administrator
```

### Linux

```bash
tar -xzf ops-agent-linux-amd64.tar.gz
cd ops-agent-linux-amd64
cp config.example.json config.json
vi config.json
sudo ./install-linux.sh
```

Service name: `ops-hub-agent`  
Logs: `/opt/ops-hub-agent/logs/agent.log`

Uninstall:

```bash
sudo ./uninstall-linux.sh
```

### Agent Config

```json
{
  "server": "wss://ops.example.com/agent",
  "enrollmentToken": "replace-me",
  "agentToken": "",
  "clientId": "",
  "name": "customerA-app01",
  "tags": ["customer:A", "prod"],
  "spoolDir": "",
  "allowedRoots": ["C:\\", "D:\\"],
  "maxSpoolMB": 2048,
  "maxConcurrentJobs": 4,
  "insecureSkipVerify": false,
  "caFile": "",
  "proxy": "",
  "heartbeatIntervalSec": 15
}
```

- `allowedRoots` restricts file APIs. Empty means “allow all” — set it in production.
- `proxy` supports `http://user:pass@proxy:8080`; `HTTP_PROXY`/`HTTPS_PROXY` are also honored.
- `agentToken` is issued by the hub on first registration and stored in `agent-state.json`.
- `insecureSkipVerify` is for testing only.

---

## MCP Gateway Registration

Register the hub as a **Streamable HTTP** MCP server in your gateway (MCPHub, etc.):

```json
{
  "ops-hub": {
    "type": "streamable-http",
    "url": "http://127.0.0.1:7100/mcp",
    "headers": {
      "Authorization": "Bearer <HUB_MCP_TOKEN>"
    },
    "protocolNegotiation": "legacy",
    "enableKeepAlive": true,
    "keepAliveInterval": 30000
  }
}
```

If the gateway runs in a container and cannot reach the host loopback, use the host's private IP or `http://172.17.0.1:7100/mcp`, or put both containers on the same Docker network.

MCP clients then connect to the gateway (for example `https://mcp.example.com/mcp?key=<gateway-api-key>`), not directly to the hub's `mcpToken`.

Optional per-user audit: declare an upstream credential slot so every gateway user binds their own hub token:

```json
"credentialTemplate": [
  { "target": "headers", "name": "Authorization", "label": "Ops Hub Token" }
]
```

---

## MCP Tools

| Tool | Purpose |
|---|---|
| `ops_list_clients` | List clients; filter by tag/status/query |
| `ops_client_info` | OS, CPU, memory, disks, network, users, uptime, agent version |
| `ops_client_stats` | Live CPU/memory/disk/load snapshot |
| `ops_exec` | Execute a command; waits 15s by default, returns `job_id` for long tasks |
| `ops_exec_output` | Read incremental output by byte offset |
| `ops_exec_cancel` | Terminate a job (process tree) |
| `ops_list_jobs` | List jobs |
| `ops_upload` | Upload a hub-local file to a client |
| `ops_download` | Download a client file to the hub |
| `ops_write_file` | Write text (UTF-8/GBK/GB18030/UTF-16LE) |
| `ops_read_file` | Page through a text file by byte offset |
| `ops_tail_file` | Tail a log with a reconnect-safe cursor |
| `ops_search_file` | Agent-side grep with context and regex |
| `ops_list_dir` | List a directory (glob/recursive) |
| `ops_stat_file` | Size/mtime/mode/SHA-256 |
| `ops_delete` | Delete a file or directory (`recursive=true` for dirs; protected system paths refused) |

Output is intentionally bounded: `ops_exec` returns at most 64KB by default and stores the full log under `data/jobs/`. Continue with `ops_exec_output` and `next_offset`.

Log/file content is treated as **untrusted data**. Tool descriptions warn the model not to execute instructions found in logs.

---

## Security Model

This project is C2-shaped by design: an agent that accepts commands and transfers files. Treat it as security-sensitive infrastructure.

Minimum production checklist:

- [ ] Written authorization for every managed machine
- [ ] TLS with a valid certificate; never `insecureSkipVerify` in production
- [ ] Per-agent tokens; revoke deleted clients
- [ ] `adminToken`, `mcpToken`, and `enrollmentToken` are different random values
- [ ] MCP endpoint and admin UI on a private network / VPN / SSO
- [ ] Only `/agent` exposed publicly
- [ ] Dangerous commands require explicit approval
- [ ] Audit logs enabled and retained
- [ ] `allowedRoots` restricted on the Agent
- [ ] Agent service runs with the least privilege that still works
- [ ] EDR/antivirus exclusion approved by the customer
- [ ] Data retention/cleanup for `data/jobs` and `data/downloads`

See [docs/security.md](docs/security.md) for the full checklist and incident response guidance.

---

## Deployment

Docker:

```bash
cp config.example.json config.local.json
docker compose -f deploy/docker-compose.yml up -d --build
curl http://127.0.0.1:7100/health
```

Reverse proxy:

- Use [deploy/nginx/ops.example.com.conf](deploy/nginx/ops.example.com.conf) as a starting point.
- Public: only `wss://ops.example.com/agent`.
- Private: `/mcp`, `/api`, and the admin UI.
- Increase `proxy_read_timeout` for long-lived WebSockets.
- Increase `client_max_body_size` if uploading large files through the UI.

See [docs/deploy.md](docs/deploy.md) for the mode index, or read
[docs/deploy-mcphub.md](docs/deploy-mcphub.md) (only MCPHub public) and
[docs/deploy-standalone.md](docs/deploy-standalone.md) (own domain).

---

## Project Layout

```text
ops-hub/
├── index.js                 # CLI: serve / clients / exec / doctor / token
├── config.example.json      # Hub config template
├── src/
│   ├── config/              # config load/validate
│   ├── hub/                 # WebSocket gateway, jobs, file transfer, HTTP/UI
│   ├── mcp/                 # MCP tool definitions
│   ├── protocol.js          # message types, job states, cursor
│   ├── store.js             # JSON state + JSONL audit
│   └── commands/            # CLI commands
├── public/                  # admin UI
├── agent/                   # Go agent (Windows/Linux)
├── scripts/                 # build/package/install
├── deploy/                  # Dockerfile, compose, nginx example
├── docs/                    # protocol, deploy, security, runbook
└── tests/                   # Node tests + fake agent e2e
```

---

## Testing

```bash
npm test
npm run check

cd agent
go test ./...
```

Covered:

- config merge and validation
- state persistence and audit
- cursor and dangerous-command detection
- hub + simulated agent end-to-end command execution
- MCP authentication and tool listing
- Agent encoding (UTF-8/GBK), file read/tail/search, path sandbox

---

## Limitations

- No GUI/desktop control, screenshots, or remote desktop. Use RDP/VNC/Sunflower/ToDesk.
- No interactive PTY. Commands that require password prompts or interactive input may hang.
- File transfer retries the whole transfer after a disconnect; command jobs support resume.
- Single hub instance is designed for hundreds to a few thousand clients. Larger deployments need sharding/Redis.
- Windows support is cross-compiled; test on your exact Windows Server version and antivirus before rollout.
- Windows Server 2008 R2 is end-of-life; prefer a supported OS.

---

## Sponsor / 赞赏码

如果这个项目对你有帮助，可以请作者喝杯咖啡。金额随意，不影响任何功能。

![赞赏码](assets/sponsor.png)

> 赞赏码仅用于自愿支持作者，不构成商业授权、服务承诺或技术支持合同。

## Author

**jijiawei**

- GitHub: [@a2237837517](https://github.com/a2237837517)
- Repository: [https://github.com/a2237837517/ops-hub](https://github.com/a2237837517/ops-hub)

## License

**Non-Commercial Source-Available License 1.0** — see [LICENSE](LICENSE).

You may use, copy, modify, and distribute this software for **non-commercial** purposes only. **Commercial use is prohibited** without prior written permission from the author. This is a source-available license, not an OSI-approved open-source license, because it restricts commercial use.
