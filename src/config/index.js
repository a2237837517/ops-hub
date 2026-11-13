import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

const DEFAULTS = {
  hub: {
    host: '0.0.0.0',
    port: 7100,
    publicUrl: 'wss://ops.example.com/agent',
    dataDir: './data',
    heartbeatIntervalSec: 15,
    heartbeatTimeoutSec: 45,
    maxClients: 2000,
    logLevel: 'info',
  },
  auth: {
    enrollmentToken: 'change-me-enrollment-token',
    mcpToken: 'change-me-mcp-token',
    adminToken: 'change-me-admin-token',
  },
  socks5: {
    enabled: false,
    host: '0.0.0.0',
    port: 1080,
    token: '',
    publicHost: '',
    maxStreamsPerClient: 16,
    idleTimeoutSec: 1800,
  },
  tunnel: {
    // 默认关闭：tunnelToken 一旦泄露等于内网入口泄露，必须由管理员显式开启并设置随机 token。
    enabled: false,
    token: '',
    allowedCidrs: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    allowedPorts: [],
    maxStreamsPerTunnel: 16,
    idleTimeoutSec: 1800,
  },
  limits: {
    maxConcurrentJobsPerClient: 4,
    maxOutputBytesPerJob: 50 * 1024 * 1024,
    maxChunkBytes: 256 * 1024,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxReadBytes: 256 * 1024,
    maxTailLines: 1000,
    maxSearchMatches: 200,
    jobTimeoutMs: 24 * 60 * 60 * 1000,
    spoolQuotaBytes: 10 * 1024 * 1024 * 1024,
  },
  security: {
    allowedUploadRoots: ['./data/staging'],
    requireApprovalForDangerous: true,
    dangerousPatterns: [
      'format ',
      'diskpart',
      'bcdedit',
      'shutdown',
      'rm -rf /',
      'del /f /s /q c:\\',
      'rd /s /q c:\\',
    ],
  },
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`读取配置失败 ${file}: ${error.message}`);
  }
}

function resolveFrom(root, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * 配置查找顺序：
 * 1. --config 显式传入
 * 2. OPS_HUB_CONFIG 环境变量
 * 3. ops-hub/config.local.json
 * 4. ops-hub/config.example.json
 */
export function loadConfig(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.OPS_HUB_CONFIG,
    path.join(PROJECT_ROOT, 'config.local.json'),
    path.join(PROJECT_ROOT, 'config.example.json'),
  ].filter(Boolean);

  let file = null;
  let parsed = null;
  for (const candidate of candidates) {
    const full = path.resolve(candidate);
    const data = readJson(full);
    if (data) {
      file = full;
      parsed = data;
      break;
    }
  }
  if (!file) {
    throw new Error('找不到配置文件，请先复制 config.example.json 为 config.local.json');
  }

  const config = deepMerge(DEFAULTS, parsed);
  config.__file = file;
  config.__root = PROJECT_ROOT;

  if (process.env.OPS_HUB_HOST) config.hub.host = process.env.OPS_HUB_HOST;
  if (process.env.OPS_HUB_PORT) config.hub.port = Number(process.env.OPS_HUB_PORT);
  if (process.env.OPS_HUB_DATA_DIR) config.hub.dataDir = process.env.OPS_HUB_DATA_DIR;
  if (process.env.OPS_HUB_PUBLIC_URL) config.hub.publicUrl = process.env.OPS_HUB_PUBLIC_URL;
  if (process.env.OPS_HUB_ENROLLMENT_TOKEN) config.auth.enrollmentToken = process.env.OPS_HUB_ENROLLMENT_TOKEN;
  if (process.env.OPS_HUB_MCP_TOKEN) config.auth.mcpToken = process.env.OPS_HUB_MCP_TOKEN;
  if (process.env.OPS_HUB_ADMIN_TOKEN) config.auth.adminToken = process.env.OPS_HUB_ADMIN_TOKEN;

  config.hub.port = Number(config.hub.port);
  config.hub.heartbeatIntervalSec = Number(config.hub.heartbeatIntervalSec);
  config.hub.heartbeatTimeoutSec = Number(config.hub.heartbeatTimeoutSec);
  config.hub.maxClients = Number(config.hub.maxClients);
  config.hub.dataDir = resolveFrom(PROJECT_ROOT, config.hub.dataDir);
  config.security.allowedUploadRoots = (config.security.allowedUploadRoots || [])
    .map((item) => resolveFrom(PROJECT_ROOT, item));

  validateConfig(config);
  ensureDirs(config);
  return config;
}

function validateConfig(config) {
  if (!Number.isFinite(config.hub.port) || config.hub.port < 0 || config.hub.port > 65535) {
    throw new Error(`hub.port 非法: ${config.hub.port}`);
  }
  for (const key of ['enrollmentToken', 'mcpToken', 'adminToken']) {
    const value = config.auth[key];
    if (!value || typeof value !== 'string') {
      throw new Error(`auth.${key} 不能为空`);
    }
    if (value.startsWith('change-me')) {
      // 允许本地试跑，但必须大声提醒。
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`生产环境 auth.${key} 仍是示例值，请在 config.local.json 中修改`);
      }
      console.warn(`[config] 警告：auth.${key} 仍是示例值，请在 config.local.json 中修改`);
    }
  }
  if (!Array.isArray(config.security.dangerousPatterns)) {
    config.security.dangerousPatterns = [];
  }
}

function ensureDirs(config) {
  const dirs = [
    config.hub.dataDir,
    path.join(config.hub.dataDir, 'jobs'),
    path.join(config.hub.dataDir, 'downloads'),
    path.join(config.hub.dataDir, 'staging'),
    path.join(config.hub.dataDir, 'uploads'),
    path.join(config.hub.dataDir, 'agent-packages'),
    path.join(config.hub.dataDir, 'logs'),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

export function publicConfig(config) {
  return {
    file: config.__file,
    hub: config.hub,
    limits: config.limits,
    security: {
      allowedUploadRoots: config.security.allowedUploadRoots,
      requireApprovalForDangerous: config.security.requireApprovalForDangerous,
      dangerousPatterns: config.security.dangerousPatterns,
    },
  };
}
