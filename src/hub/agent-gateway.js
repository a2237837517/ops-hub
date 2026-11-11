import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION } from '../protocol.js';
import { hashToken } from '../store.js';
import { nowIso, randomId, randomToken } from '../utils.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

export class AgentGateway extends EventEmitter {
  constructor({ httpServer, config, store, logger }) {
    super();
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.connections = new Map(); // clientId -> connection
    this.pendingRpc = new Map(); // requestId -> { resolve, reject, timer, clientId }
    this.helloTimers = new Map(); // ws -> timer
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: Math.max(16 * 1024 * 1024, Number(config.limits.maxChunkBytes) * 8 || 0),
      perMessageDeflate: true,
    });

    httpServer.on('upgrade', (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== '/agent') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    this.heartbeatTimer = setInterval(() => this._checkHeartbeats(), 10_000);
    this.heartbeatTimer.unref?.();
  }

  _onConnection(ws, req) {
    ws.isAlive = true;
    ws.remoteAddress = req.socket.remoteAddress;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        this.logger.warn('收到非法 JSON 消息，关闭连接');
        ws.close(4002, 'invalid json');
        return;
      }
      this._onMessage(ws, msg);
    });
    ws.on('close', () => this._onClose(ws));
    ws.on('error', (error) => {
      this.logger.warn('agent websocket error', error.message);
    });

    const timer = setTimeout(() => {
      if (!ws.clientId) ws.close(4003, 'hello timeout');
    }, 15_000);
    timer.unref?.();
    this.helloTimers.set(ws, timer);
  }

  _onMessage(ws, msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === MSG.HELLO) {
      this._handleHello(ws, msg);
      return;
    }

    if (!ws.clientId) {
      ws.close(4003, 'hello required');
      return;
    }

    const conn = this.connections.get(ws.clientId);
    if (conn) conn.lastSeen = Date.now();

    switch (msg.type) {
      case MSG.HEARTBEAT:
        this.store.updateAgent(ws.clientId, { lastSeen: nowIso(), status: 'online' });
        this._send(ws, {
          type: MSG.HEARTBEAT_ACK,
          ts: Date.now(),
          serverTime: nowIso(),
        });
        break;

      case 'agent.info':
        this.store.updateAgent(ws.clientId, { info: msg.info || {}, status: 'online' });
        break;

      case MSG.RPC_RESULT:
        this._resolveRpc(msg);
        break;

      case MSG.EXEC_STARTED:
      case MSG.EXEC_CHUNK:
      case MSG.EXEC_EXIT:
      case MSG.EXEC_ERROR:
      case MSG.EXEC_LOST:
        this.emit(msg.type, ws.clientId, msg);
        break;

      case MSG.FILE_UPLOAD_READY:
      case MSG.FILE_UPLOAD_ACK:
      case MSG.FILE_UPLOAD_DONE:
      case MSG.FILE_UPLOAD_ERROR:
      case MSG.FILE_DOWNLOAD_CHUNK:
      case MSG.FILE_DOWNLOAD_DONE:
      case MSG.FILE_DOWNLOAD_ERROR:
        this.emit(msg.type, ws.clientId, msg);
        break;

      default:
        this.logger.debug('未知 agent 消息', msg.type);
    }
  }

  _handleHello(ws, msg) {
    const fail = (reason) => {
      this._send(ws, { type: MSG.HELLO_ERROR, message: reason });
      ws.close(4003, reason);
    };

    if (Number(msg.protocolVersion) > PROTOCOL_VERSION) {
      fail(`protocol version not supported: ${msg.protocolVersion}`);
      return;
    }
    const clientId = String(msg.clientId || '').trim();
    if (!CLIENT_ID_RE.test(clientId)) {
      fail('invalid clientId');
      return;
    }
    if (this.store.isRevoked(clientId)) {
      this.store.audit('agent.auth.failed', {
        clientId,
        remoteAddress: ws.remoteAddress,
        reason: 'client revoked',
      });
      fail('client revoked');
      return;
    }

    let agent = this.store.getAgent(clientId);
    let issuedToken = null;

    if (agent && agent.tokenHash) {
      if (!msg.agentToken || hashToken(msg.agentToken) !== agent.tokenHash) {
        this.store.audit('agent.auth.failed', {
          clientId,
          remoteAddress: ws.remoteAddress,
          reason: 'bad agent token',
        });
        fail('invalid agent token');
        return;
      }
    } else {
      if (!this.config.auth.enrollmentToken || msg.enrollmentToken !== this.config.auth.enrollmentToken) {
        this.store.audit('agent.auth.failed', {
          clientId,
          remoteAddress: ws.remoteAddress,
          reason: 'bad enrollment token',
        });
        fail('invalid enrollment token');
        return;
      }
      if (!agent) {
        if (this.store.listAgents().length >= this.config.hub.maxClients) {
          fail('too many clients');
          return;
        }
        agent = {
          id: clientId,
          name: String(msg.name || msg.hostname || clientId).slice(0, 200),
          hostname: String(msg.hostname || '').slice(0, 200),
          os: String(msg.os || '').slice(0, 100),
          arch: String(msg.arch || '').slice(0, 50),
          version: String(msg.version || '').slice(0, 50),
          tags: Array.isArray(msg.tags) ? msg.tags.map(String).slice(0, 30) : [],
          status: 'online',
          info: {},
          createdAt: nowIso(),
        };
      }
      issuedToken = randomToken(32);
      agent.tokenHash = hashToken(issuedToken);
      this.store.upsertAgent(agent);
      this.store.audit('agent.enrolled', { clientId, remoteAddress: ws.remoteAddress });
    }

    // 同一个 clientId 只保留最新连接
    const old = this.connections.get(clientId);
    if (old && old.ws !== ws) {
      try {
        old.ws.close(4001, 'replaced by new connection');
      } catch {
        // ignore
      }
      this.connections.delete(clientId);
    }

    const oldTimer = this.helloTimers.get(ws);
    if (oldTimer) {
      clearTimeout(oldTimer);
      this.helloTimers.delete(ws);
    }

    ws.clientId = clientId;
    const conn = {
      clientId,
      ws,
      remoteAddress: ws.remoteAddress,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.connections.set(clientId, conn);

    agent = this.store.updateAgent(clientId, {
      status: 'online',
      connected: true,
      lastSeen: nowIso(),
      remoteAddress: ws.remoteAddress,
      name: String(msg.name || agent.name || msg.hostname || clientId).slice(0, 200),
      hostname: String(msg.hostname || agent.hostname || '').slice(0, 200),
      os: String(msg.os || agent.os || '').slice(0, 100),
      arch: String(msg.arch || agent.arch || '').slice(0, 50),
      version: String(msg.version || agent.version || '').slice(0, 50),
      tags: Array.isArray(msg.tags) ? msg.tags.map(String).slice(0, 30) : agent.tags || [],
    });

    this._send(ws, {
      type: MSG.HELLO_ACK,
      protocolVersion: PROTOCOL_VERSION,
      clientId,
      agentToken: issuedToken || undefined,
      heartbeatIntervalSec: this.config.hub.heartbeatIntervalSec,
      serverTime: nowIso(),
    });

    this.store.audit('agent.online', {
      clientId,
      name: agent?.name,
      remoteAddress: ws.remoteAddress,
    });
    this.logger.info(`agent online: ${clientId} (${ws.remoteAddress})`);
    this.emit('agent:online', agent, msg);

    // 拉一次完整信息，不阻塞 hello
    this.rpc(clientId, 'client.info', { include: ['disks', 'network', 'cpu'] }, 15000)
      .then((info) => {
        this.store.updateAgent(clientId, { info: info || {} });
      })
      .catch((error) => this.logger.debug(`获取 ${clientId} 信息失败: ${error.message}`));
  }

  _resolveRpc(msg) {
    const pending = this.pendingRpc.get(msg.requestId);
    if (!pending) return;
    this.pendingRpc.delete(msg.requestId);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'agent rpc failed'));
  }

  _onClose(ws) {
    const timer = this.helloTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.helloTimers.delete(ws);
    }
    const clientId = ws.clientId;
    if (!clientId) return;
    const conn = this.connections.get(clientId);
    if (!conn || conn.ws !== ws) return;
    this.connections.delete(clientId);

    this.store.updateAgent(clientId, {
      status: 'offline',
      connected: false,
      lastSeen: nowIso(),
    });
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(requestId);
        pending.reject(new Error('agent disconnected'));
      }
    }
    this.store.audit('agent.offline', { clientId });
    this.logger.info(`agent offline: ${clientId}`);
    this.emit('agent:offline', clientId);
  }

  _checkHeartbeats() {
    const timeout = this.config.hub.heartbeatTimeoutSec * 1000;
    const now = Date.now();
    for (const [clientId, conn] of this.connections.entries()) {
      if (now - conn.lastSeen > timeout) {
        this.logger.warn(`agent heartbeat timeout: ${clientId}`);
        try {
          conn.ws.terminate();
        } catch {
          // ignore
        }
        this.connections.delete(clientId);
        this.store.updateAgent(clientId, {
          status: 'offline',
          connected: false,
          lastSeen: nowIso(),
        });
        this.emit('agent:offline', clientId);
      }
    }
  }

  _send(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (error) {
      this.logger.warn('发送 agent 消息失败', error.message);
      return false;
    }
  }

  send(clientId, msg) {
    const conn = this.connections.get(clientId);
    if (!conn) return false;
    return this._send(conn.ws, msg);
  }

  isOnline(clientId) {
    return this.connections.has(clientId);
  }

  kick(clientId, reason = 'client revoked') {
    const conn = this.connections.get(clientId);
    if (!conn) return false;
    try {
      conn.ws.close(4004, reason);
    } catch {
      // ignore
    }
    this.connections.delete(clientId);
    return true;
  }

  listOnline() {
    return [...this.connections.keys()];
  }

  rpc(clientId, method, params = {}, timeoutMs = 30_000) {
    if (!this.isOnline(clientId)) {
      return Promise.reject(new Error(`客户端不在线: ${clientId}`));
    }
    const requestId = randomId('rpc');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        reject(new Error(`agent rpc 超时: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(requestId, { resolve, reject, timer, clientId });
      const sent = this.send(clientId, {
        type: MSG.RPC,
        requestId,
        method,
        params,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingRpc.delete(requestId);
        reject(new Error(`客户端已断开: ${clientId}`));
      }
    });
  }

  close() {
    clearInterval(this.heartbeatTimer);
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close(1001, 'hub shutdown');
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.wss.close();
  }
}
