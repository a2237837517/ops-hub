import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';

const manifestPath = path.join(PROJECT_ROOT, 'public', 'downloads', 'manifest.json');
let cache = { mtimeMs: 0, data: null };

export function loadManifest() {
  try {
    const stat = fs.statSync(manifestPath);
    if (cache.data && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

export function assetKey(agent) {
  const os = String(agent?.os || '').toLowerCase().includes('windows') ? 'windows' : 'linux';
  const arch = ['amd64', '386', 'arm64'].includes(agent?.arch) ? agent.arch : 'amd64';
  return `${os}-${arch}`;
}

export function resolveAsset(manifest, agent) {
  if (!manifest?.files) return null;
  const key = assetKey(agent);
  const file = manifest.files[key];
  if (!file || !file.name || !file.sha256) return null;
  return { key, ...file };
}

export function downloadUrl(config, name) {
  const base = new URL(config.hub.publicUrl);
  base.protocol = base.protocol === 'ws:' ? 'http:' : 'https:';
  base.pathname = `/downloads/${encodeURIComponent(name)}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

export function upgradeTarget(config, agent) {
  const manifest = loadManifest();
  if (!manifest) {
    return { error: 'agent manifest not found: public/downloads/manifest.json' };
  }
  const asset = resolveAsset(manifest, agent);
  if (!asset) {
    return { error: `no agent package for ${assetKey(agent)}` };
  }
  return {
    version: manifest.version,
    asset,
    url: downloadUrl(config, asset.name),
    alreadyLatest: String(agent.version || '') === String(manifest.version),
  };
}

// 支持 agent.upgrade 的第一个版本。更早的 Agent 收到该消息只会记为“未知消息”。
const MIN_UPGRADE_VERSION = '0.1.17';

function parseVersion(value) {
  return String(value || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersion(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function requestUpgrade({ config, store, gateway, clientId, logger }) {
  const agent = store.findAgent(clientId);
  if (!agent) return { error: 'client not found' };
  if (!gateway.getConnection(agent.id)) return { error: 'client is offline' };
  if (compareVersion(agent.version, MIN_UPGRADE_VERSION) < 0) {
    return {
      error:
        `agent ${agent.version || 'unknown'} cannot upgrade remotely; ` +
        `install ${MIN_UPGRADE_VERSION} or newer manually, then remote upgrades work`,
      needsManualUpgrade: true,
      downloadUrl: downloadUrl(config, 'ops-agent-windows-amd64.zip'),
    };
  }

  const target = upgradeTarget(config, agent);
  if (target.error) return target;
  if (target.alreadyLatest) {
    return { error: `already at latest version ${target.version}` };
  }

  const sent = gateway.send(agent.id, {
    type: 'agent.upgrade',
    url: target.url,
    sha256: target.asset.sha256,
    size: target.asset.size,
    version: target.version,
  });
  if (!sent) return { error: 'failed to send upgrade command' };

  store.audit('agent.upgrade.requested', {
    clientId: agent.id,
    from: agent.version || '',
    to: target.version,
    url: target.url,
  });
  logger?.info(`agent upgrade requested: ${agent.id} ${agent.version || '?'} -> ${target.version}`);
  return {
    clientId: agent.id,
    from: agent.version || '',
    to: target.version,
    url: target.url,
    size: target.asset.size,
  };
}
