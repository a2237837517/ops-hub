import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { startHub } from '../src/hub/server.js';
import { STREAM, decodeStreamFrame, encodeStreamFrame } from '../src/protocol.js';

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timeout waiting for ws message'));
    }, timeoutMs);
    function onMessage(raw, isBinary) {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

function waitForFrame(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timeout waiting for stream frame'));
    }, timeoutMs);
    function onMessage(raw, isBinary) {
      if (!isBinary) return;
      const frame = decodeStreamFrame(raw);
      if (!frame || !predicate(frame)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    }
    ws.on('message', onMessage);
  });
}

async function startEchoServer() {
  const server = net.createServer((socket) => {
    socket.on('data', (data) => socket.write(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function startTestHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-tunnel-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
      tunnel: { enabled: true, token: 'tunnel-token' },
    }),
  );
  const hub = await startHub(loadConfig(configFile));
  return { hub, port: hub.address.port };
}

async function connectFakeAgent(port) {
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  await new Promise((resolve, reject) => {
    agent.once('open', resolve);
    agent.once('error', reject);
  });
  agent.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      clientId: 'tunnel-agent',
      hostname: 'tunnel-host',
      os: 'linux test',
      arch: 'amd64',
      version: 'test',
      tags: [],
      enrollmentToken: 'enroll',
      jobs: [],
    }),
  );
  await waitForMessage(agent, (msg) => msg.type === 'hello_ack');

  const streams = new Map();
  agent.on('message', (raw, isBinary) => {
    if (!isBinary) return;
    const frame = decodeStreamFrame(raw);
    if (!frame) return;
    if (frame.type === STREAM.OPEN) {
      const request = JSON.parse(frame.payload.toString());
      const socket = net.connect(request.port, request.host);
      socket.once('connect', () => {
        agent.send(encodeStreamFrame(STREAM.OPEN_OK, frame.streamId), { binary: true });
      });
      socket.on('data', (data) => {
        agent.send(encodeStreamFrame(STREAM.DATA, frame.streamId, data), { binary: true });
      });
      socket.on('close', () => {
        agent.send(encodeStreamFrame(STREAM.CLOSE, frame.streamId), { binary: true });
      });
      socket.on('error', () => {
        agent.send(encodeStreamFrame(STREAM.CLOSE, frame.streamId), { binary: true });
      });
      streams.set(frame.streamId, socket);
    } else if (frame.type === STREAM.DATA) {
      streams.get(frame.streamId)?.write(frame.payload);
    } else if (frame.type === STREAM.CLOSE) {
      streams.get(frame.streamId)?.end();
      streams.delete(frame.streamId);
    }
  });
  agent.on('close', () => {
    for (const socket of streams.values()) socket.destroy();
    streams.clear();
  });
  return { agent, streams };
}

async function connectTunnel(port, token = 'tunnel-token') {
  const tunnel = new WebSocket(`ws://127.0.0.1:${port}/agent/tunnel?clientId=tunnel-agent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((resolve, reject) => {
    tunnel.once('open', resolve);
    tunnel.once('error', reject);
  });
  return tunnel;
}

test('hub forwards a TCP stream through the agent tunnel', async (t) => {
  const { server: echo, port: echoPort } = await startEchoServer();
  const { hub, port } = await startTestHub();
  t.after(async () => {
    await hub.close();
    if (typeof echo.closeAllConnections === 'function') echo.closeAllConnections();
    echo.close();
  });

  const { agent } = await connectFakeAgent(port);
  t.after(() => agent.close());
  const tunnel = await connectTunnel(port);
  t.after(() => tunnel.close());

  tunnel.send(
    encodeStreamFrame(
      STREAM.OPEN,
      7,
      Buffer.from(JSON.stringify({ host: '127.0.0.1', port: echoPort, localPort: 13306 })),
    ),
    { binary: true },
  );
  await waitForFrame(tunnel, (frame) => frame.type === STREAM.OPEN_OK && frame.streamId === 7);

  tunnel.send(encodeStreamFrame(STREAM.DATA, 7, Buffer.from('hello tunnel')), { binary: true });
  const data = await waitForFrame(tunnel, (frame) => frame.type === STREAM.DATA && frame.streamId === 7);
  assert.equal(data.payload.toString(), 'hello tunnel');

  tunnel.send(encodeStreamFrame(STREAM.CLOSE, 7), { binary: true });
});

test('hub rejects tunnel targets outside the allowlist', async (t) => {
  const { hub, port } = await startTestHub();
  t.after(() => hub.close());
  const { agent } = await connectFakeAgent(port);
  t.after(() => agent.close());
  const tunnel = await connectTunnel(port);
  t.after(() => tunnel.close());

  tunnel.send(
    encodeStreamFrame(STREAM.OPEN, 9, Buffer.from(JSON.stringify({ host: '8.8.8.8', port: 53 }))),
    { binary: true },
  );
  const fail = await waitForFrame(tunnel, (frame) => frame.type === STREAM.OPEN_FAIL && frame.streamId === 9);
  assert.match(fail.payload.toString(), /not in the allowed CIDRs/);
});

test('hub rejects a bad tunnel token', async (t) => {
  const { hub, port } = await startTestHub();
  t.after(() => hub.close());
  const tunnel = new WebSocket(`ws://127.0.0.1:${port}/agent/tunnel?clientId=tunnel-agent`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  const code = await new Promise((resolve) => tunnel.once('close', resolve));
  assert.equal(code, 4003);
});
