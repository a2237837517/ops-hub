import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonSafe, sha256Hex, nowIso } from './utils.js';
import { JOB_STATUS, TRANSFER_STATUS } from './protocol.js';

export function hashToken(token) {
  return sha256Hex(String(token || ''));
}

export class Store {
  constructor(dataDir, logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.stateFile = path.join(dataDir, 'state.json');
    this.auditFile = path.join(dataDir, 'audit.jsonl');
    this.state = {
      version: 1,
      agents: {},
      jobs: {},
      transfers: {},
      revoked: {},
    };
    this.saveTimer = null;
    this.load();
  }

  load() {
    const loaded = readJsonSafe(this.stateFile, null);
    if (loaded && typeof loaded === 'object') {
      this.state = {
        version: 1,
        agents: loaded.agents || {},
        jobs: loaded.jobs || {},
        transfers: loaded.transfers || {},
        revoked: loaded.revoked || {},
      };
    }
    // Hub 重启后所有 agent 都先视为离线，等 hello 再上线。
    for (const agent of Object.values(this.state.agents)) {
      agent.status = 'offline';
      agent.connected = false;
    }
    for (const job of Object.values(this.state.jobs)) {
      if ([JOB_STATUS.RUNNING, JOB_STATUS.EXITING, JOB_STATUS.QUEUED].includes(job.status)) {
        job.status = JOB_STATUS.DISCONNECTED;
        job.stale = true;
      }
    }
    for (const transfer of Object.values(this.state.transfers)) {
      if ([TRANSFER_STATUS.RUNNING, TRANSFER_STATUS.PENDING].includes(transfer.status)) {
        transfer.status = TRANSFER_STATUS.FAILED;
        transfer.error = 'hub restarted';
      }
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 80);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    atomicWriteJson(this.stateFile, this.state);
  }

  close() {
    this.flush();
  }

  // ---------- agents ----------
  getAgent(id) {
    return this.state.agents[id] || null;
  }

  findAgent(query) {
    if (!query) return null;
    if (this.state.agents[query]) return this.state.agents[query];
    const lower = String(query).toLowerCase();
    return (
      Object.values(this.state.agents).find(
        (a) =>
          String(a.name || '').toLowerCase() === lower ||
          String(a.hostname || '').toLowerCase() === lower,
      ) || null
    );
  }

  listAgents({ tag, status, query } = {}) {
    let list = Object.values(this.state.agents);
    if (tag) list = list.filter((a) => (a.tags || []).includes(tag));
    if (status) list = list.filter((a) => a.status === status);
    if (query) {
      const q = String(query).toLowerCase();
      list = list.filter((a) =>
        [a.id, a.name, a.hostname, a.os, a.arch, ...(a.tags || [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    return list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }

  upsertAgent(agent) {
    const existing = this.state.agents[agent.id] || {};
    this.state.agents[agent.id] = {
      ...existing,
      ...agent,
      createdAt: existing.createdAt || agent.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    this.save();
    return this.state.agents[agent.id];
  }

  updateAgent(id, patch) {
    const agent = this.state.agents[id];
    if (!agent) return null;
    Object.assign(agent, patch, { updatedAt: nowIso() });
    this.save();
    return agent;
  }

  removeAgent(id) {
    delete this.state.agents[id];
    this.save();
  }

  revokeAgent(id) {
    this.state.revoked[id] = nowIso();
    this.save();
  }

  unrevokeAgent(id) {
    delete this.state.revoked[id];
    this.save();
  }

  isRevoked(id) {
    return Boolean(this.state.revoked[id]);
  }

  // ---------- jobs ----------
  createJob(job) {
    this.state.jobs[job.id] = job;
    this.save();
    return job;
  }

  getJob(id) {
    return this.state.jobs[id] || null;
  }

  updateJob(id, patch) {
    const job = this.state.jobs[id];
    if (!job) return null;
    Object.assign(job, patch);
    this.save();
    return job;
  }

  listJobs({ clientId, status, limit = 100 } = {}) {
    let jobs = Object.values(this.state.jobs);
    if (clientId) jobs = jobs.filter((j) => j.clientId === clientId);
    if (status) jobs = jobs.filter((j) => j.status === status);
    return jobs
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  // ---------- transfers ----------
  createTransfer(transfer) {
    this.state.transfers[transfer.id] = transfer;
    this.save();
    return transfer;
  }

  getTransfer(id) {
    return this.state.transfers[id] || null;
  }

  updateTransfer(id, patch) {
    const transfer = this.state.transfers[id];
    if (!transfer) return null;
    Object.assign(transfer, patch);
    this.save();
    return transfer;
  }

  // ---------- audit ----------
  audit(action, details = {}) {
    const record = {
      ts: nowIso(),
      action,
      ...details,
    };
    try {
      fs.appendFileSync(this.auditFile, JSON.stringify(record) + '\n');
    } catch (error) {
      this.logger?.error('写审计日志失败', error.message);
    }
    return record;
  }

  listAudit(limit = 100) {
    try {
      const stat = fs.statSync(this.auditFile);
      const maxBytes = 2 * 1024 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(this.auditFile, 'r');
      const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
      let read = 0;
      try {
        read = fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      return buf
        .subarray(0, read)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        })
        .reverse();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // ---------- maintenance ----------
  pruneJobs({ keep = 500, maxAgeDays = 30 } = {}) {
    const jobs = Object.values(this.state.jobs).sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const remove = new Set();
    jobs.forEach((job, index) => {
      if (['queued', 'running', 'disconnected', 'exiting'].includes(job.status)) return;
      const old = new Date(job.createdAt).getTime() < cutoff;
      if (index >= keep || old) remove.add(job.id);
    });
    for (const id of remove) {
      const job = this.state.jobs[id];
      if (job?.outputPath) {
        try {
          fs.unlinkSync(job.outputPath);
        } catch {
          // ignore
        }
      }
      delete this.state.jobs[id];
    }
    if (remove.size) this.save();
    return remove.size;
  }
}
