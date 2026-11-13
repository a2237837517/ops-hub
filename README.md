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
- Chunked file upload/download with SHA-256 and atomic writes; browser uploads above 8MB are split into 8MB parts with retry and resume
- MCP server over **Streamable HTTP** (and legacy-compatible JSON-RPC behavior)
- 25 MCP tools covering inventory, command execution, files, logs, search, tunnels, SOCKS5, and upgrades
- Web admin UI: clients, terminal, files, jobs, audit
- Client list grouped by customer name (`config.json` → `name`), with per-machine status inside each group
- Rename clients (Hub display name) and view OS/IP/CPU/memory/disk info
- File browser with parent-directory navigation, left-side upload/download, drag-and-drop upload, and download-only handling for archives/binaries (`.gz`, `.zip`, images, etc.)
- Delete files or directories from the UI (with confirmation); protected system roots are refused by the Agent
- MCP tool `ops_agent_package` generates a ready-to-install Windows/Linux package with the enrollment token embedded and returns a time-limited private URL
- JSON state persistence + JSONL audit log
- Dangerous-command approval policy
- Client revocation list with a **封禁管理** UI to unban client IDs
- Local TCP port forwarding (`ops-agent tunnel`) over the existing `/agent` WebSocket path; MySQL/HTTP/RDP become `127.0.0.1:<port>`
- Remote Agent upgrade from the Hub UI or `ops_agent_upgrade` (SHA-256 verified, automatic service restart)
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

If `install.bat` reports `A system shutdown is in progress`, the Windows Service
Control Manager is refusing to create a service during shutdown/restart. Reboot
and retry, or run `run.bat` for foreground mode (no service; keep the window
open).

The Agent installs as the `OpsHubAgent` Windows service and writes logs to:

```text
C:\ProgramData\OpsHubAgent\logs\agent.log
```

State (client ID + token):

```text
C:\ProgramData\OpsHubAgent\agent-state.json
```

Do not delete `agent-state.json` unless you intend to re-enroll the client.

`clientId` is generated per machine (`hostname + hash(MachineGuid|hostname)`) and
persisted in this file. If the file is copied to another machine (disk clone,
VM template, manual copy), both machines would present the same `clientId` and
the Hub would keep replacing one connection with the other.

New Agents store a machine key in the state file and detect this automatically.
They also recover from a lost state file: the Hub reissues an `agentToken` when
the same machine presents the enrollment token and a matching fingerprint.

For a full clone that keeps the same `MachineGuid` and SMBIOS UUID, reset the
identity manually (this also generates a random suffix, so the clone no longer
collides):

```text
sc stop OpsHubAgent
ops-agent.exe reset-id --config "C:\path\to\config.json"
sc start OpsHubAgent
```

The Hub rejects a `clientId` reconnecting from a different machine
(`machine fingerprint mismatch`) and writes an `agent.id.conflict` audit record
instead of silently kicking the live session.

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
  "maxTransferKBps": 0,
  "insecureSkipVerify": false,
  "caFile": "",
  "proxy": "",
  "heartbeatIntervalSec": 15
}
```

- `allowedRoots` restricts file APIs. Empty means “allow all” — set it in production.
- `maxTransferKBps` limits file transfer speed (0 = unlimited); use e.g. `4096` on busy desktops.
- File transfers are chunked at 256KB with per-chunk ACKs; the Agent log set is capped at 100MB and Windows service recovery restarts a crashed Agent.
- `proxy` supports `http://user:pass@proxy:8080`; `HTTP_PROXY`/`HTTPS_PROXY` are also honored.
- `agentToken` is issued by the hub on first registration and stored in `agent-state.json`.
- `insecureSkipVerify` is for testing only.

---

## Port Forwarding

The Agent already has an outbound WebSocket under `/agent`. The tunnel reuses
that nginx location, so **no nginx change, no new port, no new certificate**:

```text
wss://<hub>/agent/tunnel
```

Run the same `ops-agent` binary on your own computer:

Enable it in `config.local.json` first (disabled by default):

```json
{
  "tunnel": {
    "enabled": true,
    "token": "<random tunnel token>",
    "allowedCidrs": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "allowedPorts": [],
    "maxStreamsPerTunnel": 16,
    "idleTimeoutSec": 1800
  }
}
```

Then run the same `ops-agent` binary on your own computer:

```bash
ops-agent.exe tunnel \
  --server wss://mcp.example.com/agent/tunnel \
  --token <tunnelToken> \
  --client <clientId> \
  --forward 13306=127.0.0.1:3306 \
  --forward 18080=192.168.1.30:80
```

Then connect locally:

```text
Navicat   -> 127.0.0.1:13306
Browser   -> http://127.0.0.1:18080
mstsc     -> 127.0.0.1:13389
```

