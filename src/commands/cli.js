import { loadConfig } from '../config/index.js';

function baseUrl(config) {
  const host = config.hub.host === '0.0.0.0' || config.hub.host === '::' ? '127.0.0.1' : config.hub.host;
  return `http://${host}:${config.hub.port}`;
}

async function api(config, path, options = {}) {
  const response = await fetch(`${baseUrl(config)}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.auth.adminToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
}

export async function clientsCommand(args) {
  const config = loadConfig(args.config);
  const data = await api(config, '/api/clients');
  if (!data.clients.length) {
    console.log('没有已注册客户端');
    return;
  }
  const rows = data.clients.map((client) => ({
    ID: client.id,
    NAME: client.name || '',
    HOST: client.hostname || '',
    OS: client.os || '',
    ARCH: client.arch || '',
    STATUS: client.status === 'online' ? 'online' : 'offline',
    LAST_SEEN: client.lastSeen || '',
  }));
  console.table(rows);
}

export async function execCommand(args) {
  const config = loadConfig(args.config);
  const [clientId, ...commandParts] = args._;
  if (!clientId || !commandParts.length) {
    throw new Error('用法: node index.js exec <clientId|name> <command...> [--shell cmd] [--cwd path] [--yes]');
  }
  const created = await api(config, `/api/clients/${encodeURIComponent(clientId)}/exec`, {
    method: 'POST',
    body: JSON.stringify({
      command: commandParts.join(' '),
      shell: args.shell,
      cwd: args.cwd,
      timeoutMs: args.timeout ? Number(args.timeout) : undefined,
      approveDangerous: Boolean(args.yes),
    }),
  });
  const job = created.job;
  console.log(`job ${job.id} started on ${job.clientName}`);
  let offset = 0;
  let lastStatus = job.status;
  for (;;) {
    const out = await api(
      config,
      `/api/jobs/${encodeURIComponent(job.id)}/output?offset=${offset}&maxBytes=65536`,
    );
    if (out.text) process.stdout.write(out.text);
    offset = out.nextOffset;
    lastStatus = out.job.status;
    if (['exited', 'failed', 'cancelled', 'interrupted', 'lost'].includes(lastStatus)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`\n[job ${job.id}] status=${lastStatus} exitCode=${out.job.exitCode}`);
  if (lastStatus === 'failed' && out.job.error) console.error(out.job.error);
}

export async function doctorCommand(args) {
  const config = loadConfig(args.config);
  console.log(`config: ${config.__file}`);
  console.log(`dataDir: ${config.hub.dataDir}`);
  console.log(`listen: ${config.hub.host}:${config.hub.port}`);
  console.log(`publicUrl: ${config.hub.publicUrl}`);
  console.log(`MCP token: ${config.auth.mcpToken.startsWith('change-me') ? 'DEFAULT (请修改)' : 'set'}`);
  console.log(`admin token: ${config.auth.adminToken.startsWith('change-me') ? 'DEFAULT (请修改)' : 'set'}`);
  console.log(`enrollment token: ${config.auth.enrollmentToken.startsWith('change-me') ? 'DEFAULT (请修改)' : 'set'}`);
  try {
    const response = await fetch(`http://127.0.0.1:${config.hub.port}/health`);
    console.log(`hub health: ${response.ok ? 'ok' : `HTTP ${response.status}`}`);
  } catch (error) {
    console.log(`hub health: 不可达 (${error.message})`);
  }
  console.log('提示：Agent 包用 scripts/build-agent.sh 构建，MCPHub 注册地址为 http://<hub>:<port>/mcp');
}
