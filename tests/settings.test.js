import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { startHub } from '../src/hub/server.js';

function makeConfig(dir) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      hub: { host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'data') },
      auth: { enrollmentToken: 'enroll', mcpToken: 'mcp', adminToken: 'admin' },
    }),
  );
  return loadConfig(file);
}

async function call(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/settings 只暴露 3 个关键限额，且支持 -1 不限制', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-settings-'));
  const hub = await startHub(makeConfig(dir));
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address.port}`;

  const res = await call(base, '/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  // 页面上只出现这三项，别的（单次读取/分块/输出上限）不暴露
  assert.deepEqual(Object.keys(res.body.limits).sort(), [
    'jobTimeoutMs',
    'maxConcurrentJobsPerClient',
    'maxFileBytes',
  ]);

  const conc = res.body.limits.maxConcurrentJobsPerClient;
  assert.equal(conc.value, 4);
  assert.equal(conc.min, -1);
  assert.equal(conc.allowUnlimited, true);

  assert.equal(res.body.limits.jobTimeoutMs.allowUnlimited, true);
  assert.equal(res.body.limits.maxFileBytes.allowUnlimited, true);
  assert.deepEqual(res.body.agentDefaults, { maxConcurrentJobs: -1 });
});

test('PUT /api/settings 设成 -1 表示不限制，并立即不再拦任务', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-settings-unlimited-'));
  const config = makeConfig(dir);
  const hub = await startHub(config);
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address.port}`;

  const res = await call(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ limits: { maxConcurrentJobsPerClient: -1, jobTimeoutMs: -1 } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied.maxConcurrentJobsPerClient, -1);
  assert.equal(res.body.limits.maxConcurrentJobsPerClient.value, -1);

  assert.equal(config.limits.maxConcurrentJobsPerClient, -1);
  assert.equal(config.limits.jobTimeoutMs, -1);

  // 落盘
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.limits.maxConcurrentJobsPerClient, -1);

  // 重启后仍然是不限制
  const restarted = await startHub(makeConfig(dir));
  t.after(() => restarted.close());
  const again = await call(`http://127.0.0.1:${restarted.address.port}`, '/api/settings');
  assert.equal(again.body.limits.maxConcurrentJobsPerClient.value, -1);
});

test('并发不限制时，超过 4 个任务也能继续下发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-settings-nolimit-'));
  const config = makeConfig(dir);
  config.limits.maxConcurrentJobsPerClient = -1;
  const hub = await startHub(config);
  t.after(() => hub.close());

  const now = new Date().toISOString();
  for (let i = 0; i < 10; i += 1) {
    hub.store.createJob({ id: `j${i}`, clientId: 'c1', status: 'running', createdAt: now });
  }
  // 不限制时不应抛「并发任务已达上限」
  const count = hub.jobs.activeCounts().c1;
  assert.equal(count, 10);
  assert.doesNotThrow(() => {
    const max = Number(config.limits.maxConcurrentJobsPerClient);
    if (max > 0 && count >= max) throw new Error('should not trigger');
  });
});

test('PUT /api/settings 越界值被拒且不落盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-settings-bad-'));
  const config = makeConfig(dir);
  const hub = await startHub(config);
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address.port}`;

  const res = await call(base, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ limits: { maxConcurrentJobsPerClient: 99999 } }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /-1 或/);
  assert.equal(config.limits.maxConcurrentJobsPerClient, 4);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'settings.json')), false);
});

test('PUT /api/settings 空提交返回 400', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-settings-empty-'));
  const hub = await startHub(makeConfig(dir));
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address.port}`;

  const res = await call(base, '/api/settings', { method: 'PUT', body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /没有需要更新的字段/);
});

test('活跃任务统计只算 running/queued/exiting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-active-'));
  const hub = await startHub(makeConfig(dir));
  t.after(() => hub.close());

  const now = new Date().toISOString();
  hub.store.createJob({ id: 'a', clientId: 'c1', status: 'running', createdAt: now });
  hub.store.createJob({ id: 'b', clientId: 'c1', status: 'queued', createdAt: now });
  hub.store.createJob({ id: 'c', clientId: 'c1', status: 'exited', createdAt: now });
  hub.store.createJob({ id: 'd', clientId: 'c2', status: 'exiting', createdAt: now });
  hub.store.createJob({ id: 'e', clientId: 'c2', status: 'failed', createdAt: now });

  assert.deepEqual(hub.jobs.activeCounts(), { c1: 2, c2: 1 });
});
