import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../config/index.js';
import { safeFileName, sha256File, randomToken } from '../utils.js';

const PACKAGE_ROOT = path.join(PROJECT_ROOT, 'public', 'downloads');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function publicBaseUrl(config) {
  if (config.hub.publicBaseUrl) return String(config.hub.publicBaseUrl).replace(/\/+$/, '');
  try {
    const url = new URL(config.hub.publicUrl);
    url.protocol = 'https:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return 'https://mcp.example.com';
  }
}

function sourcePackage(os, arch) {
  if (os === 'windows') {
    if (!['amd64', '386'].includes(arch)) throw new Error(`不支持的 Windows 架构: ${arch}`);
    return {
      file: `ops-agent-windows-${arch}.zip`,
      kind: 'zip',
      outputExt: 'zip',
    };
  }
  if (os === 'linux') {
    if (!['amd64', 'arm64', '386'].includes(arch)) throw new Error(`不支持的 Linux 架构: ${arch}`);
    return {
      file: `ops-agent-linux-${arch}.tar.gz`,
      kind: 'tar',
      outputExt: 'tar.gz',
    };
  }
  throw new Error(`不支持的系统: ${os}`);
}

function ensurePackagesDir(config) {
  const dir = path.join(config.hub.dataDir, 'agent-packages');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupAgentPackages(config) {
  const dir = path.join(config.hub.dataDir, 'agent-packages');
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * Build a preconfigured Agent installer with config.json embedded.
 * Returns a time-limited private URL served by the Hub.
 */
export async function createAgentPackage(config, { os, arch, name = '', tags = [] } = {}) {
  const meta = sourcePackage(os, arch);
  const source = path.join(PACKAGE_ROOT, meta.file);
  if (!fs.existsSync(source)) {
    throw new Error(
      `安装包不存在: ${meta.file}。请先在项目目录运行 ./scripts/package-agent.sh 并重新构建 Hub 镜像。`,
    );
  }
  const packagesDir = ensurePackagesDir(config);
  const token = randomToken(24);
  const work = fs.mkdtempSync(path.join(packagesDir, 'tmp-'));
  const outputDir = path.join(packagesDir, token);
  const baseName = path.basename(meta.file).replace(/\.(zip|tar\.gz)$/i, '');
  const filename = `${baseName}-configured.${meta.outputExt}`;
  const outputPath = path.join(outputDir, filename);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    let extractedRoot = work;
    if (meta.kind === 'zip') {
      execFileSync('unzip', ['-q', source, '-d', work], { stdio: 'pipe', timeout: 30_000 });
    } else {
      execFileSync('tar', ['-xzf', source, '-C', work], { stdio: 'pipe', timeout: 30_000 });
      const entries = fs.readdirSync(work);
      if (entries.length === 1 && fs.statSync(path.join(work, entries[0])).isDirectory()) {
        extractedRoot = path.join(work, entries[0]);
      }
    }

    const agentConfig = {
      server: config.hub.publicUrl,
      enrollmentToken: config.auth.enrollmentToken,
      agentToken: '',
      clientId: '',
      name: String(name || '').slice(0, 120),
      tags: Array.isArray(tags) && tags.length ? tags.map(String).slice(0, 30) : [os],
      spoolDir: '',
      allowedRoots: [],
      maxSpoolMB: 2048,
      maxConcurrentJobs: 4,
      insecureSkipVerify: false,
      caFile: '',
      proxy: '',
      heartbeatIntervalSec: 15,
    };
    fs.writeFileSync(
      path.join(extractedRoot, 'config.json'),
      JSON.stringify(agentConfig, null, 2),
      { mode: 0o600 },
    );

    if (meta.kind === 'zip') {
      execFileSync('zip', ['-qr', outputPath, '.'], {
        cwd: extractedRoot,
        stdio: 'pipe',
        timeout: 60_000,
      });
    } else if (extractedRoot === work) {
      execFileSync('tar', ['-czf', outputPath, '-C', work, '.'], {
        stdio: 'pipe',
        timeout: 60_000,
      });
    } else {
      execFileSync(
        'tar',
        ['-czf', outputPath, '-C', work, path.basename(extractedRoot)],
        { stdio: 'pipe', timeout: 60_000 },
      );
    }

    const stat = fs.statSync(outputPath);
    const sha256 = await sha256File(outputPath);
    const base = publicBaseUrl(config);
    return {
      os,
      arch,
      filename,
      size: stat.size,
      sha256,
      downloadUrl: `${base}/downloads/private/${token}/${encodeURIComponent(filename)}`,
      expiresAt: new Date(Date.now() + MAX_AGE_MS).toISOString(),
      server: config.hub.publicUrl,
      note: '安装包内已写入 config.json（含 enrollmentToken），下载链接等同于接入凭据，请勿公开转发。',
    };
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function privatePackageFile(config, token, filename) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(token || ''))) return null;
  const dir = path.join(config.hub.dataDir, 'agent-packages', token);
  if (!fs.existsSync(dir)) return null;
  try {
    const stat = fs.statSync(dir);
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) return null;
  } catch {
    return null;
  }
  const safe = safeFileName(filename);
  const file = path.join(dir, safe);
  if (!fs.existsSync(file)) return null;
  return file;
}
