# Deployment Guide

Ops Hub has two deployment modes. Pick the one that matches your network:

## 1. MCPHub mode (recommended when only MCPHub is public)

```text
Agent → wss://mcp.example.com/agent
Download page → https://mcp.example.com/downloads/
MCPHub → http://<private-hub>:7100/mcp
```

- Ops Hub has **no public IP/port**.
- Only MCPHub's domain exposes `/agent` and `/downloads/`.
- The admin UI, `/api`, and `/mcp` stay private.

Read: [deploy-mcphub.md](deploy-mcphub.md)

## 2. Standalone mode

```text
Agent → wss://ops.example.com/agent
UI/MCP/downloads → https://ops.example.com/
```

- Ops Hub has its own domain/reverse proxy.
- Useful for direct MCP clients or when you do not use MCPHub.

Read: [deploy-standalone.md](deploy-standalone.md)

## Which one?

| Requirement | MCPHub mode | Standalone |
|---|---|---|
| Only MCPHub is public | ✅ | ⚠️ needs its own public entry |
| Ops Hub no public IP | ✅ | ❌ (unless VPN-only) |
| Download page on MCPHub domain | ✅ `/downloads/` | ❌ own domain |
| Direct MCP client access | via MCPHub | ✅ |
| Remote Agents behind NAT | ✅ `/agent` | ✅ `/agent` |

For a fully private deployment with no public entry at all, use MCPHub mode but
replace `/agent` with an internal/VPN endpoint; remote NAT Agents then need a
relay or VPN.
