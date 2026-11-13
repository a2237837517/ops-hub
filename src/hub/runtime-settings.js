import fs from 'node:fs';
import path from 'node:path';

function settingsPath(config) {
  return path.join(config.hub.dataDir, 'settings.json');
}

// 运行时设置覆盖 config.local.json，保存到 data/settings.json，容器重启后仍然生效。
export function applyRuntimeSettings(config) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(config), 'utf8'));
    if (data.socks5 && typeof data.socks5 === 'object') {
      config.socks5 = { ...config.socks5, ...data.socks5 };
    }
    if (data.tunnel && typeof data.tunnel === 'object') {
      config.tunnel = { ...config.tunnel, ...data.tunnel };
    }
  } catch {
    // 文件不存在或损坏时使用配置文件默认值
  }
}

export function saveRuntimeSettings(config) {
  const target = settingsPath(config);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ socks5: config.socks5, tunnel: config.tunnel }, null, 2));
  fs.renameSync(tmp, target);
}
