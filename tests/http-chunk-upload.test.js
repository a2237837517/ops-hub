import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { startHub } from '../src/hub/server.js';

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

async function startTestHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-http-chunk-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
      security: { allowedUploadRoots: [path.join(dir, 'data', 'staging')] },
      limits: { maxFileBytes: 10 * 1024 * 1024 },
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
      clientId: 'chunk-agent',
      hostname: 'chunk-host',
      os: 'linux test',
      arch: 'amd64',
      version: 'test',
      tags: [],
      enrollmentToken: 'enroll',
      jobs: [],
    }),
  );
  await waitForMessage(agent, (msg) => msg.type === 'hello_ack');

  const uploads = new Map();
  agent.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'file.upload.start') {
      uploads.set(msg.transferId, { size: msg.size, chunks: [], received: 0 });
      agent.send(JSON.stringify({ type: 'file.upload.ready', transferId: msg.transferId }));
      return;
    }
    if (msg.type === 'file.upload.chunk') {
      const upload = uploads.get(msg.transferId);
      if (!upload) return;
      const chunk = Buffer.from(msg.data, 'base64');
      upload.chunks.push(chunk);
      upload.received = msg.offset + chunk.length;
      agent.send(
        JSON.stringify({
          type: 'file.upload.ack',
          transferId: msg.transferId,
          received: upload.received,
        }),
      );
      if (upload.received >= upload.size) {
        const full = Buffer.concat(upload.chunks);
        const sha256 = crypto.createHash('sha256').update(full).digest('hex');
        setTimeout(() => {
          agent.send(
            JSON.stringify({
              type: 'file.upload.done',
              transferId: msg.transferId,
              size: full.length,
              sha256,
            }),
          );
        }, 50);
      }
    }
  });
  return { agent, uploads };
}

function authHeaders(extra = {}) {
  return { Authorization: 'Bearer admin', ...extra };
}

test('http chunked upload reaches the agent intact', async (t) => {
  const { hub, port } = await startTestHub();
  t.after(() => hub.close());
  const { agent, uploads } = await connectFakeAgent(port);
  t.after(() => agent.close());

  const data = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const base = `http://127.0.0.1:${port}`;
  const client = 'chunk-agent';

  const initResponse = await fetch(`${base}/api/clients/${client}/files/upload/init`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ path: '/tmp/remote.bin', size: data.length }),
  });
  assert.equal(initResponse.status, 200);
  const init = await initResponse.json();
  assert.ok(init.uploadId);
  assert.equal(init.chunkSize, 8 * 1024 * 1024);

  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + init.chunkSize, data.length);
    const chunkResponse = await fetch(
      `${base}/api/clients/${client}/files/upload/chunk?uploadId=${init.uploadId}&offset=${offset}`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: data.subarray(offset, end),
      },
    );
    assert.equal(chunkResponse.status, 200);
    const chunk = await chunkResponse.json();
    assert.equal(chunk.received, end);
    offset = end;
  }

  const completeResponse = await fetch(`${base}/api/clients/${client}/files/upload/complete`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ uploadId: init.uploadId, overwrite: true }),
  });
  assert.equal(completeResponse.status, 200);
  const complete = await completeResponse.json();
  assert.equal(complete.size, data.length);
  assert.equal(complete.sha256, crypto.createHash('sha256').update(data).digest('hex'));
});

test('http chunked upload reports the confirmed offset on mismatch', async (t) => {
  const { hub, port } = await startTestHub();
  t.after(() => hub.close());
  const { agent } = await connectFakeAgent(port);
  t.after(() => agent.close());

  const base = `http://127.0.0.1:${port}`;
  const client = 'chunk-agent';
  const initResponse = await fetch(`${base}/api/clients/${client}/files/upload/init`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ path: '/tmp/remote2.bin', size: 100 }),
  });
  const init = await initResponse.json();

  const first = await fetch(
    `${base}/api/clients/${client}/files/upload/chunk?uploadId=${init.uploadId}&offset=10`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: Buffer.from('0123456789'),
    },
  );
  assert.equal(first.status, 409);
  const body = await first.json();
  assert.equal(body.received, 0);
});
