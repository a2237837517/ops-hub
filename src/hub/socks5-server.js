import crypto from 'node:crypto';
import net from 'node:net';
import { STREAM, decodeStreamFrame, encodeStreamFrame } from '../protocol.js';
import { nowIso } from '../utils.js';

const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function writeReply(socket, code) {
  socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function formatIPv6(buffer) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(buffer.readUInt16BE(i).toString(16));
  }
  return parts.join(':');
}

function createReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let closed = false;

  const failAll = (error) => {
    while (waiters.length) waiters.shift().reject(error);
  };
  const pump = () => {
    while (waiters.length) {
      const waiter = waiters[0];
      if (buffer.length < waiter.n) break;
      waiters.shift();
      const value = buffer.subarray(0, waiter.n);
      buffer = buffer.subarray(waiter.n);
      waiter.resolve(value);
    }
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  };
  const onClose = () => {
    closed = true;
    failAll(new Error('socket closed'));
  };
  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', onClose);

  return {
    read(n, timeoutMs = 15_000) {
      if (closed) return Promise.reject(new Error('socket closed'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === wrappedResolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('read timeout'));
        }, timeoutMs);
        const wrappedResolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        const wrappedReject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        waiters.push({ n, resolve: wrappedResolve, reject: wrappedReject });
        pump();
      });
    },
    detach() {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
      const rest = buffer;
      buffer = Buffer.alloc(0);
      return rest;
    },
  };
}

export class Socks5Server {
  constructor({ config, store, logger, agentGateway, tunnelGateway }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.agentGateway = agentGateway;
    this.tunnelGateway = tunnelGateway;
    this.server = null;
    this.sockets = new Set();
    this.streams = new Map(); // globalId -> entry
    this.pending = new Map(); // globalId -> resolve
    this.nextStreamId = 1;
    this.idleTimer = null;

    this.agentGateway.on('stream', (clientId, raw) => this._onAgentFrame(clientId, raw));
    this.agentGateway.on('agent:offline', (clientId) => this._onAgentOffline(clientId));
  }

  get cfg() {
    return this.config.socks5 || {};
  }

  start() {
    if (this.server) return this.status();
    const cfg = this.cfg;
    if (!cfg.token) throw new Error('socks5 token is not configured');
    if (!Number.isInteger(Number(cfg.port)) || Number(cfg.port) <= 0 || Number(cfg.port) > 65535) {
      throw new Error('socks5 port is invalid');
    }
    this.server = net.createServer((socket) => this._handle(socket));
    this.server.on('error', (error) => {
      this.logger.error(`socks5 server error: ${error.message}`);
    });
    this.server.listen(Number(cfg.port), cfg.host || '0.0.0.0', () => {
      this.logger.info(`socks5 listening on ${cfg.host || '0.0.0.0'}:${cfg.port}`);
    });
    this.idleTimer = setInterval(() => this._checkIdle(), 60_000);
    this.idleTimer.unref?.();
    this.store.audit('socks5.start', { host: cfg.host, port: cfg.port });
    return this.status();
  }

