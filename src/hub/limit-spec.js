// 面板「设置」页可改的运行时限额。
// 只暴露会真正卡住运维动作的项；其余（单次读取、分块大小、输出上限）作为内部默认值，
// 不在页面上出现，避免一堆看不懂的数字。
//
// 统一约定：填 -1 表示「不限制」。
// 注意：agent 侧还有自己的 maxConcurrentJobs，两边要一致，否则会出现
// 「hub 放行了、agent 拒绝」或反过来的情况。

export const UNLIMITED = -1;

export const LIMIT_SPEC = {
  maxConcurrentJobsPerClient: {
    label: '每客户端并发任务上限',
    min: UNLIMITED,
    max: 10000,
    unit: '个',
    expose: true,
    hint: '同一台客户端同时跑几个任务。-1 = 不限制。注意 agent 侧 maxConcurrentJobs 也要放开。',
  },
  jobTimeoutMs: {
    label: '单个任务超时',
    min: UNLIMITED,
    max: 30 * 24 * 60 * 60 * 1000,
    unit: 'ms',
    expose: true,
    hint: '超时后 agent 会杀掉进程树。-1 = 一直跑到自己结束。',
  },
  maxFileBytes: {
    label: '单文件大小上限',
    min: UNLIMITED,
    max: 1024 * 1024 * 1024 * 1024,
    unit: 'bytes',
    expose: true,
    hint: '超过直接拒绝传输。-1 = 不限制。',
  },
  // 以下不在页面展示，保留默认值即可
  maxOutputBytesPerJob: {
    label: '单任务输出上限',
    min: UNLIMITED,
    max: 4 * 1024 * 1024 * 1024,
    unit: 'bytes',
    expose: false,
    hint: '超出部分丢弃并标记 truncated。',
  },
  maxReadBytes: {
    label: '单次读取上限',
    min: 1024,
    max: 32 * 1024 * 1024,
    unit: 'bytes',
    expose: false,
    hint: '单次返回的最大字节数。',
  },
  maxChunkBytes: {
    label: '文件分块大小',
    min: 16 * 1024,
    max: 32 * 1024 * 1024,
    unit: 'bytes',
    expose: false,
    hint: '上传/下载每块字节数。',
  },
};

export function isUnlimited(key, value) {
  return Number(value) === UNLIMITED && LIMIT_SPEC[key]?.min === UNLIMITED;
}

export function publicLimitFields(limits = {}, { onlyExposed = false } = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(LIMIT_SPEC)) {
    if (onlyExposed && !spec.expose) continue;
    out[key] = {
      value: Number(limits[key]) || spec.min,
      label: spec.label,
      unit: spec.unit,
      min: spec.min,
      max: spec.max,
      allowUnlimited: spec.min === UNLIMITED,
      hint: spec.hint,
    };
  }
  return out;
}

export function formatLimitValue(key, value) {
  const spec = LIMIT_SPEC[key];
  const n = Number(value);
  if (!spec || !Number.isFinite(n)) return String(value);
  if (isUnlimited(key, n)) return '不限制';
  if (spec.unit === 'bytes') {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n % 1024 ** 3 ? 1 : 0)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  }
  if (key === 'jobTimeoutMs') {
    const min = n / 60000;
    if (min >= 60) return `${(min / 60).toFixed(min % 60 ? 1 : 0)} 小时`;
    return `${min.toFixed(0)} 分钟`;
  }
  return `${n} ${spec.unit}`;
}
