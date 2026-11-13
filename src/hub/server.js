import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { AgentGateway } from './agent-gateway.js';
import { JobManager } from './job-manager.js';
import { FileManager } from './file-manager.js';
import { TunnelGateway } from './tunnel-gateway.js';
import { loadManifest, requestUpgrade } from './upgrade.js';
import { Store } from '../store.js';
import { createMcpRouter } from '../mcp/server.js';
import { cleanupAgentPackages, privatePackageFile } from './agent-package.js';
import { PROJECT_ROOT } from '../config/index.js';
import { Logger, randomId, nowIso, clamp } from '../utils.js';

export async function startHub(config) {
  const logger = new Logger({
    level: config.hub.logLevel,
    file: path.join(config.hub.dataDir, 'logs', 'hub.log'),
  });
  const store = new Store(config.hub.dataDir, logger);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  const jsonParser = express.json({ limit: '8mb' });
  app.use((req, res, next) => {
    // 文件上传走原始流，不能先被 JSON parser 消费（.json 文件会被浏览器标成 application/json）
    if (req.method === 'POST' && /\/files\/upload\/?$/.test(req.path)) return next();
    return jsonParser(req, res, next);
  });

  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const gateway = new AgentGateway({ httpServer: server, config, store, logger });
  const jobs = new JobManager({ gateway, store, config, logger });
  const files = new FileManager({ gateway, store, config, logger });
  const tunnels = new TunnelGateway({ httpServer: server, config, store, logger, agentGateway: gateway });

  const adminAuth = (req, res, next) => {
    const header = String(req.get('authorization') || '');
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const token = bearer || String(req.query.token || '');
    if (!token || token !== config.auth.adminToken) {
      res.status(401).json({ success: false, message: 'invalid admin token' });
      return;
    }
    next();
  };

  const downloadsDir = path.join(PROJECT_ROOT, 'public', 'downloads');

  const extractPrimaryIp = (agent) => {
    const interfaces = agent?.info?.network;
    if (Array.isArray(interfaces)) {
      for (const iface of interfaces) {
        for (const addr of iface.addrs || []) {
          const value = String(addr).split('/')[0];
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) && !value.startsWith('127.')) {
            return value;
          }
        }
      }
    }
    return String(agent?.remoteAddress || '').replace(/^::ffff:/, '');
  };

  const withDisplay = (agent, includeInfo = true) => {
    const { info, tokenHash, ...rest } = agent;
    return {
      ...rest,
      ...(includeInfo ? { info: info || {} } : {}),
      name: agent.displayName || agent.name,
      displayName: agent.displayName || '',
      // 客户名：安装包 config.json 里的 name，重命名后仍然保留，用于分组。
      group: agent.name || agent.hostname || agent.id,
      primaryIp: extractPrimaryIp(agent),
    };
  };

  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'ops-hub',
      version: '0.1.0',
      onlineClients: gateway.listOnline().length,
      totalClients: store.listAgents().length,
      time: nowIso(),
    });
  });

  app.use('/api', adminAuth);

  app.get('/api/auth/check', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      hub: {
        host: config.hub.host,
        port: config.hub.port,
        publicUrl: config.hub.publicUrl,
        dataDir: config.hub.dataDir,
      },
      limits: config.limits,
      tunnel: {
        enabled: Boolean(config.tunnel?.enabled),
        allowedCidrs: config.tunnel?.allowedCidrs || [],
        allowedPorts: config.tunnel?.allowedPorts || [],
      },
      security: {
        allowedUploadRoots: config.security.allowedUploadRoots,
        requireApprovalForDangerous: config.security.requireApprovalForDangerous,
      },
    });
  });

  app.get('/api/agent-versions', (_req, res) => {
    const manifest = loadManifest();
    if (!manifest) {
      return res.status(404).json({ success: false, message: 'agent manifest not found' });
    }
    res.json({ success: true, ...manifest });
  });

  app.post('/api/clients/:id/upgrade', (req, res) => {
    const result = requestUpgrade({
      config,
      store,
      gateway,
      clientId: req.params.id,
      logger,
    });
    if (result.error) {
      const status = result.error === 'client not found' ? 404 : result.error === 'client is offline' ? 409 : 400;
      return res.status(status).json({ success: false, message: result.error });
    }
    res.json({ success: true, ...result });
  });

  app.get('/api/tunnels', (req, res) => {
    const clientId = String(req.query.clientId || '').trim();
    const list = tunnels.list().filter((item) => !clientId || item.clientId === clientId);
    res.json({ success: true, count: list.length, tunnels: list });
  });

  app.post('/api/tunnels/:id/close', (req, res) => {
    const ok = tunnels.close(String(req.params.id || ''));
    if (!ok) return res.status(404).json({ success: false, message: 'tunnel not found' });
    res.json({ success: true });
  });

  app.post('/api/clients/:id/tunnel-command', (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const forwards = Array.isArray(req.body?.forwards) ? req.body.forwards : [];
    if (!forwards.length) {
      return res.status(400).json({ success: false, message: 'forwards is required' });
    }
    const parts = [];
    for (const item of forwards.slice(0, 16)) {
      const local = Number(item.local);
      const port = Number(item.port);
      const host = String(item.host || '127.0.0.1').trim();
      if (!Number.isInteger(local) || local <= 0 || local > 65535) {
        return res.status(400).json({ success: false, message: `invalid local port: ${item.local}` });
      }
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return res.status(400).json({ success: false, message: `invalid target port: ${item.port}` });
      }
      if (!host) {
        return res.status(400).json({ success: false, message: 'target host is required' });
      }
      parts.push(`--forward ${local}=${host}:${port}`);
    }
    let serverUrl = String(config.hub.publicUrl || '').replace(/\/agent$/, '/agent/tunnel');
    if (!/\/agent\/tunnel$/.test(serverUrl)) serverUrl = `${serverUrl.replace(/\/+$/, '')}/agent/tunnel`;
    const command = [
      'ops-agent.exe tunnel',
      `--server ${serverUrl}`,
      `--token ${config.tunnel.token}`,
      `--client ${agent.id}`,
      ...parts,
    ].join(' ');
    res.json({ success: true, command, serverUrl, forwards: forwards.length });
  });

  app.get('/api/downloads', (_req, res) => {
    const files = [];
    try {
      for (const name of fs.readdirSync(downloadsDir)) {
        if (!/\.(zip|tar\.gz|exe|msi)$/i.test(name)) continue;
        const stat = fs.statSync(path.join(downloadsDir, name));
        files.push({ name, size: stat.size, url: `/downloads/${encodeURIComponent(name)}` });
      }
    } catch {
      // 目录不存在时返回空列表
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, files });
  });

  app.get('/api/agent-config', (req, res) => {
    const os = req.query.os === 'linux' ? 'linux' : 'windows';
    const agentConfig = {
      server: config.hub.publicUrl,
      enrollmentToken: config.auth.enrollmentToken,
      agentToken: '',
      clientId: '',
      name: '',
      tags: [os],
      spoolDir: '',
      allowedRoots: os === 'windows' ? ['C:\\', 'D:\\'] : ['/var/log', '/opt', '/home'],
      maxSpoolMB: 2048,
      maxConcurrentJobs: 4,
      insecureSkipVerify: false,
      caFile: '',
      proxy: '',
      heartbeatIntervalSec: 15,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ops-agent-${os}-config.json"`);
    res.send(JSON.stringify(agentConfig, null, 2));
  });

  app.get('/api/clients', (req, res) => {
    const clients = store
      .listAgents({ tag: req.query.tag, status: req.query.status, query: req.query.query })
      .map((agent) => withDisplay(agent, false));
    res.json({ success: true, count: clients.length, clients });
  });

  app.get('/api/revoked', (_req, res) => {
    const revoked = Object.entries(store.state.revoked || {})
      .map(([id, value]) => ({
        id,
        revokedAt: typeof value === 'string' ? value : value?.revokedAt || null,
      }))
      .sort((a, b) => String(b.revokedAt || '').localeCompare(String(a.revokedAt || '')));
    res.json({ success: true, count: revoked.length, revoked });
  });

  app.get('/api/clients/:id', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    if (req.query.refresh === '1' && gateway.isOnline(agent.id)) {
      try {
        const info = await files.clientInfo(agent.id);
        store.updateAgent(agent.id, { info });
      } catch (error) {
        logger.warn(`刷新 ${agent.id} 信息失败: ${error.message}`);
      }
    }
    const fresh = store.getAgent(agent.id);
    res.json({ success: true, client: withDisplay(fresh) });
  }));

  app.patch('/api/clients/:id', (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    store.updateAgent(agent.id, { displayName: name });
    store.audit('agent.rename', { clientId: agent.id, name, previous: agent.displayName || agent.name });
    res.json({ success: true, client: withDisplay(store.getAgent(agent.id)) });
  });

  app.delete('/api/clients/:id', (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    store.removeAgent(agent.id);
    store.revokeAgent(agent.id);
    gateway.kick(agent.id, 'client deleted');
    store.audit('agent.delete', { clientId: agent.id, name: agent.name });
    res.json({ success: true });
  });

  app.post('/api/clients/:id/unrevoke', (req, res) => {
    const id = String(req.params.id || '');
    if (!store.isRevoked(id)) return res.status(404).json({ success: false, message: 'client not revoked' });
    store.unrevokeAgent(id);
    store.audit('agent.unrevoke', { clientId: id });
    res.json({ success: true });
  });

  app.get('/api/clients/:id/jobs', (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    res.json({ success: true, jobs: jobs.listJobs({ clientId: agent.id, limit: 100 }) });
  });

  app.post('/api/clients/:id/exec', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const job = await jobs.startJob(agent.id, {
      command: req.body.command,
      shell: req.body.shell,
      cwd: req.body.cwd,
      timeoutMs: req.body.timeoutMs,
      approveDangerous: Boolean(req.body.approveDangerous),
      createdBy: 'web',
    });
    res.json({ success: true, job });
  }));

  app.get('/api/jobs', (req, res) => {
    res.json({
      success: true,
      jobs: jobs.listJobs({
        clientId: req.query.clientId,
        status: req.query.status,
        limit: clamp(req.query.limit || 100, 1, 500),
      }),
    });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'job not found' });
    res.json({ success: true, job });
  });

  app.get('/api/jobs/:id/output', (req, res) => {
    try {
      const result = jobs.getOutput(
        req.params.id,
        Number(req.query.offset || 0),
        clamp(req.query.maxBytes || 64 * 1024, 1024, config.limits.maxReadBytes),
      );
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(404).json({ success: false, message: error.message });
    }
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      res.json({ success: true, ...jobs.cancelJob(req.params.id, 'web') });
    } catch (error) {
      res.status(404).json({ success: false, message: error.message });
    }
  });

  app.get('/api/transfers', (req, res) => {
    const list = Object.values(store.state.transfers)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, clamp(req.query.limit || 100, 1, 500));
    res.json({ success: true, transfers: list });
  });

  app.get('/api/audit', (req, res) => {
    res.json({ success: true, audit: store.listAudit(clamp(req.query.limit || 100, 1, 1000)) });
  });

  // 文件浏览
  app.get('/api/clients/:id/files', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const result = await files.listDir(agent.id, {
      path: req.query.path || (agent.os?.toLowerCase().includes('windows') ? 'C:\\' : '/'),
      pattern: req.query.pattern || '',
      recursive: req.query.recursive === '1',
      maxEntries: clamp(req.query.maxEntries || 500, 1, 5000),
    });
    res.json({ success: true, ...result });
  }));

  app.delete('/api/clients/:id/files', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    if (!req.query.path) return res.status(400).json({ success: false, message: 'path is required' });
    const result = await files.deletePath(agent.id, {
      path: req.query.path,
      recursive: req.query.recursive === '1',
    });
    res.json({ success: true, ...result });
  }));

  app.get('/api/clients/:id/files/read', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const result = await files.readFile(agent.id, {
      path: req.query.path,
      offset: Number(req.query.offset || 0),
      maxBytes: clamp(req.query.maxBytes || 64 * 1024, 1024, config.limits.maxReadBytes),
      encoding: req.query.encoding || 'auto',
    });
    res.json({ success: true, ...result });
  }));

  app.get('/api/clients/:id/files/tail', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const result = await files.tailFile(agent.id, {
      path: req.query.path,
      lines: clamp(req.query.lines || 200, 1, config.limits.maxTailLines),
      cursor: req.query.cursor || null,
      encoding: req.query.encoding || 'auto',
    });
    res.json({ success: true, ...result });
  }));

  app.post('/api/clients/:id/files/write', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const result = await files.writeFile(agent.id, {
      path: req.body.path,
      content: req.body.content,
      encoding: req.body.encoding || 'utf-8',
      append: Boolean(req.body.append),
      createDirs: req.body.createDirs !== false,
    });
    res.json({ success: true, ...result });
  }));

  app.post('/api/clients/:id/files/upload', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    const remotePath = String(req.query.path || req.body?.path || '');
    if (!remotePath) return res.status(400).json({ success: false, message: 'path is required' });
    const tmp = path.join(config.hub.dataDir, 'staging', `${randomId('upload')}.bin`);
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const result = await files.upload(agent.id, {
        localPath: tmp,
        remotePath,
        overwrite: req.query.overwrite === '1',
        createDirs: req.query.createDirs !== '0',
        actor: 'web',
      });
      res.json({ success: true, ...result });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }));

  app.get('/api/clients/:id/files/download', asyncHandler(async (req, res) => {
    const agent = store.findAgent(req.params.id);
    if (!agent) return res.status(404).json({ success: false, message: 'client not found' });
    if (!req.query.path) return res.status(400).json({ success: false, message: 'path is required' });
    const result = await files.download(agent.id, {
      remotePath: req.query.path,
      actor: 'web',
    });
    res.download(result.localPath, path.basename(result.localPath));
  }));

  // Private time-limited Agent installer generated by the MCP tool
  app.get('/downloads/private/:token/:file', (req, res) => {
    const file = privatePackageFile(config, req.params.token, req.params.file);
    if (!file) return res.status(404).send('Not found');
    res.download(file);
  });

  // MCP endpoint
  app.use(createMcpRouter({ config, gateway, jobs, files, store, logger, tunnels }));

  // 静态管理界面
  app.use(express.static(path.join(PROJECT_ROOT, 'public'), { index: 'index.html' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path === '/agent') {
      return next();
    }
    res.sendFile(path.join(PROJECT_ROOT, 'public', 'index.html'));
  });

  app.use((error, _req, res, _next) => {
    logger.error('HTTP error', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.hub.port, config.hub.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  logger.info(`ops-hub listening on http://${config.hub.host}:${address.port}`);
  logger.info(`agent websocket: ${config.hub.publicUrl} (local path /agent)`);
  logger.info(`MCP endpoint: http://<hub>/mcp (Bearer auth)`);
  try { cleanupAgentPackages(config); } catch (error) { logger.warn('清理旧客户端安装包失败', error.message); }

  const pruneTimer = setInterval(() => {
    try {
      const removed = store.pruneJobs({ keep: 500, maxAgeDays: 30 });
      if (removed) logger.info(`清理旧任务 ${removed} 个`);
    } catch (error) {
      logger.warn('清理旧任务失败', error.message);
    }
  }, 6 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  const packageCleanupTimer = setInterval(() => {
    try { cleanupAgentPackages(config); } catch (error) { logger.warn('清理旧客户端安装包失败', error.message); }
  }, 60 * 60 * 1000);
  packageCleanupTimer.unref?.();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(pruneTimer);
    clearInterval(packageCleanupTimer);
    logger.info('shutting down...');
    tunnels.close();
    gateway.close();
    store.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => server.close(resolve));
  };

  return {
    app,
    server,
    store,
    gateway,
    jobs,
    files,
    tunnels,
    logger,
    close,
    address,
  };
}
