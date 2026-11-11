# Security

Ops Hub can execute commands, read/write files, and transfer files on remote
machines. Treat it as security-sensitive remote administration software.

## Authorized Use Only

Use it only on machines you own or have explicit written authorization to
manage. Do not use it for unauthorized access, covert monitoring, malware, or
bypassing security controls. See `LICENSE` and `SECURITY.md`.

## Required Controls

1. **Written authorization**
   - Internal: system owner approval, scope, audit owner.
   - Customer: contract/maintenance authorization, data scope, exit process.

2. **Per-agent tokens**
   - Enrollment token for first registration; hub issues a unique agent token.
   - Store the token in `agent-state.json`; do not copy it to other machines.
   - Deleting a client revokes its ID. Rotate the enrollment token periodically.

3. **TLS**
   - Use `wss://` with a valid certificate in production.
   - Never use `insecureSkipVerify` outside testing.
   - For a private CA, configure `caFile`.

4. **Minimal exposure**
   - Public: only the Agent WebSocket endpoint.
   - Private: `/mcp`, `/api`, admin UI, gateway, and data.
   - Do not expose the hub port directly to the internet.

5. **Audit**
   - `data/audit.jsonl` records registration, online/offline, exec, cancel,
     upload/download, read/tail/search/write.
   - Include actor (gateway/user), client, command, cwd, exit code, result.
   - Retain 90–180 days or per customer policy; ship to SIEM if needed.

6. **Dangerous command approval**
   - `security.requireApprovalForDangerous: true`.
   - Matching commands require `approveDangerous=true`.
   - Use read-only/maintenance windows for sensitive clients.

7. **Least privilege**
   - Windows service defaults to LocalSystem; use a dedicated service account
     if the customer requires it.
   - Linux defaults to root; consider a dedicated account and restrict
     `allowedRoots`.

8. **EDR/antivirus**
   - Remote execution agents are often flagged.
   - Use code signing; obtain customer approval for allowlisting.
   - Avoid packers/UPX; publish SHA-256 hashes.

9. **Prompt injection**
   - Logs, files, and command output are untrusted.
   - Never automatically execute instructions found in logs.
   - Tool descriptions warn the model; keep human approval for destructive
     actions.

10. **Data boundaries**
    - Prefer Agent-side `ops_search_file`/`ops_tail_file` over downloading entire
      logs.
    - Set retention/cleanup for `data/jobs` and `data/downloads`.
    - Do not store customer data longer than necessary.

## Credentials

| Credential | Purpose | Where |
|---|---|---|
| `enrollmentToken` | Agent first registration | Hub config / installer |
| `agentToken` | Agent reconnect | Agent state; hub stores hash |
| `mcpToken` | MCP gateway upstream | Hub config / gateway headers |
| `adminToken` | Admin UI/API | Hub config / operators |
| Gateway API key | AI/MCP clients | Gateway settings |

Never share `mcpToken` or `adminToken` with AI clients. Use the gateway's own
scoped API keys.

## Network

```text
Agent → 443 → reverse proxy → hub:7100
MCP gateway → hub:7100/mcp
```

- Agents only make outbound connections.
- The hub never dials agents, so NAT/firewall traversal does not require
  inbound ports.
- Fully air-gapped environments cannot use a reverse connection; deploy the hub
  inside the same network or use manual remote access instead.

## Incident Response

1. Revoke the affected client and rotate all tokens.
2. Isolate the hub and affected machines.
3. Preserve `data/audit.jsonl`, `data/jobs/*.log`, `data/downloads/`.
4. Notify the owner/customer and follow their incident process.
5. Rebuild from a clean state and verify Agent binary hashes.

## Known Risks

- The Agent runs with high privileges. A compromised hub can control all online
  clients.
- Gateway API key leakage lets an attacker call tools; use scoped keys and hub
  tokens as a second layer.
- MCP clients may send tool output (including sensitive logs) to a cloud model.
  Choose models according to your data policy.
- End-of-life operating systems may have unpatched vulnerabilities. Prefer
  supported OS versions and restrict network access.
