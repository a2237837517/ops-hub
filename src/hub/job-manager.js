import fs from 'node:fs';
import path from 'node:path';
import { MSG, JOB_STATUS, isDangerousCommand } from '../protocol.js';
import { nowIso, randomId, clamp } from '../utils.js';

const ACTIVE_STATUSES = new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.DISCONNECTED,
  JOB_STATUS.EXITING,
]);

const TERMINAL_STATUSES = new Set([
  JOB_STATUS.EXITED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELLED,
  JOB_STATUS.INTERRUPTED,
  JOB_STATUS.LOST,
]);

export class JobManager {
  constructor({ gateway, store, config, logger }) {
    this.gateway = gateway;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.waiters = new Map(); // jobId -> Set<resolve>

    gateway.on(MSG.EXEC_STARTED, (clientId, msg) => this._onStarted(clientId, msg));
    gateway.on(MSG.EXEC_CHUNK, (clientId, msg) => this._onChunk(clientId, msg));
    gateway.on(MSG.EXEC_EXIT, (clientId, msg) => this._onExit(clientId, msg));
    gateway.on(MSG.EXEC_ERROR, (clientId, msg) => this._onError(clientId, msg));
    gateway.on(MSG.EXEC_LOST, (clientId, msg) => this._onLost(clientId, msg));
    gateway.on('agent:online', (agent, hello) => this._onAgentOnline(agent, hello));
    gateway.on('agent:offline', (clientId) => this._onAgentOffline(clientId));
  }

  _activeCount(clientId) {
    return this.store
      .listJobs({ clientId })
      .filter((job) => [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.EXITING].includes(job.status)).length;
  }

