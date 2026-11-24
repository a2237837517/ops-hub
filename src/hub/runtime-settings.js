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
    // 端口转发配置（模式③）：客户端 -> 目标端口记录，用于面板展示
    if (Array.isArray(data.forwards)) {
      config.forwards = data.forwards;
    }
    // 运行时覆盖的限额（面板「设置」页可改）
    // -1 是合法值（不限制），所以判断条件不能只写 > 0
    if (data.limits && typeof data.limits === 'object') {
      const numeric = [
        'maxConcurrentJobsPerClient',
        'maxOutputBytesPerJob',
        'maxFileBytes',
        'maxReadBytes',
        'maxChunkBytes',
        'jobTimeoutMs',
      ];
      for (const key of numeric) {
        if (data.limits[key] === undefined) continue;
        const value = Number(data.limits[key]);
        if (!Number.isFinite(value)) continue;
        if (value === -1 || value > 0) config.limits[key] = value;
      }
    }
  } catch {
    // 文件不存在或损坏时使用配置文件默认值
  }
}

export function saveRuntimeSettings(config) {
  const target = settingsPath(config);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const limits = {};
  for (const key of [
    'maxConcurrentJobsPerClient',
    'maxOutputBytesPerJob',
    'maxFileBytes',
    'maxReadBytes',
    'maxChunkBytes',
    'jobTimeoutMs',
  ]) {
    limits[key] = config.limits[key];
  }
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      { socks5: config.socks5, tunnel: config.tunnel, forwards: config.forwards || [], limits },
      null,
      2,
    ),
  );
  fs.renameSync(tmp, target);
}