The target is dialed by the Agent, so it can be `127.0.0.1` (the Agent machine)
or any TCP address the Agent can reach. Targets are restricted to private
CIDRs by default (`tunnel.allowedCidrs`); public targets require an explicit
allowlist. UDP is not supported.

The admin UI has a **端口转发** dialog that generates the command and lists
active tunnels. MCP tools: `ops_tunnel_command`, `ops_tunnel_list`,
`ops_tunnel_close`.

---

## SOCKS5 Proxy (server-side)

The Hub can expose a SOCKS5 endpoint that routes through any online Agent. The
managed machines do **nothing**; they already hold the outbound WebSocket.

Enable it in the admin UI (**SOCKS5**) or with `ops_socks_enable`. The Hub
returns:

```text
host:     118.31.73.50
port:     1080
username: <clientId>
password: <socks5 token>
```

Clash / browser:

```yaml
proxies:
  - name: ops-185
    type: socks5
    server: 118.31.73.50
    port: 1080
    username: DESKTOP-FCUE0HS-336ac8d717
    password: "<token>"
    udp: false
```

- Username selects the target Agent (`clientId` or registered name)
- Password is `socks5.token`, separate from the tunnel token
- Targets are restricted by `tunnel.allowedCidrs` / `tunnel.allowedPorts`
- TCP only (`udp: false`); idle timeout and per-client stream limits apply
- The listener is configured by `socks5.host/port`; publish the port and open it
  in the cloud security group (ideally only to your egress IP)
- Plain SOCKS5 has no TLS; use it over VPN/SSH, or keep the source IP allowlist tight
- Settings are persisted to `data/settings.json` and survive Hub restarts

MCP tools: `ops_socks_enable`, `ops_socks_disable`, `ops_socks_status`.

### Local SOCKS5 (no new port)

If you do not want to open a public port, run the tunnel client on the machine
that needs the proxy. It reuses the existing 443 WebSocket:

```bash
ops-agent.exe tunnel \
  --server wss://mcp.example.com/agent/tunnel \
  --token <tunnelToken> \
  --client <clientId> \
  --socks5 1080
```

Clash:

```yaml
proxies:
  - name: ops-local
    type: socks5
    server: 127.0.0.1
    port: 1080
    udp: false
```

- No security-group change, no new public port, TLS end to end
- One local port per `--client`; run 1080/1081/... for multiple Agents
- Or add `--socks5-user-select`: the SOCKS5 username selects the target
  `clientId`, so **one local listener reaches every Agent**. The password is the
  tunnel token by default, or `--socks5-pass <password>`
- Optional local auth: `--socks5-user ops --socks5-pass <password>`
- Targets are still restricted by `tunnel.allowedCidrs` / `tunnel.allowedPorts`

---

## Remote Upgrade

The Hub serves raw Agent binaries and `manifest.json` under `/downloads/`.
Click **升级** in the client header (or call `ops_agent_upgrade`) and the Agent:

1. downloads the binary from the Hub's own host (URL host is validated)
2. verifies its SHA-256 against the manifest
3. writes `<exe>.new` and starts a detached updater
4. the updater stops the service, replaces the binary (keeps `.bak`), and starts it again

The Agent reconnects with the new `version`, which is shown in the client meta
line. Upgrade requires the Agent to be online and on **0.1.17 or newer** (older
builds do not understand `agent.upgrade`; the Hub returns a clear error and you
install once manually). A failed download or checksum leaves the running version
untouched.

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

In MCPHub mode the admin UI can be mounted at `https://mcp.example.com/ops/` using [deploy/nginx/mcp-ops-ui-location.conf](deploy/nginx/mcp-ops-ui-location.conf); it still requires `adminToken` to log in.

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
| `ops_agent_package` | Build preconfigured Agent installers with `config.json` embedded; defaults to all Windows/Linux architectures and returns 24h private URLs |
| `ops_access_info` | Return admin URL, token-login URL, admin/enrollment tokens, download page and endpoints |

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

## Resource behavior

- Agent logs: 10MB per file, 9 rotated backups, **100MB total**.
- Hub logs: same 10MB × 9 rotation (**100MB total**); Docker logs are separately capped at 50MB × 3.
- Job output is separate from logs: capped by `maxOutputBytesPerJob` (default 50MB) and pruned by age/count.
- File transfer is chunked at 256KB with a per-chunk ACK; the whole file is never loaded into memory.
- `maxTransferKBps` (Hub and Agent) can cap transfer bandwidth; `0` means unlimited. Set e.g. `4096` on busy desktops.
- Windows installs configure SCM recovery (`sc failure ... restart`); Linux systemd uses `Restart=always`. A crashed Agent is restarted, but a running transfer is not automatically throttled or cancelled.
- Large files can still saturate the client's disk/network; use the bandwidth cap or schedule transfers off-hours.

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
