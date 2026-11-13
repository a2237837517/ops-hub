import dns from 'node:dns/promises';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { STREAM, decodeStreamFrame, encodeStreamFrame } from '../protocol.js';
import { nowIso, randomId } from '../utils.js';

const MAX_STREAM_ID = 0xffffffff;

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ip, cidr) {
  const [base, bitsText] = String(cidr).split('/');
  const bits = Number(bitsText);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export class TunnelGateway {
  constructor({ httpServer, config, store, logger, agentGateway }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.agentGateway = agentGateway;
    this.tunnels = new Map();
    this.streamsByGlobalId = new Map();
    this.nextStreamId = 1;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });

    httpServer.on('upgrade', (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        return;
      }
      if (pathname !== '/agent/tunnel') return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.agentGateway.on('stream', (clientId, payload) => this._onAgentFrame(clientId, payload));
    this.agentGateway.on('agent:offline', (clientId) => this._onAgentOffline(clientId));
    this.idleTimer = setInterval(() => this._checkIdle(), 30_000);
    this.idleTimer.unref?.();
  }

  _authToken(req) {
    const header = String(req.headers.authorization || '');
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    try {
      return new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    } catch {
      return '';
    }
  }

  _onConnection(ws, req) {
    const cfg = this.config.tunnel || {};
    if (!cfg.enabled) {
      ws.close(4003, 'tunnel disabled');
      return;
    }
    const token = this._authToken(req);
    if (!cfg.token || token !== cfg.token) {
      this.logger.warn('tunnel auth failed');
      ws.close(4003, 'invalid tunnel token');
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      ws.close(4003, 'invalid request');
      return;
    }
    const clientId = String(url.searchParams.get('clientId') || '').trim();
    if (!clientId) {
      ws.close(4003, 'clientId required');
      return;
    }
    if (!this.agentGateway.getConnection(clientId)) {
      ws.close(4004, 'agent offline');
      return;
    }

    const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    const tunnel = {
      id: randomId('tnl'),
      clientId,
      remoteAddress: forwarded || req.socket.remoteAddress,
      ws,
      streams: new Map(),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.tunnels.set(tunnel.id, tunnel);
    this.store.audit('tunnel.connect', {
      tunnelId: tunnel.id,
      clientId,
      remoteAddress: tunnel.remoteAddress,
    });
    this.logger.info(`tunnel connected: ${clientId} (${tunnel.remoteAddress})`);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      tunnel.lastSeen = Date.now();
    });
    ws.on('message', (raw, isBinary) => {
      tunnel.lastSeen = Date.now();
      if (!isBinary) return;
      this._onTunnelFrame(tunnel, raw);
    });
    ws.on('close', () => this._closeTunnel(tunnel, 'client closed'));
    ws.on('error', (error) => this.logger.warn(`tunnel ws error: ${error.message}`));
  }

  _nextStreamId() {
    return this.agentGateway.allocStreamId();
  }

  async _onTunnelFrame(tunnel, raw) {
    const frame = decodeStreamFrame(raw);
    if (!frame) return;
    if (frame.type === STREAM.OPEN) {
      await this._openStream(tunnel, frame);
      return;
    }
    const entry = tunnel.streams.get(frame.streamId);
    if (!entry) return;
    entry.lastActivity = Date.now();
    if (frame.type === STREAM.DATA) {
      entry.bytesIn += frame.payload.length;
      this.agentGateway.sendStream(
        entry.clientId,
        encodeStreamFrame(STREAM.DATA, entry.globalId, frame.payload),
      );
    } else if (frame.type === STREAM.CLOSE) {
      this._closeStream(entry, 'client closed');
    }
  }

  async _openStream(tunnel, frame) {
    const cfg = this.config.tunnel || {};
    const maxStreams = Number(cfg.maxStreamsPerTunnel) || 16;
    if (tunnel.streams.size >= maxStreams) {
      this._sendOpenFail(tunnel, frame.streamId, `too many streams (max ${maxStreams})`);
      return;
    }
    let request;
    try {
      request = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      this._sendOpenFail(tunnel, frame.streamId, 'invalid open request');
      return;
    }
    const host = String(request.host || '').trim();
    const port = Number(request.port);
    const targetClientId = String(request.clientId || tunnel.clientId || '').trim();
    if (!this.agentGateway.getConnection(targetClientId)) {
      this._sendOpenFail(tunnel, frame.streamId, `agent offline: ${targetClientId}`);
      return;
    }
    if (this.store.isRevoked(targetClientId)) {
      this._sendOpenFail(tunnel, frame.streamId, `client revoked: ${targetClientId}`);
      return;
    }
    const error = await this._validateTarget(host, port);
    if (error) {
      this.store.audit('tunnel.target.denied', {
        tunnelId: tunnel.id,
        clientId: targetClientId,
        target: `${host}:${port}`,
        reason: error,
      });
      this._sendOpenFail(tunnel, frame.streamId, error);
      return;
    }

    const globalId = this._nextStreamId();
    if (!globalId) {
      this._sendOpenFail(tunnel, frame.streamId, 'stream id exhausted');
      return;
    }
    const entry = {
      tunnel,
      clientId: targetClientId,
      localId: frame.streamId,
      globalId,
      host,
      port,
      localPort: Number(request.localPort) || 0,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    tunnel.streams.set(frame.streamId, entry);
    this.streamsByGlobalId.set(globalId, entry);

    const payload = Buffer.from(JSON.stringify({ host, port }), 'utf8');
    const ok = this.agentGateway.sendStream(
      targetClientId,
      encodeStreamFrame(STREAM.OPEN, globalId, payload),
    );
    if (!ok) {
      this._closeStream(entry, 'agent offline');
      this._sendOpenFail(tunnel, frame.streamId, 'agent offline');
    }
  }

  _sendOpenFail(tunnel, localId, message) {
    try {
      tunnel.ws.send(
        encodeStreamFrame(STREAM.OPEN_FAIL, localId, Buffer.from(String(message), 'utf8')),
        { binary: true },
      );
    } catch {
      // ignore
    }
  }

  _onAgentFrame(clientId, raw) {
    const frame = decodeStreamFrame(raw);
    if (!frame) return;
    const entry = this.streamsByGlobalId.get(frame.streamId);
    if (!entry || entry.clientId !== clientId) return;
    entry.lastActivity = Date.now();
    const { tunnel } = entry;
    if (frame.type === STREAM.OPEN_OK) {
      try {
        tunnel.ws.send(encodeStreamFrame(STREAM.OPEN_OK, entry.localId), { binary: true });
      } catch {
        this._closeStream(entry, 'client closed');
      }
      return;
    }
    if (frame.type === STREAM.OPEN_FAIL) {
      this._sendOpenFail(tunnel, entry.localId, frame.payload.toString('utf8'));
      this._closeStream(entry, 'open failed');
      return;
    }
    if (frame.type === STREAM.DATA) {
      if (tunnel.ws.bufferedAmount > 16 * 1024 * 1024) {
        this._closeStream(entry, 'client too slow');
        return;
      }
      entry.bytesOut += frame.payload.length;
      try {
        tunnel.ws.send(encodeStreamFrame(STREAM.DATA, entry.localId, frame.payload), {
          binary: true,
        });
      } catch {
        this._closeStream(entry, 'client closed');
      }
      return;
    }
    if (frame.type === STREAM.CLOSE) {
      try {
        tunnel.ws.send(encodeStreamFrame(STREAM.CLOSE, entry.localId), { binary: true });
      } catch {
        // ignore
      }
      this._closeStream(entry, 'remote closed', false);
    }
  }

  _closeStream(entry, reason, notifyAgent = true) {
    const { tunnel } = entry;
    tunnel.streams.delete(entry.localId);
    this.streamsByGlobalId.delete(entry.globalId);
    this.agentGateway.releaseStreamId(entry.globalId);
    if (notifyAgent) {
      this.agentGateway.sendStream(
        entry.clientId,
        encodeStreamFrame(STREAM.CLOSE, entry.globalId),
      );
    }
    this.store.audit('tunnel.close', {
      tunnelId: tunnel.id,
      clientId: entry.clientId,
      target: `${entry.host}:${entry.port}`,
      localPort: entry.localPort,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      durationMs: Date.now() - entry.startedAt,
      reason,
    });
  }

  _closeTunnel(tunnel, reason) {
    if (!this.tunnels.has(tunnel.id)) return;
    for (const entry of [...tunnel.streams.values()]) {
      this._closeStream(entry, reason);
    }
    this.tunnels.delete(tunnel.id);
    this.store.audit('tunnel.disconnect', {
      tunnelId: tunnel.id,
      clientId: tunnel.clientId,
      reason,
    });
    this.logger.info(`tunnel disconnected: ${tunnel.clientId} (${reason})`);
  }

  _onAgentOffline(clientId) {
    for (const tunnel of [...this.tunnels.values()]) {
      for (const entry of [...tunnel.streams.values()]) {
        if (entry.clientId !== clientId) continue;
        try {
          tunnel.ws.send(encodeStreamFrame(STREAM.CLOSE, entry.localId), { binary: true });
        } catch {
          // ignore
        }
        this._closeStream(entry, 'agent offline', false);
      }
      if (tunnel.clientId !== clientId) continue;
      try {
        tunnel.ws.close(4004, 'agent offline');
      } catch {
        // ignore
      }
      this._closeTunnel(tunnel, 'agent offline');
    }
  }

  _checkIdle() {
    const cfg = this.config.tunnel || {};
    const idleMs = (Number(cfg.idleTimeoutSec) || 1800) * 1000;
    const now = Date.now();
    for (const tunnel of this.tunnels.values()) {
      for (const entry of [...tunnel.streams.values()]) {
        if (now - entry.lastActivity > idleMs) {
          try {
            this.agentGateway.sendStream(
              entry.clientId,
              encodeStreamFrame(STREAM.CLOSE, entry.globalId),
            );
          } catch {
            // ignore
          }
          try {
            tunnel.ws.send(encodeStreamFrame(STREAM.CLOSE, entry.localId), { binary: true });
          } catch {
            // ignore
          }
          this._closeStream(entry, 'idle timeout', false);
        }
      }
      // 半开连接（NAT/防火墙把连接丢了，但没发 FIN）只能靠 ping/pong 发现。
      if (!tunnel.ws.isAlive) {
        try {
          tunnel.ws.terminate();
        } catch {
          // ignore
        }
        this._closeTunnel(tunnel, 'heartbeat timeout');
        continue;
      }
      tunnel.ws.isAlive = false;
      try {
        tunnel.ws.ping();
      } catch {
        // ignore
      }
      if (now - tunnel.lastSeen > 15 * 60 * 1000) {
        try {
          tunnel.ws.terminate();
        } catch {
          // ignore
        }
        this._closeTunnel(tunnel, 'idle timeout');
      }
    }
  }

  validateTarget(host, port) {
    return this._validateTarget(host, port);
  }

  async _validateTarget(host, port) {
    if (!host) return 'target host is required';
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'target port is invalid';
    const cfg = this.config.tunnel || {};
    if (Array.isArray(cfg.allowedPorts) && cfg.allowedPorts.length) {
      if (!cfg.allowedPorts.map(Number).includes(port)) {
        return `port ${port} is not allowed`;
      }
    }

    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        const records = await dns.lookup(host, { all: true, family: 0 });
        addresses = records.map((record) => record.address);
      } catch (error) {
        return `cannot resolve ${host}: ${error.message}`;
      }
    }
    if (!addresses.length) return `cannot resolve ${host}`;

    const cidrs = Array.isArray(cfg.allowedCidrs) ? cfg.allowedCidrs : [];
    for (const address of addresses) {
      const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
      if (normalized === '::1' || normalized === '127.0.0.1') continue;
      if (net.isIPv4(normalized)) {
        if (!cidrs.some((cidr) => inCidr(normalized, cidr))) {
          return `target ${normalized} is not in the allowed CIDRs`;
        }
      } else {
        return `IPv6 target ${normalized} is not allowed`;
      }
    }
    return '';
  }

  list() {
    return [...this.tunnels.values()].map((tunnel) => ({
      id: tunnel.id,
      clientId: tunnel.clientId,
      remoteAddress: tunnel.remoteAddress,
      createdAt: new Date(tunnel.createdAt).toISOString(),
      streams: [...tunnel.streams.values()].map((entry) => ({
        clientId: entry.clientId,
        target: `${entry.host}:${entry.port}`,
        localPort: entry.localPort,
        bytesIn: entry.bytesIn,
        bytesOut: entry.bytesOut,
        startedAt: new Date(entry.startedAt).toISOString(),
      })),
    }));
  }

  close(id) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    try {
      tunnel.ws.close(4005, 'closed by admin');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        tunnel.ws.terminate();
      } catch {
        // ignore
      }
    }, 1000).unref?.();
    this._closeTunnel(tunnel, 'closed by admin');
    return true;
  }

  // 注意：不能叫 close，否则会覆盖上面的 close(id)，关闭单条隧道时把整个 WSS 关掉。
  shutdown() {
    clearInterval(this.idleTimer);
    for (const tunnel of [...this.tunnels.values()]) {
      try {
        tunnel.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.wss.close();
  }
}
