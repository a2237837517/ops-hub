# Runbook

## Start / Stop

```bash
cd /opt/ops-hub
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml stop
docker logs -f ops-hub
```

Local development:

```bash
cd ops-hub
node index.js serve
```

## Health Checks

```bash
curl -s http://127.0.0.1:7100/health
curl -s -H "Authorization: Bearer <adminToken>" \
  http://127.0.0.1:7100/api/clients
```

## Client Offline

1. Check hub log: `data/logs/hub.log` for `agent offline`.
2. Check Agent log:
   - Windows `C:\ProgramData\OpsHubAgent\logs\agent.log`
   - Linux `/opt/ops-hub-agent/logs/agent.log`
3. Verify outbound 443 to the Agent endpoint:
   `curl -I https://ops.example.com/health`.
4. Check the service:
   - Windows `sc query OpsHubAgent`
   - Linux `systemctl status ops-hub-agent`
5. Check `agent-state.json`; if deleted, re-enroll or reset the client.

## Job Stays Running

- Poll `ops_exec_output` with the current offset.
- Cancel with `ops_exec_cancel`.
- Check Agent spool growth in `spoolDir/jobs`.
- Check hub output growth in `data/jobs/<jobId>.log`.
- A disconnected job becomes `disconnected`; it resumes when the Agent
  reconnects.

## File Transfer Fails

- Confirm the path is inside the Agent's `allowedRoots`.
- On Windows, check whether the file is locked.
- Check disk space on both sides.
- Remove stale `.part-*` files in `data/downloads` / `data/staging` after a
  failed transfer.

## Disk Full

- Hub prunes old jobs every 6 hours (30 days / 500 jobs by default).
- `data/downloads` is not automatically pruned; delete by policy.
- Agent spool is limited by `maxSpoolMB`; oldest files are removed at startup
  when over quota.

## Token Rotation

1. Generate new tokens.
2. Update hub `config.local.json` and restart the hub.
3. Update the MCP gateway's upstream header.
4. Agent tokens are managed by the hub. To force re-enrollment, delete the
   client and remove the Agent's `agent-state.json`.

## Client Revocation

Deleting a client from the UI/API adds its ID to the revoked list and closes its
connection. To allow the same client ID again, call:

```bash
curl -X POST -H "Authorization: Bearer <adminToken>" \
  http://127.0.0.1:7100/api/clients/<clientId>/unrevoke
```

For a permanent block, rotate `enrollmentToken`.
