# Security Policy

## Authorized Use Only

Ops Hub provides remote command execution and file transfer. It must only be
used on machines you own or have explicit written authorization to manage.

Do not use this project for unauthorized access, covert monitoring, malware,
bypassing security controls, or any illegal activity. See `LICENSE` for the full
terms and `README.md` for the authorized-use policy.

## Deployment Security Checklist

- Use TLS (`wss://`) with a valid certificate. Never disable certificate
  verification in production.
- Use different random values for `enrollmentToken`, `mcpToken`, and
  `adminToken`.
- Expose only the Agent WebSocket path publicly. Keep `/mcp`, `/api`, and the
  admin UI on a private network, VPN, or behind SSO.
- Restrict Agent `allowedRoots`.
- Run the Agent with the least privilege that still works.
- Require approval for dangerous commands.
- Enable and retain audit logs.
- Revoke clients that are retired or lost.
- Review downloaded files and logs for sensitive data before sharing.
- Keep Node.js, Go, nginx, and the operating system patched.

## Reporting a Vulnerability

Please do not open a public issue with exploit details or customer data.

Use GitHub's private vulnerability reporting if available, or contact the
author through the GitHub profile:

https://github.com/a2237837517

Include:

- affected version/commit
- deployment shape (hub version, agent OS)
- reproduction steps or proof of concept
- impact assessment
- any suggested fix

## Incident Response

If you suspect the hub or an Agent is compromised:

1. Revoke the affected client and rotate all tokens.
2. Isolate the hub and affected machines from the network.
3. Preserve `data/audit.jsonl`, `data/jobs/*.log`, and `data/downloads/` as evidence.
4. Notify the system owner/customer and follow their incident process.
5. Rebuild from a clean state and audit the Agent binary hash.
