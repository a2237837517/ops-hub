import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function randomId(prefix = '') {
  const id = crypto.randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file';
}

export function isWithin(root, target) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  return targetResolved === rootResolved || targetResolved.startsWith(rootResolved + path.sep);
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(n) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return { text: String(text ?? ''), truncated: false };
  let end = maxBytes;
  // 不要切断 UTF-8 多字节字符
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export class Logger {
  constructor({ level = 'info', file = null, maxBytes = 10 * 1024 * 1024, maxBackups = 9 } = {}) {
    this.level = level;
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxBackups = maxBackups;
    this.currentSize = 0;
    this.levels = { debug: 10, info: 20, warn: 30, error: 40 };
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        this.currentSize = fs.statSync(file).size;
      } catch {
        this.currentSize = 0;
      }
    }
  }

  _rotate() {
    if (!this.file) return;
    try {
      fs.unlinkSync(`${this.file}.${this.maxBackups + 1}`);
    } catch {
      // ignore
    }
    for (let i = this.maxBackups - 1; i >= 1; i -= 1) {
      try {
        fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      } catch {
        // ignore missing backup
      }
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // ignore
    }
    this.currentSize = 0;
  }

  _write(level, args) {
    if ((this.levels[level] || 20) < (this.levels[this.level] || 20)) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')}`;
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(line);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, line + '\n');
        this.currentSize += Buffer.byteLength(line + '\n');
        if (this.currentSize >= this.maxBytes) this._rotate();
      } catch {
        // never let logging break the hub
      }
    }
  }

  debug(...args) { this._write('debug', args); }
  info(...args) { this._write('info', args); }
  warn(...args) { this._write('warn', args); }
  error(...args) { this._write('error', args); }
}