  stop() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const entry of [...this.streams.values()]) {
      this._close(entry, 'server stopped');
    }
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
    this.store.audit('socks5.stop', {});
    return this.status();
  }

  status() {
    const cfg = this.cfg;
    return {
      enabled: Boolean(this.server),
      host: cfg.publicHost || cfg.host || '',
      port: Number(cfg.port) || 1080,
      connections: this.sockets.size,
      streams: this.streams.size,
    };
  }

  _handle(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));

    this._handshake(socket).catch((error) => {
      this.logger.debug(`socks5 handshake failed: ${error.message}`);
      try {
        writeReply(socket, REP_GENERAL_FAILURE);
      } catch {
        // ignore
      }
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  }

  async _handshake(socket) {
    const reader = createReader(socket);
    const version = await reader.read(1);
    if (version[0] !== 5) throw new Error('not socks5');

    const methodCount = (await reader.read(1))[0];
    const methods = await reader.read(methodCount);
    // 必须用用户名/密码认证：用户名 = clientId，密码 = socks token。
    if (!methods.includes(0x02)) {
      socket.end(Buffer.from([5, 0xff]));
      return;
    }
    socket.write(Buffer.from([5, 0x02]));

    const authVersion = (await reader.read(1))[0];
    if (authVersion !== 1) throw new Error('bad auth version');
    const userLen = (await reader.read(1))[0];
    const username = (await reader.read(userLen)).toString('utf8');
    const passLen = (await reader.read(1))[0];
    const password = (await reader.read(passLen)).toString('utf8');

    const cfg = this.cfg;
    if (!safeEqual(password, cfg.token || '')) {
      socket.end(Buffer.from([1, 1]));
      return;
    }
    const agent = this.store.findAgent(username);
    if (!agent || !this.agentGateway.getConnection(agent.id)) {
      socket.end(Buffer.from([1, 1]));
      return;
    }
    socket.write(Buffer.from([1, 0]));

    const header = await reader.read(4);
    if (header[0] !== 5) throw new Error('bad request version');
    if (header[1] !== 1) {
      writeReply(socket, REP_CMD_NOT_SUPPORTED);
      socket.destroy();
      return;
    }

    let host = '';
    switch (header[3]) {
      case 0x01:
        host = [...(await reader.read(4))].join('.');
        break;
      case 0x03: {
        const length = (await reader.read(1))[0];
        host = (await reader.read(length)).toString('utf8');
        break;
      }
      case 0x04:
        host = formatIPv6(await reader.read(16));
        break;
      default:
        writeReply(socket, REP_ATYP_NOT_SUPPORTED);
        socket.destroy();
        return;
    }
    const port = (await reader.read(2)).readUInt16BE(0);

    const clientStreams = [...this.streams.values()].filter((item) => item.clientId === agent.id).length;
    if (clientStreams >= (Number(cfg.maxStreamsPerClient) || 16)) {
      writeReply(socket, REP_NOT_ALLOWED);
      socket.destroy();
      return;
    }

    const targetError = await this.tunnelGateway.validateTarget(host, port);
    if (targetError) {
      this.store.audit('socks5.target.denied', {
        clientId: agent.id,
        target: `${host}:${port}`,
        reason: targetError,
        remoteAddress: socket.remoteAddress,
      });
      writeReply(socket, REP_NOT_ALLOWED);
      socket.destroy();
      return;
    }

    const globalId = this.agentGateway.allocStreamId();
    if (!globalId) {
      writeReply(socket, REP_GENERAL_FAILURE);
      socket.destroy();
      return;
    }
    // 先注册 entry 再发 OPEN：目标服务（MySQL/SSH）可能在 OPEN_OK 后立刻发 greeting，
    // 晚注册会把第一批 DATA 丢掉。ready 之前的 DATA 先放进 early 缓冲。
    const entry = {
      globalId,
      clientId: agent.id,
      socket,
      target: `${host}:${port}`,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      ready: false,
      early: [],
    };
    this.streams.set(globalId, entry);
    const pending = new Promise((resolve) => {
      this.pending.set(globalId, resolve);
    });
    const payload = Buffer.from(JSON.stringify({ host, port, kind: 'socks5' }), 'utf8');
    const sent = this.agentGateway.sendStream(
      agent.id,
      encodeStreamFrame(STREAM.OPEN, globalId, payload),
    );
    if (!sent) {
      this.pending.delete(globalId);
      this.streams.delete(globalId);
      this.agentGateway.releaseStreamId(globalId);
      writeReply(socket, REP_HOST_UNREACHABLE);
      socket.destroy();
      return;
    }

    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 15_000)),
    ]);
    this.pending.delete(globalId);
    if (!result?.ok) {
      this.streams.delete(globalId);
      this.agentGateway.releaseStreamId(globalId);
      writeReply(socket, REP_HOST_UNREACHABLE);
      socket.destroy();
      return;
    }

    writeReply(socket, REP_SUCCESS);
    entry.ready = true;
    for (const chunk of entry.early) {
      if (!socket.destroyed) socket.write(chunk);
    }
    entry.early = [];

    const leftover = reader.detach();
    if (leftover.length) {
      this._sendData(entry, leftover);
    }
    socket.on('data', (chunk) => this._sendData(entry, chunk));
    socket.on('close', () => this._close(entry, 'client closed'));
    socket.on('error', () => this._close(entry, 'client error'));

    this.store.audit('socks5.open', {
      clientId: agent.id,
      target: entry.target,
      remoteAddress: socket.remoteAddress,
    });
  }

  _sendData(entry, chunk) {
    entry.bytesOut += chunk.length;
    entry.lastActivity = Date.now();
    const ok = this.agentGateway.sendStream(
      entry.clientId,
      encodeStreamFrame(STREAM.DATA, entry.globalId, chunk),
    );
    if (!ok) this._close(entry, 'agent offline');
  }

  _onAgentFrame(clientId, raw) {
    const frame = decodeStreamFrame(raw);
    if (!frame) return;
    const entry = this.streams.get(frame.streamId);
    if (entry) {
      if (entry.clientId !== clientId) return;
      entry.lastActivity = Date.now();
      if (frame.type === STREAM.DATA) {
        entry.bytesIn += frame.payload.length;
        if (!entry.ready) {
          entry.early.push(frame.payload);
          return;
        }
        if (!entry.socket.destroyed) entry.socket.write(frame.payload);
        return;
      }
      if (frame.type === STREAM.CLOSE) {
        try {
          entry.socket.end();
        } catch {
          // ignore
        }
        this._close(entry, 'target closed', false);
        return;
      }
    }
    const pending = this.pending.get(frame.streamId);
    if (pending) {
      if (frame.type === STREAM.OPEN_OK) pending({ ok: true });
      else if (frame.type === STREAM.OPEN_FAIL) pending({ ok: false });
    }
  }

  _onAgentOffline(clientId) {
    for (const entry of [...this.streams.values()]) {
      if (entry.clientId !== clientId) continue;
      try {
        entry.socket.destroy();
      } catch {
        // ignore
      }
      this._close(entry, 'agent offline', false);
    }
  }

  _close(entry, reason, notifyAgent = true) {
    if (!this.streams.has(entry.globalId)) return;
    this.streams.delete(entry.globalId);
    this.agentGateway.releaseStreamId(entry.globalId);
    if (notifyAgent) {
      this.agentGateway.sendStream(
        entry.clientId,
        encodeStreamFrame(STREAM.CLOSE, entry.globalId),
      );
    }
    try {
      entry.socket.destroy();
    } catch {
      // ignore
    }
    this.store.audit('socks5.close', {
      clientId: entry.clientId,
      target: entry.target,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      durationMs: Date.now() - entry.startedAt,
      reason,
    });
  }

  _checkIdle() {
    const idleMs = (Number(this.cfg.idleTimeoutSec) || 1800) * 1000;
    const now = Date.now();
    for (const entry of [...this.streams.values()]) {
      if (now - entry.lastActivity > idleMs) {
        this._close(entry, 'idle timeout');
      }
    }
  }
}
