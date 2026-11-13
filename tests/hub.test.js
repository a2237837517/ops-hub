import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { startHub } from '../src/hub/server.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timeout waiting for ws message'));
    }, timeoutMs);
    function onMessage(raw) {
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

test('hub accepts an agent and executes a job end-to-end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-e2e-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
      security: { allowedUploadRoots: [path.join(dir, 'staging')] },
    }),
  );
  const config = loadConfig(configFile);
  const hub = await startHub(config);
  const port = hub.address.port;
  const base = `http://127.0.0.1:${port}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  t.after(async () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    await hub.close();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      clientId: 'test-agent',
      name: 'test-agent',
      hostname: 'test-host',
      os: 'linux test',
      arch: 'amd64',
      version: '0.1.0',
      tags: ['test'],
      enrollmentToken: 'enroll',
      jobs: [],
    }),
  );
  const ack = await waitForMessage(ws, (msg) => msg.type === 'hello_ack');
  assert.equal(ack.clientId, 'test-agent');
  assert.ok(ack.agentToken);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'rpc' && msg.method === 'client.info') {
      ws.send(
        JSON.stringify({
          type: 'rpc_result',
          requestId: msg.requestId,
          ok: true,
          result: { hostname: 'test-host', os: 'linux test' },
        }),
      );
    }
    if (msg.type === 'exec.start') {
      const data = Buffer.from('fake output\n', 'utf8');
      ws.send(JSON.stringify({ type: 'exec.started', jobId: msg.jobId, pid: 123 }));
      ws.send(
        JSON.stringify({
          type: 'exec.chunk',
          jobId: msg.jobId,
          offset: 0,
          endOffset: data.length + 13,
          seq: 0,
          stream: 'stdout',
          data: data.toString('base64'),
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'exec.exit',
          jobId: msg.jobId,
          exitCode: 0,
          endedAt: new Date().toISOString(),
        }),
      );
    }
  });

  const response = await fetch(`${base}/api/clients/test-agent/exec`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo fake output', shell: 'bash' }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  const jobId = created.job.id;

  let output;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${base}/api/jobs/${jobId}/output?offset=0`, {
      headers: { Authorization: 'Bearer admin' },
    });
    output = await res.json();
    if (['exited', 'failed'].includes(output.job.status)) break;
    await sleep(50);
  }
  assert.equal(output.job.status, 'exited');
  assert.match(output.text, /fake output/);
});

test('MCP endpoint rejects missing token and lists tools with token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-mcp-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
    }),
  );
  const config = loadConfig(configFile);
  const hub = await startHub(config);
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address.port}`;

  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer mcp',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /ops_exec/);
  assert.match(text, /ops_tail_file/);
});

async function connectAgent(port, hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, jobs: [], ...hello }));
  return ws;
}

test('hub rejects the same clientId from a different machine', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-conflict-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
    }),
  );
  const hub = await startHub(loadConfig(configFile));
  t.after(() => hub.close());
  const port = hub.address.port;

  const first = await connectAgent(port, {
    clientId: 'conflict-agent',
    hostname: 'host-a',
    machineId: 'key-a',
    machineFingerprint: 'fp-a',
    enrollmentToken: 'enroll',
  });
  t.after(() => first.close());
  const ack = await waitForMessage(first, (msg) => msg.type === 'hello_ack');

  const second = await connectAgent(port, {
    clientId: 'conflict-agent',
    hostname: 'host-b',
    machineId: 'key-b',
    machineFingerprint: 'fp-b',
    enrollmentToken: 'enroll',
    agentToken: ack.agentToken,
  });
  t.after(() => second.close());

  const error = await waitForMessage(second, (msg) => msg.type === 'hello_error');
  assert.match(error.message, /another machine/);
  assert.equal(first.readyState, WebSocket.OPEN);
});

test('hub replaces the previous connection for the same machine', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-replace-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
    }),
  );
  const hub = await startHub(loadConfig(configFile));
  t.after(() => hub.close());
  const port = hub.address.port;

  const first = await connectAgent(port, {
    clientId: 'replace-agent',
    hostname: 'host-a',
    machineId: 'key-same',
    machineFingerprint: 'fp-same',
    enrollmentToken: 'enroll',
  });
  t.after(() => first.close());
  const ack = await waitForMessage(first, (msg) => msg.type === 'hello_ack');

  const closed = new Promise((resolve) => first.once('close', (code) => resolve(code)));
  const second = await connectAgent(port, {
    clientId: 'replace-agent',
    hostname: 'host-a',
    machineId: 'key-same',
    machineFingerprint: 'fp-same',
    enrollmentToken: 'enroll',
    agentToken: ack.agentToken,
  });
  t.after(() => second.close());
  await waitForMessage(second, (msg) => msg.type === 'hello_ack');

  assert.equal(await closed, 4001);
});


test('hub reissues a token when the same machine lost its state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-recover-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
    }),
  );
  const hub = await startHub(loadConfig(configFile));
  t.after(() => hub.close());
  const port = hub.address.port;

  const first = await connectAgent(port, {
    clientId: 'recover-agent',
    hostname: 'host-r',
    machineId: 'key-r',
    machineFingerprint: 'fp-r',
    enrollmentToken: 'enroll',
  });
  t.after(() => first.close());
  const firstAck = await waitForMessage(first, (msg) => msg.type === 'hello_ack');

  const second = await connectAgent(port, {
    clientId: 'recover-agent',
    hostname: 'host-r',
    machineId: 'key-r',
    machineFingerprint: 'fp-r',
    enrollmentToken: 'enroll',
  });
  t.after(() => second.close());
  const secondAck = await waitForMessage(second, (msg) => msg.type === 'hello_ack');
  assert.ok(secondAck.agentToken);
  assert.notEqual(secondAck.agentToken, firstAck.agentToken);
});