  async startJob(clientId, options = {}) {
    const agent = this.store.getAgent(clientId);
    if (!agent) throw new Error(`客户端不存在: ${clientId}`);
    if (!this.gateway.isOnline(clientId)) throw new Error(`客户端不在线: ${clientId}`);

    const maxConcurrent = Number(this.config.limits.maxConcurrentJobsPerClient) || 4;
    if (this._activeCount(clientId) >= maxConcurrent) {
      throw new Error(`客户端并发任务已达上限 ${maxConcurrent}，请先等待或取消其它任务`);
    }

    const command = String(options.command || '').trim();
    if (!command) throw new Error('command 不能为空');
    if (command.length > 20000) throw new Error('command 太长');

    if (
      this.config.security.requireApprovalForDangerous &&
      isDangerousCommand(command, this.config.security.dangerousPatterns) &&
      !options.approveDangerous
    ) {
      const error = new Error(
        '该命令命中高危规则，需要显式传 approveDangerous=true 才能执行',
      );
      error.code = 'DANGEROUS_COMMAND';
      throw error;
    }

    const jobId = randomId('job');
    const outputPath = path.join(this.config.hub.dataDir, 'jobs', `${jobId}.log`);
    fs.writeFileSync(outputPath, '');
    const timeoutMs = clamp(
      options.timeoutMs || this.config.limits.jobTimeoutMs,
      1000,
      Number(this.config.limits.jobTimeoutMs) || 24 * 60 * 60 * 1000,
    );

    const job = {
      id: jobId,
      clientId,
      clientName: agent.displayName || agent.name || agent.hostname || clientId,
      command,
      shell: options.shell || '',
      cwd: options.cwd || '',
      env: options.env || {},
      status: JOB_STATUS.QUEUED,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      pid: null,
      agentOffset: 0,
      outputBytes: 0,
      outputPath,
      truncated: false,
      error: null,
      createdBy: options.createdBy || 'unknown',
      timeoutMs,
      approvedDangerous: Boolean(options.approveDangerous),
    };
    this.store.createJob(job);
    this.store.audit('exec.start', {
      jobId,
      clientId,
      command,
      shell: job.shell,
      cwd: job.cwd,
      createdBy: job.createdBy,
      approvedDangerous: job.approvedDangerous,
    });

    const sent = this.gateway.send(clientId, {
      type: MSG.EXEC_START,
      jobId,
      command,
      shell: job.shell,
      cwd: job.cwd,
      env: job.env,
      timeoutMs,
      maxOutputBytes: this.config.limits.maxOutputBytesPerJob,
      createdAt: job.createdAt,
    });
    if (!sent) {
      this.store.updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        error: 'agent disconnected before start',
        endedAt: nowIso(),
      });
      throw new Error(`客户端已断开: ${clientId}`);
    }
    this.store.updateJob(jobId, { status: JOB_STATUS.RUNNING, startedAt: nowIso() });
    return this.store.getJob(jobId);
  }

  _onStarted(clientId, msg) {
    const job = this.store.getJob(msg.jobId);
    if (!job || job.clientId !== clientId) return;
    this.store.updateJob(job.id, {
      status: JOB_STATUS.RUNNING,
      startedAt: msg.startedAt || job.startedAt || nowIso(),
      pid: msg.pid || null,
    });
  }

  _onChunk(clientId, msg) {
    const job = this.store.getJob(msg.jobId);
    if (!job || job.clientId !== clientId) return;
    const endOffset = Number(msg.endOffset ?? msg.offset ?? 0);
    if (endOffset > 0 && endOffset <= Number(job.agentOffset || 0)) {
      // 断线重连时 Agent 可能重放已经收到的帧，按 offset 去重
      this.gateway.send(clientId, {
        type: MSG.EXEC_CHUNK_ACK,
        jobId: job.id,
        offset: endOffset,
      });
      return;
    }
    let data = Buffer.from(String(msg.data || ''), 'base64');
    if (job.outputBytes + data.length > this.config.limits.maxOutputBytesPerJob) {
      const remaining = Math.max(0, this.config.limits.maxOutputBytesPerJob - job.outputBytes);
      data = data.subarray(0, remaining);
      this.store.updateJob(job.id, { truncated: true });
    }
    if (data.length) {
      let prefix = '';
      if (msg.stream === 'stderr' && job.lastStream !== 'stderr') prefix = '\n[stderr] ';
      if (msg.stream === 'stdout' && job.lastStream === 'stderr') prefix = '\n[stdout] ';
      fs.appendFileSync(job.outputPath, prefix + data.toString('utf8'));
      job.lastStream = msg.stream || 'stdout';
    }
    const outputBytes = safeStatSize(job.outputPath);
    this.store.updateJob(job.id, {
      agentOffset: Number(msg.endOffset ?? msg.offset ?? job.agentOffset),
      outputBytes,
      lastStream: job.lastStream || 'stdout',
    });
    // 流控：agent 等这个 ack 再继续发
    this.gateway.send(clientId, {
      type: MSG.EXEC_CHUNK_ACK,
      jobId: job.id,
      offset: Number(msg.endOffset ?? msg.offset ?? 0),
    });
  }

  _onExit(clientId, msg) {
    const job = this.store.getJob(msg.jobId);
    if (!job || job.clientId !== clientId) return;
    const status =
      job.status === JOB_STATUS.CANCELLED || msg.cancelled
        ? JOB_STATUS.CANCELLED
        : Number(msg.exitCode) === 0
          ? JOB_STATUS.EXITED
          : JOB_STATUS.FAILED;
    this.store.updateJob(job.id, {
      status,
      exitCode: msg.exitCode ?? null,
      signal: msg.signal || null,
      endedAt: msg.endedAt || nowIso(),
      outputBytes: safeStatSize(job.outputPath),
      error: msg.error || job.error || null,
    });
    this.store.audit('exec.exit', {
      jobId: job.id,
      clientId,
      exitCode: msg.exitCode,
      status,
    });
    this._notify(job.id);
  }

  _onError(clientId, msg) {
    const job = this.store.getJob(msg.jobId);
    if (!job || job.clientId !== clientId) return;
    this.store.updateJob(job.id, {
      status: JOB_STATUS.FAILED,
      error: String(msg.message || 'agent exec error'),
      endedAt: nowIso(),
    });
    this.store.audit('exec.error', {
      jobId: job.id,
      clientId,
      message: msg.message,
    });
    this._notify(job.id);
  }

  _onLost(clientId, msg) {
    const job = this.store.getJob(msg.jobId);
    if (!job || job.clientId !== clientId) return;
    this.store.updateJob(job.id, {
      status: JOB_STATUS.LOST,
      error: 'agent lost job after restart',
      endedAt: nowIso(),
    });
    this._notify(job.id);
  }

  _onAgentOffline(clientId) {
    for (const job of this.store.listJobs({ clientId })) {
      if ([JOB_STATUS.RUNNING, JOB_STATUS.QUEUED, JOB_STATUS.EXITING].includes(job.status)) {
        this.store.updateJob(job.id, { status: JOB_STATUS.DISCONNECTED });
      }
    }
  }

  _onAgentOnline(agent, hello) {
    const reported = new Map();
    for (const item of hello?.jobs || []) {
      if (item && item.jobId) reported.set(item.jobId, item);
    }
    for (const job of this.store.listJobs({ clientId: agent.id })) {
      if (![JOB_STATUS.RUNNING, JOB_STATUS.DISCONNECTED, JOB_STATUS.QUEUED, JOB_STATUS.EXITING].includes(job.status)) {
        continue;
      }
      const item = reported.get(job.id);
      if (!item) {
        this.store.updateJob(job.id, {
          status: JOB_STATUS.INTERRUPTED,
          error: 'agent restarted or job no longer running',
          endedAt: nowIso(),
        });
        this._notify(job.id);
        continue;
      }
      if (item.status === 'exited') {
        // 让 agent 从 hub 已收到的 offset 之后补发剩余输出，再补发 exit
        this.store.updateJob(job.id, { stale: false });
        this.gateway.send(agent.id, {
          type: MSG.EXEC_RESUME,
          jobId: job.id,
          offset: Number(job.agentOffset) || 0,
        });
        continue;
      }
      this.store.updateJob(job.id, { status: JOB_STATUS.RUNNING, stale: false });
      this.gateway.send(agent.id, {
        type: MSG.EXEC_RESUME,
        jobId: job.id,
        offset: Number(job.agentOffset) || 0,
      });
    }
  }

  _notify(jobId) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    this.waiters.delete(jobId);
    for (const resolve of set) resolve();
  }

  waitForJob(jobId, waitMs = 10_000) {
    const job = this.store.getJob(jobId);
    if (!job) return Promise.reject(new Error(`任务不存在: ${jobId}`));
    if (TERMINAL_STATUSES.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const set = this.waiters.get(jobId);
        if (set) {
          set.delete(done);
          if (!set.size) this.waiters.delete(jobId);
        }
        resolve(this.store.getJob(jobId));
      }, Math.max(0, Number(waitMs)));
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve(this.store.getJob(jobId));
      };
      if (!this.waiters.has(jobId)) this.waiters.set(jobId, new Set());
      this.waiters.get(jobId).add(done);
    });
  }

  getOutput(jobId, offset = 0, maxBytes = 64 * 1024) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    const size = safeStatSize(job.outputPath);
    let start = clamp(offset, 0, size);
    if (start === size) {
      return {
        job,
        text: '',
        offset: start,
        nextOffset: start,
        size,
        eof: true,
        truncated: false,
      };
    }
    // 对齐到 UTF-8 字符边界
    const fd = fs.openSync(job.outputPath, 'r');
    try {
      let prefixBytes = 0;
      if (start > 0) {
        const probe = Buffer.alloc(4);
        const n = fs.readSync(fd, probe, 0, Math.min(4, size - start), start);
        while (prefixBytes < n && (probe[prefixBytes] & 0xc0) === 0x80) prefixBytes += 1;
      }
      start += prefixBytes;
      const len = Math.max(0, Math.min(maxBytes, size - start));
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      let end = read;
      if (start + read < size) {
        while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
      }
      const text = buf.subarray(0, end).toString('utf8');
      const nextOffset = start + end;
      return {
        job,
        text,
        offset: start,
        nextOffset,
        size,
        eof: nextOffset >= size,
        truncated: nextOffset < size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  listJobs(options) {
    return this.store.listJobs(options);
  }

  cancelJob(jobId, actor = 'unknown') {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    if (!ACTIVE_STATUSES.has(job.status)) {
      return { job, alreadyDone: true };
    }
    this.store.updateJob(job.id, { status: JOB_STATUS.CANCELLED, endedAt: nowIso() });
    const sent = this.gateway.send(job.clientId, { type: MSG.EXEC_CANCEL, jobId: job.id });
    this.store.audit('exec.cancel', { jobId: job.id, clientId: job.clientId, actor, sent });
    this._notify(job.id);
    return { job: this.store.getJob(job.id), sent };
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }
}

function safeStatSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
