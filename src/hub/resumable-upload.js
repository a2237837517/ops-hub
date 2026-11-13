import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomId } from '../utils.js';

// 浏览器分片上传：每片 8MB，单请求最多 32MB。
// 分片先写临时文件，确认完整后再追加到 .part，避免半截请求把文件写坏。
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;

const locks = new Map();

function stagingDir(config) {
  const dir = path.join(config.hub.dataDir, 'staging');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(config, id) {
  return path.join(stagingDir(config), `${id}.json`);
}

function partPath(config, id) {
  return path.join(stagingDir(config), `${id}.part`);
}

function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  next.finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  }).catch(() => {});
  return next;
}

export function cleanupStaleUploads(config, maxAgeMs = STALE_MS) {
  const dir = stagingDir(config);
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') && !name.endsWith('.part') && !name.endsWith('.tmp')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

function readMeta(config, id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(config, id), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(config, meta) {
  const target = metaPath(config, meta.id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, target);
}

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

export function createUpload({ config, clientId, remotePath, size }) {
  cleanupStaleUploads(config);
  const total = Number(size) || 0;
  if (!remotePath) throw httpError(400, 'path is required');
  if (total <= 0) throw httpError(400, 'size is required');
  if (total > config.limits.maxFileBytes) {
    throw httpError(413, `file exceeds maxFileBytes (${config.limits.maxFileBytes})`);
  }
  const id = randomId('up');
  const meta = {
    id,
    clientId,
    remotePath,
    size: total,
    received: 0,
    createdAt: Date.now(),
  };
  writeMeta(config, meta);
  fs.writeFileSync(partPath(config, id), Buffer.alloc(0));
  return {
    uploadId: id,
    chunkSize: UPLOAD_CHUNK_BYTES,
    maxChunkBytes: MAX_CHUNK_BYTES,
    size: total,
  };
}

export function appendChunk({ config, clientId, uploadId, offset, stream }) {
  return withLock(uploadId, async () => {
    const meta = readMeta(config, uploadId);
    if (!meta) throw httpError(404, 'upload not found');
    if (meta.clientId !== clientId) throw httpError(403, 'upload belongs to another client');
    if (!Number.isInteger(offset) || offset < 0) throw httpError(400, 'invalid offset');
    if (offset !== meta.received) {
      throw httpError(409, 'offset mismatch', { received: meta.received });
    }

    const part = partPath(config, uploadId);
    const tmp = `${part}.${offset}.tmp`;
    let written = 0;
    try {
      await pipeline(stream, fs.createWriteStream(tmp));
      written = fs.statSync(tmp).size;
      if (written === 0) throw httpError(400, 'empty chunk');
      if (written > MAX_CHUNK_BYTES) throw httpError(413, 'chunk too large');
      if (meta.received + written > meta.size) {
        throw httpError(413, 'chunk exceeds declared file size');
      }
      // 上一次异常中断可能让 .part 比 meta.received 长，先截断再追加。
      fs.truncateSync(part, meta.received);
      await pipeline(fs.createReadStream(tmp), fs.createWriteStream(part, { flags: 'a' }));
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }

    meta.received += written;
    writeMeta(config, meta);
    return { received: meta.received, size: meta.size };
  });
}

export async function completeUpload({ config, files, clientId, uploadId, overwrite }) {
  const meta = readMeta(config, uploadId);
  if (!meta) throw httpError(404, 'upload not found');
  if (meta.clientId !== clientId) throw httpError(403, 'upload belongs to another client');
  if (meta.received !== meta.size) {
    throw httpError(409, 'upload is incomplete', { received: meta.received, size: meta.size });
  }

  const result = await files.upload(meta.clientId, {
    localPath: partPath(config, uploadId),
    remotePath: meta.remotePath,
    overwrite: Boolean(overwrite),
    createDirs: true,
    actor: 'web',
  });

  try {
    fs.unlinkSync(partPath(config, uploadId));
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(metaPath(config, uploadId));
  } catch {
    // ignore
  }
  return result;
}
