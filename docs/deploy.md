# Deployment Guide

This is a generic deployment guide. Replace example domains, IPs, and tokens
with your own values.

## Topology

```text
Agent  →  wss://ops.example.com/agent
       →  edge nginx / reverse proxy
       →  hub 127.0.0.1:7100

MCP gateway  →  http://127.0.0.1:7100/mcp
```

- The Agent only makes outbound connections. Do not open inbound ports on
  managed machines.
- Expose only `/agent` publicly. Keep `/mcp`, `/api`, and the admin UI private
  (VPN, private network, SSO, or basic auth).
- The MCP gateway and the hub can run on the same host or on a private network.

## 1. Hub Configuration

```bash
sudo mkdir -p /opt/ops-hub
cd /opt/ops-hub
cp config.example.json config.local.json
```

Edit `config.local.json`:

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

Generate tokens with:

```bash
openssl rand -base64 32
# or
node index.js token
```

Do not commit `config.local.json` or `data/`.

## 2. Start the Hub

### Docker

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker logs -f ops-hub
curl -s http://127.0.0.1:7100/health
```

Production port binding:

- Bind to a private interface that the reverse proxy and MCP gateway can reach.
- Do not expose `7100` directly to the public internet.
- Set a 512MB–1GB memory limit and a disk quota for `data/`.

### Bare Node.js

```bash
npm install --omit=dev
node index.js serve
```

Use systemd or your process manager to keep it running.

## 3. Reverse Proxy

Use [../deploy/nginx/ops.example.com.conf](../deploy/nginx/ops.example.com.conf)
as a starting point.

Required proxy settings for the Agent WebSocket:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

Use a valid TLS certificate. The Agent must connect with `wss://`.

Verify:

```bash
curl -I https://ops.example.com/health
```

## 4. Register with Your MCP Gateway

Add a Streamable HTTP upstream:

```json
{
  "ops-hub": {
    "type": "streamable-http",
    "url": "http://127.0.0.1:7100/mcp",
    "headers": {
      "Authorization": "Bearer <mcpToken>"
    },
    "protocolNegotiation": "legacy",
    "enableKeepAlive": true,
    "keepAliveInterval": 30000
  }
}
```

Notes:

- If the gateway runs in a container, use a private host IP or a shared Docker
  network; `127.0.0.1` inside the container refers to the container itself.
- Use a separate bearer key/API key for MCP clients. Do not give them the hub's
  `mcpToken`.
- Optional: configure a per-user credential slot in the gateway so each user
  binds their own hub token for audit.

After registration, the gateway should discover 15 `ops_*` tools.

## 5. Install Agents

### Windows

1. Copy the zip to the target machine using your approved remote-access method.
2. Extract and copy `config.example.json` to `config.json`.
3. Set `server`, `enrollmentToken`, `name`, `tags`, and `allowedRoots`.
4. Run `install.bat` as Administrator.

### Linux

```bash
tar -xzf ops-agent-linux-amd64.tar.gz
cd ops-agent-linux-amd64
cp config.example.json config.json
vi config.json
sudo ./install-linux.sh
```

### Verify

```bash
curl -H "Authorization: Bearer <adminToken>" \
  http://127.0.0.1:7100/api/clients
```

The client should be `online`. Then call `ops_list_clients` from the MCP client.

## 6. Network Requirements

- Managed machine: outbound TCP 443 to the Agent endpoint only.
- Reverse proxy: inbound 443; proxy `/agent` to the hub.
- Hub: inbound 7100 from the reverse proxy and MCP gateway only.
- If the customer uses an HTTP proxy, set `proxy` in the Agent config.
- If the customer uses a domain allowlist, allow the Agent endpoint.

## 7. Upgrade and Rollback

Hub:

```bash
# back up data/ first
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://127.0.0.1:7100/health
```

Agent:

- Windows: replace the exe, then restart the `OpsHubAgent` service.
- Linux: replace `/opt/ops-hub-agent/ops-agent`, then
  `systemctl restart ops-hub-agent`.
- Keep `agent-state.json` to preserve the client identity and token.

## 8. Monitoring

- `GET /health` returns online/total client counts.
- Alert if a client's `lastSeen` is older than expected.
- Monitor `data/` disk usage and job/download growth.
- Ship `data/audit.jsonl` to your SIEM if required.
- Keep the MCP gateway's keepalive enabled so hub downtime is visible.
