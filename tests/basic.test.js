import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { encodeCursor, decodeCursor, isDangerousCommand } from '../src/protocol.js';
import { Store } from '../src/store.js';

test('config loads, merges defaults and creates data dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      hub: { port: 17100, dataDir: path.join(dir, 'data'), host: '127.0.0.1' },
      auth: { enrollmentToken: 'e', mcpToken: 'm', adminToken: 'a' },
      security: { allowedUploadRoots: [path.join(dir, 'staging')] },
    }),
  );
  const config = loadConfig(file);
  assert.equal(config.hub.port, 17100);
  assert.equal(config.limits.maxReadBytes, 256 * 1024);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'jobs')));
  assert.ok(fs.existsSync(path.join(dir, 'data', 'staging')));
});

test('cursor round trip and dangerous command detection', () => {
  const cursor = { offset: 42, fileId: '1:2', pending: 'abc' };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(isDangerousCommand('shutdown /s /t 0', ['shutdown']), true);
  assert.equal(isDangerousCommand('Get-Service ops-*', ['shutdown']), false);
});

test('store persists agents, jobs and audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-store-'));
  const store = new Store(dir, { error() {} });
  store.upsertAgent({ id: 'a1', name: 'agent-1', tokenHash: 'x' });
  assert.equal(store.getAgent('a1').name, 'agent-1');
  assert.equal(store.findAgent('agent-1').id, 'a1');

  const output = path.join(dir, 'job.log');
  fs.writeFileSync(output, 'hello');
  store.createJob({ id: 'j1', clientId: 'a1', createdAt: new Date().toISOString(), outputPath: output });
  store.updateJob('j1', { status: 'exited' });
  assert.equal(store.getJob('j1').status, 'exited');
  store.audit('exec.start', { jobId: 'j1' });
  assert.equal(store.listAudit(10)[0].action, 'exec.start');

  store.flush();
  const reloaded = new Store(dir, { error() {} });
  assert.equal(reloaded.getAgent('a1').name, 'agent-1');
  assert.equal(reloaded.getJob('j1').status, 'exited');
});
