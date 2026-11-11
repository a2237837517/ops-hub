# Deployment: standalone mode

Use this mode when Ops Hub is deployed independently with its own domain or
public IP, and you do not want to put it behind MCPHub.

## Topology

```text
Agent ── wss://ops.example.com/agent ──┐
                                        ├─ edge nginx (ops.example.com)
Download/UI ── https://ops.example.com/ ┘
                                        │
                                        └─ Ops Hub 127.0.0.1:7100
                                             ├─ / (admin UI)
                                             ├─ /api
                                             ├─ /mcp
                                             ├─ /agent
                                             └─ /downloads
```

## 1. Configure the Hub

```bash
sudo mkdir -p /opt/ops-hub
cd /opt/ops-hub
cp config.example.json config.local.json
```

```json
{
  "hub": {
    "host": "0.0.0.0",
    "port": 7100,
    "publicUrl": "wss://ops.example.com/agent",
    "dataDir": "./data"
  },
  "auth": {
    "enrollmentToken": "<random-enrollment-token>",
    "mcpToken": "<random-mcp-token>",
    "adminToken": "<random-admin-token>"
  },
  "security": {
    "allowedUploadRoots": ["./data/staging"],
    "requireApprovalForDangerous": true
  }
}
```

Generate tokens:

```bash
openssl rand -base64 32
# or
node index.js token
```

## 2. Start

Docker:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://127.0.0.1:7100/health
```

Bare Node:

```bash
npm install --omit=dev
node index.js serve
```

Use a process manager/systemd in production.

## 3. Reverse proxy

Use [../deploy/nginx/ops.example.com.conf](../deploy/nginx/ops.example.com.conf).

It exposes the admin UI, `/api`, `/mcp`, `/agent`, and `/downloads` on the
standalone domain. Protect the UI with SSO/basic auth/VPN if the domain is
public.

Verify:

```bash
curl -I https://ops.example.com/health
curl -I https://ops.example.com/downloads/
```

## 4. MCP clients

Direct MCP endpoint:

```text
https://ops.example.com/mcp
Authorization: Bearer <mcpToken>
```

If you also use an MCP gateway, register:

```json
{
  "ops-hub": {
    "type": "streamable-http",
    "url": "http://127.0.0.1:7100/mcp",
    "headers": { "Authorization": "Bearer <mcpToken>" },
    "protocolNegotiation": "legacy",
    "enableKeepAlive": true
  }
}
```

## 5. Agent config

```json
{
  "server": "wss://ops.example.com/agent",
  "enrollmentToken": "<from config.local.json>",
  "name": "customerA-app01",
  "tags": ["customer:A", "prod"],
  "allowedRoots": ["C:\\", "D:\\"],
  "maxSpoolMB": 2048,
  "maxConcurrentJobs": 4,
  "heartbeatIntervalSec": 15
}
```

Install with `install.bat` (Windows) or `install-linux.sh` (Linux).

## 6. Download page

```text
https://ops.example.com/downloads/
```

Build the packages first:

```bash
./scripts/package-agent.sh
```

The script writes `dist/packages/` and copies installers to
`public/downloads/`, which is served at `/downloads/`.

## Security

- Expose only what you need. If the UI does not need to be public, restrict
  `/`, `/api`, and `/mcp` by IP/VPN/SSO.
- `/downloads/` is static and contains no enrollment token.
- Keep `config.local.json` and `data/` out of git.
- Use valid TLS and never disable certificate verification in production.
