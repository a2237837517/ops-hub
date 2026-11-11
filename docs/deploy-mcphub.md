# Deployment: MCPHub mode (single public entry)

Use this mode when only **MCPHub** is exposed to the internet, for example
`https://mcp.example.com`. The Ops Hub host itself has **no public IP/port**.

## Topology

```text
Agent  ── wss://mcp.example.com/agent ──┐
                                        ├─ edge nginx / MCPHub host
Download page ── /downloads/ ───────────┘
                                        │
                                        ├─ MCPHub (public)
                                        │    └─ http://10.0.0.20:7100/mcp
                                        │
                                        └─ Ops Hub (private host, 10.0.0.20:7100)
                                             ├─ /agent WebSocket
                                             ├─ /downloads static files
                                             └─ /api + UI (private only)
```

Only three public paths are exposed:

| Path | Goes to | Purpose |
|---|---|---|
| `/agent` | Ops Hub | Agent WebSocket |
| `/downloads/` | Ops Hub | Agent packages + static download page |
| `/mcp` | MCPHub | MCP clients / AI |
| `/ops/` | Ops Hub | Admin UI (login required) |

The Ops Hub admin UI is available at `https://mcp.example.com/ops/` (login with `adminToken`). Its `/api` is reachable only through the `/ops/` prefix; the raw `/api` and `/mcp` paths are not exposed.

## 1. Deploy the Hub on a private host

Example host: `10.0.0.20` (bind only the private interface).

```bash
# on the private host
mkdir -p /opt/ops-hub/data
cp config.example.json /opt/ops-hub/config.local.json
```

Set:

```json
{
  "hub": {
    "host": "0.0.0.0",
    "port": 7100,
    "publicUrl": "wss://mcp.example.com/agent",
    "dataDir": "./data"
  },
  "auth": {
    "enrollmentToken": "<random>",
    "mcpToken": "<random>",
    "adminToken": "<random>"
  }
}
```

Run the container, binding the private IP only:

```bash
docker run -d --name ops-hub --restart unless-stopped \
  -p 10.0.0.20:7100:7100 \
  -v /opt/ops-hub/data:/app/data \
  -v /opt/ops-hub/config.local.json:/app/config.local.json:ro \
  --memory 512m \
  ops-hub:0.1.5
```

Do **not** add a public port mapping or public security-group rule for 7100.

## 2. Register in MCPHub

MCPHub needs to reach the private IP. Add the upstream in the dashboard/API:

```json
{
  "ops-hub": {
    "type": "streamable-http",
    "url": "http://10.0.0.20:7100/mcp",
    "headers": {
      "Authorization": "Bearer <HUB_MCP_TOKEN>"
    },
    "protocolNegotiation": "legacy",
    "enableKeepAlive": true,
    "keepAliveInterval": 30000
  }
}
```

MCPHub blocks private upstream IPs by default (SSRF protection). Allow only the
Hub host:

```json
{
  "systemConfig": {
    "network": {
      "allowedCidrs": ["10.0.0.20/32"]
    }
  }
}
```

If MCPHub refuses to connect, check its logs for `UnsafeUrlError: Blocked target IP`.

## 3. Add public paths to the MCPHub nginx site

On the edge nginx for `mcp.example.com`, include these snippets **before** the
existing `location /`:

- [../deploy/nginx/mcp-agent-location.conf](../deploy/nginx/mcp-agent-location.conf)
- [../deploy/nginx/mcp-downloads-location.conf](../deploy/nginx/mcp-downloads-location.conf)
- [../deploy/nginx/mcp-ops-ui-location.conf](../deploy/nginx/mcp-ops-ui-location.conf)

Or copy the blocks from those files. The result:

```nginx
location /agent { proxy_pass http://10.0.0.20:7100; ... }
location = /downloads { return 301 /downloads/; }
location /downloads/ { proxy_pass http://10.0.0.20:7100/downloads/; ... }

# MCPHub itself stays at /
location / { proxy_pass http://<MCPHub>:7098; ... }
```

Do not proxy `/api` or the Ops Hub UI through this site.

Reload nginx only after `nginx -t`.

## 4. Download page

Public page:

```text
https://mcp.example.com/downloads/
```

Direct links:

```text
https://mcp.example.com/downloads/ops-agent-windows-amd64.zip
https://mcp.example.com/downloads/ops-agent-windows-386.zip
https://mcp.example.com/downloads/ops-agent-linux-amd64.tar.gz
https://mcp.example.com/downloads/ops-agent-linux-arm64.tar.gz
https://mcp.example.com/downloads/ops-agent-linux-386.tar.gz
https://mcp.example.com/downloads/config.example.json
```

The static page/files are intentionally public. The generated config endpoint
(`/api/agent-config`) is **not** public and requires the admin token.

### One-click preconfigured package via MCP

In the MCPHub dashboard, open the `ops-hub` server and call:

```json
{
  "name": "ops_agent_package",
  "arguments": {}
}
```

With no arguments it generates all supported Windows/Linux architectures using the same
`enrollmentToken`, and returns a 24-hour private URL for each package. To limit it:

```json
{"os":"windows","arch":"amd64","name":"customerA-app01"}
```

The tool returns URLs such as:

```text
https://mcp.example.com/downloads/private/<random>/ops-agent-windows-amd64-configured.zip
```

The ZIP/TAR already contains `config.json` with `server` and
`enrollmentToken`; download and install directly. Treat the URL as a secret:
anyone with it can download a package containing the enrollment token.


## 5. Agent config

```json
{
  "server": "wss://mcp.example.com/agent",
  "enrollmentToken": "<from the private Hub config>",
  "name": "customerA-app01",
  "tags": ["customer:A", "prod"],
  "allowedRoots": ["C:\\", "D:\\"],
  "maxSpoolMB": 2048,
  "maxConcurrentJobs": 4,
  "heartbeatIntervalSec": 15
}
```

Windows: run `install.bat` as Administrator.  
Linux: `sudo ./install-linux.sh`.

The Agent only makes an outbound `wss://` connection to `mcp.example.com:443`.
No inbound port or public IP is needed on the managed machine.

## 6. Verify

```bash
# Hub health from a private host
curl http://10.0.0.20:7100/health

# Admin UI (login required)
curl -I https://mcp.example.com/ops/

# Public download page
curl -I https://mcp.example.com/downloads/

# Public agent path should reject plain HTTP (WebSocket upgrade required)
curl -I https://mcp.example.com/agent

# MCPHub logs should show:
#   Initialized client for server: ops-hub
#   Successfully listed 16 tools for server: ops-hub
```

## Security notes

- The Ops Hub admin UI is only reachable from the private network/VPN.
- `/downloads/` contains binaries and a config template; it contains **no
  enrollment token**.
- The enrollment token and `mcpToken` stay in `/opt/ops-hub/config.local.json`.
- Only allow the Hub host in `systemConfig.network.allowedCidrs` — do not allow
  whole private ranges.
- Keep `/mcp` behind MCPHub authentication.
