import fs from 'node:fs';
import path from 'node:path';
import { MSG, TRANSFER_STATUS } from '../protocol.js';
import {
  clamp,
  isWithin,
  nowIso,
  randomId,
  safeFileName,
  sha256File,
} from '../utils.js';

export class FileManager {
  constructor({ gateway, store, config, logger }) {
    this.gateway = gateway;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.eventWaiters = [];
    this.downloadFds = new Map();

    const events = [
      MSG.FILE_UPLOAD_READY,
      MSG.FILE_UPLOAD_ACK,
      MSG.FILE_UPLOAD_DONE,
      MSG.FILE_UPLOAD_ERROR,
      MSG.FILE_DOWNLOAD_DONE,
      MSG.FILE_DOWNLOAD_ERROR,
    ];
    for (const event of events) {
      gateway.on(event, (clientId, msg) => this._onEvent(event, clientId, msg));
    }
    gateway.on(MSG.FILE_DOWNLOAD_CHUNK, (clientId, msg) => this._onDownloadChunk(clientId, msg));
    gateway.on('agent:offline', (clientId) => this._onAgentOffline(clientId));
  }

  _onAgentOffline(clientId) {
    for (let i = this.eventWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.eventWaiters[i];
      if (waiter.clientId !== clientId) continue;
      this.eventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`客户端已离线: ${clientId}`));
    }
  }

  _onEvent(event, clientId, msg) {
    for (let i = this.eventWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.eventWaiters[i];
      if (waiter.transferId !== msg.transferId) continue;
      if (event.endsWith('.error')) {
        this.eventWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(msg.message || 'transfer error'));
        continue;
      }
      if (waiter.event !== event) continue;
      this.eventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  _wait(transferId, event, timeoutMs = 60_000) {
    const transfer = this.store.getTransfer(transferId);
    const clientId = transfer?.clientId || null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.eventWaiters.findIndex((w) => w.transferId === transferId && w.event === event);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`文件传输等待超时: ${event}`));
      }, timeoutMs);
      timer.unref?.();
      this.eventWaiters.push({ transferId, clientId, event, resolve, reject, timer });
    });
  }

  _resolveLocalUpload(localPath) {
    const raw = String(localPath || '');
    let resolved;
    if (path.isAbsolute(raw)) {
      resolved = path.resolve(raw);
    } else {
      const direct = path.resolve(this.config.__root || process.cwd(), raw);
      if (fs.existsSync(direct)) {
        resolved = direct;
      } else {
        resolved = path.resolve(this.config.hub.dataDir, 'staging', raw);
      }
    }
    const allowed = this.config.security.allowedUploadRoots || [];
    if (allowed.length && !allowed.some((root) => isWithin(root, resolved))) {
      throw new Error(`本地文件不在允许的上传目录内: ${resolved}`);
    }
    return resolved;
  }

  async upload(clientId, { localPath, remotePath, overwrite = false, createDirs = true, actor = 'unknown' }) {
    if (!this.gateway.isOnline(clientId)) throw new Error(`客户端不在线: ${clientId}`);
    const local = this._resolveLocalUpload(localPath);
    const stat = fs.statSync(local);
    if (!stat.isFile()) throw new Error(`不是普通文件: ${local}`);
    if (stat.size > this.config.limits.maxFileBytes) {
      throw new Error(`文件超过上限 ${this.config.limits.maxFileBytes} 字节`);
    }
    const transferId = randomId('up');
    const transfer = {
      id: transferId,
      clientId,
      direction: 'upload',
      localPath: local,
      remotePath,
      size: stat.size,
      offset: 0,
      sha256: null,
      status: TRANSFER_STATUS.RUNNING,
      createdAt: nowIso(),
      actor,
    };
    this.store.createTransfer(transfer);
    this.store.audit('file.upload.start', { transferId, clientId, localPath: local, remotePath, size: stat.size, actor });

    try {
      const sha256 = await sha256File(local);
      transfer.sha256 = sha256;
      this.store.updateTransfer(transferId, { sha256 });
      const ready = this._wait(transferId, MSG.FILE_UPLOAD_READY, 30_000);
      this.gateway.send(clientId, {
        type: MSG.FILE_UPLOAD_START,
        transferId,
        path: remotePath,
        size: stat.size,
        sha256,
        overwrite,
        createDirs,
      });
      await ready;

      const chunkSize = this.config.limits.maxChunkBytes;
      const fd = fs.openSync(local, 'r');
      try {
        let offset = 0;
        while (offset < stat.size) {
          const len = Math.min(chunkSize, stat.size - offset);
          const buf = Buffer.alloc(len);
          const read = fs.readSync(fd, buf, 0, len, offset);
          if (read <= 0) break;
          const data = buf.subarray(0, read);
          const sent = this.gateway.send(clientId, {
            type: MSG.FILE_UPLOAD_CHUNK,
            transferId,
            offset,
            data: data.toString('base64'),
          });
          if (!sent) throw new Error('客户端已断开');
          const ack = await this._wait(transferId, MSG.FILE_UPLOAD_ACK, 300_000);
          offset = Number(ack.received ?? offset + read);
          this.store.updateTransfer(transferId, { offset });
          await this._throttle(read);
        }
      } finally {
        fs.closeSync(fd);
      }

      const done = await this._wait(transferId, MSG.FILE_UPLOAD_DONE, 120_000);
      if (done.size != null && Number(done.size) !== stat.size) {
        throw new Error(`上传后大小不一致: ${done.size} != ${stat.size}`);
      }
      if (done.sha256 && done.sha256 !== sha256) {
        throw new Error('上传后 sha256 不一致');
      }
      this.store.updateTransfer(transferId, {
        status: TRANSFER_STATUS.DONE,
        offset: stat.size,
        finishedAt: nowIso(),
      });
      this.store.audit('file.upload.done', { transferId, clientId, remotePath, size: stat.size, sha256 });
      return { transferId, size: stat.size, sha256, remotePath };
    } catch (error) {
      this.store.updateTransfer(transferId, {
        status: TRANSFER_STATUS.FAILED,
        error: error.message,
        finishedAt: nowIso(),
      });
      this.store.audit('file.upload.failed', { transferId, clientId, error: error.message });
      throw error;
    }
  }

  _resolveLocalDownload(localPath, clientId, remotePath) {
    const baseDir = path.join(this.config.hub.dataDir, 'downloads', clientId);
    if (!localPath) {
      return path.join(baseDir, `${Date.now()}_${safeFileName(path.basename(String(remotePath)))}`);
    }
    const raw = String(localPath);
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
    if (!isWithin(baseDir, resolved)) {
      throw new Error(`下载保存路径必须在 ${baseDir} 内: ${resolved}`);
    }
    return resolved;
  }

  async download(clientId, { remotePath, localPath = null, overwrite = true, actor = 'unknown' }) {
    if (!this.gateway.isOnline(clientId)) throw new Error(`客户端不在线: ${clientId}`);
    const transferId = randomId('down');
    const dir = path.join(this.config.hub.dataDir, 'downloads', clientId);
    fs.mkdirSync(dir, { recursive: true });
    const target = this._resolveLocalDownload(localPath, clientId, remotePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part-${transferId}`;

    const transfer = {
      id: transferId,
      clientId,
      direction: 'download',
      remotePath,
      localPath: target,
      offset: 0,
      size: null,
      sha256: null,
      status: TRANSFER_STATUS.RUNNING,
      createdAt: nowIso(),
      actor,
    };
    this.store.createTransfer(transfer);
    this.store.audit('file.download.start', { transferId, clientId, remotePath, localPath: target, actor });

    const fd = fs.openSync(part, 'w');
    this.downloadFds.set(transferId, fd);
    try {
      const donePromise = this._wait(transferId, MSG.FILE_DOWNLOAD_DONE, 24 * 60 * 60 * 1000);
      this.gateway.send(clientId, {
        type: MSG.FILE_DOWNLOAD_START,
        transferId,
        path: remotePath,
        offset: 0,
      });
      const done = await donePromise;
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      this.downloadFds.delete(transferId);
      const size = fs.statSync(part).size;
      if (done.size != null && Number(done.size) !== size) {
        throw new Error(`下载后大小不一致: ${done.size} != ${size}`);
      }
      const sha256 = await sha256File(part);
      if (done.sha256 && done.sha256 !== sha256) {
        throw new Error('下载后 sha256 不一致');
      }
      if (!overwrite && fs.existsSync(target)) throw new Error(`目标文件已存在: ${target}`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(part, target);
      this.store.updateTransfer(transferId, {
        status: TRANSFER_STATUS.DONE,
        size,
        sha256,
        offset: size,
        finishedAt: nowIso(),
      });
      this.store.audit('file.download.done', { transferId, clientId, remotePath, localPath: target, size, sha256 });
      return { transferId, size, sha256, localPath: target, remotePath };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      this.downloadFds.delete(transferId);
      try {
        fs.unlinkSync(part);
      } catch {
        // ignore
      }
      this.store.updateTransfer(transferId, {
        status: TRANSFER_STATUS.FAILED,
        error: error.message,
        finishedAt: nowIso(),
      });
      this.store.audit('file.download.failed', { transferId, clientId, error: error.message });
      throw error;
    }
  }

  async _throttle(bytes) {
    const kbps = Number(this.config.limits.maxTransferKBps) || 0;
    if (kbps <= 0 || bytes <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil((bytes / 1024 / kbps) * 1000)));
  }

  _onDownloadChunk(clientId, msg) {
    const transfer = this.store.getTransfer(msg.transferId);
    if (!transfer || transfer.clientId !== clientId || transfer.direction !== 'download') return;
    const fd = this.downloadFds.get(transfer.id);
    if (fd == null) {
      this.gateway.send(clientId, {
        type: MSG.FILE_DOWNLOAD_ERROR,
        transferId: transfer.id,
        message: 'transfer no longer active',
      });
      return;
    }
    try {
      const data = Buffer.from(String(msg.data || ''), 'base64');
      fs.writeSync(fd, data, 0, data.length, Number(msg.offset));
      this.store.updateTransfer(transfer.id, { offset: Number(msg.offset) + data.length });
      this.gateway.send(clientId, {
        type: MSG.FILE_DOWNLOAD_ACK,
        transferId: transfer.id,
        offset: Number(msg.offset) + data.length,
      });
    } catch (error) {
      this.gateway.send(clientId, {
        type: MSG.FILE_DOWNLOAD_ERROR,
        transferId: transfer.id,
        message: error.message,
      });
    }
  }

  readFile(clientId, params) {
    this.store.audit('file.read', { clientId, path: params.path, offset: params.offset, encoding: params.encoding });
    return this.gateway.rpc(clientId, 'file.read', params, 30_000);
  }

  tailFile(clientId, params) {
    this.store.audit('file.tail', { clientId, path: params.path, lines: params.lines });
    return this.gateway.rpc(clientId, 'file.tail', params, 30_000);
  }

  searchFile(clientId, params) {
    this.store.audit('file.search', { clientId, path: params.path, pattern: params.pattern });
    return this.gateway.rpc(clientId, 'file.search', params, 60_000);
  }

  listDir(clientId, params) {
    this.store.audit('file.list', { clientId, path: params.path });
    return this.gateway.rpc(clientId, 'file.list', params, 30_000);
  }

  statFile(clientId, params) {
    this.store.audit('file.stat', { clientId, path: params.path, hash: params.hash });
    return this.gateway.rpc(clientId, 'file.stat', params, 60_000);
  }

  writeFile(clientId, params) {
    this.store.audit('file.write', {
      clientId,
      path: params.path,
      encoding: params.encoding,
      append: params.append,
      bytes: Buffer.byteLength(String(params.content || ''), 'utf8'),
    });
    return this.gateway.rpc(clientId, 'file.write', params, 60_000);
  }

  deletePath(clientId, params) {
    this.store.audit('file.delete', {
      clientId,
      path: params.path,
      recursive: Boolean(params.recursive),
    });
    return this.gateway.rpc(clientId, 'file.delete', params, 60_000);
  }

  clientInfo(clientId, params = {}) {
    return this.gateway.rpc(clientId, 'client.info', params, 30_000);
  }

  clientStats(clientId, params = {}) {
    return this.gateway.rpc(clientId, 'client.stats', params, 30_000);
  }

  clampReadBytes(value) {
    return clamp(value || 64 * 1024, 1024, this.config.limits.maxReadBytes);
  }
}
