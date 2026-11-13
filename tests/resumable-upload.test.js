import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  appendChunk,
  cleanupStaleUploads,
  completeUpload,
  createUpload,
} from '../src/hub/resumable-upload.js';

function testConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-chunk-'));
  return {
    dir,
    config: {
      hub: { dataDir: dir },
      limits: { maxFileBytes: 1024 * 1024 },
    },
  };
}

test('chunked upload appends, resumes and completes', async () => {
  const { config } = testConfig();
  const init = createUpload({
    config,
    clientId: 'client-a',
    remotePath: 'C:\\tmp\\a.bin',
    size: 11,
  });
  assert.ok(init.uploadId);
  assert.equal(init.chunkSize, 8 * 1024 * 1024);

  const first = await appendChunk({
    config,
    clientId: 'client-a',
    uploadId: init.uploadId,
    offset: 0,
    stream: Readable.from([Buffer.from('hello ')]),
  });
  assert.equal(first.received, 6);

  await assert.rejects(
    appendChunk({
      config,
      clientId: 'client-a',
      uploadId: init.uploadId,
      offset: 0,
      stream: Readable.from([Buffer.from('x')]),
    }),
    (error) => error.status === 409 && error.received === 6,
  );

  const second = await appendChunk({
    config,
    clientId: 'client-a',
    uploadId: init.uploadId,
    offset: 6,
    stream: Readable.from([Buffer.from('world')]),
  });
  assert.equal(second.received, 11);

  let uploadedPath = '';
  let uploadedContent = '';
  const result = await completeUpload({
    config,
    clientId: 'client-a',
    uploadId: init.uploadId,
    overwrite: true,
    files: {
      upload: async (_clientId, options) => {
        uploadedPath = options.localPath;
        uploadedContent = fs.readFileSync(options.localPath, 'utf8');
        return { size: fs.statSync(options.localPath).size };
      },
    },
  });
  assert.equal(result.size, 11);
  assert.equal(uploadedContent, 'hello world');
  assert.equal(fs.existsSync(uploadedPath), false);
});

test('chunked upload rejects another client and incomplete files', async () => {
  const { config } = testConfig();
  const init = createUpload({
    config,
    clientId: 'client-a',
    remotePath: '/tmp/a.bin',
    size: 4,
  });

  await assert.rejects(
    appendChunk({
      config,
      clientId: 'client-b',
      uploadId: init.uploadId,
      offset: 0,
      stream: Readable.from([Buffer.from('abcd')]),
    }),
    (error) => error.status === 403,
  );

  await assert.rejects(
    completeUpload({
      config,
      clientId: 'client-a',
      uploadId: init.uploadId,
      overwrite: true,
      files: { upload: async () => ({}) },
    }),
    (error) => error.status === 409 && error.received === 0,
  );
});

test('chunked upload enforces maxFileBytes and cleans stale files', () => {
  const { config } = testConfig();
  assert.throws(
    () =>
      createUpload({
        config,
        clientId: 'client-a',
        remotePath: '/tmp/a.bin',
        size: 2 * 1024 * 1024,
      }),
    (error) => error.status === 413,
  );

  const init = createUpload({
    config,
    clientId: 'client-a',
    remotePath: '/tmp/a.bin',
    size: 10,
  });
  const staging = path.join(config.hub.dataDir, 'staging');
  const old = Date.now() / 1000 - 48 * 60 * 60;
  for (const name of fs.readdirSync(staging)) {
    fs.utimesSync(path.join(staging, name), old, old);
  }
  const removed = cleanupStaleUploads(config);
  assert.ok(removed >= 2);
  assert.equal(fs.existsSync(path.join(staging, `${init.uploadId}.json`)), false);
});
