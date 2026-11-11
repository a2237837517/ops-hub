(() => {
  const state = {
    token: localStorage.getItem('ops-hub-token') || '',
    clients: [],
    selected: null,
    view: 'clients',
    currentJob: null,
    jobOffset: 0,
    jobPollTimer: null,
    cmdHistory: [],
    historyIndex: -1,
    historyDraft: '',
    terminalBusy: false,
    filePath: '',
    selectedFile: null,
    tailCursor: null,
  };

  const $ = (id) => document.getElementById(id);
  const login = $('login');
  const app = $('app');
  const clientList = $('client-list');
  const terminalOutput = $('terminal-output');
  const fileList = $('file-list');
  const fileOutput = $('file-output');
  const jobsBody = $('jobs-body');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function showLogin(message = '') {
    login.classList.remove('hidden');
    app.classList.add('hidden');
    $('login-error').textContent = message;
    $('login-token').focus();
  }

  function showApp() {
    login.classList.add('hidden');
    app.classList.remove('hidden');
  }

  function showDownloads() {
    state.view = 'downloads';
    $('empty').classList.add('hidden');
    $('client-view').classList.add('hidden');
    $('downloads-view').classList.remove('hidden');
    loadDownloads().catch((error) => {
      $('download-list').textContent = `加载失败: ${error.message}`;
    });
  }

  function showClientOrEmpty() {
    state.view = state.selected ? 'client' : 'clients';
    $('downloads-view').classList.add('hidden');
    if (state.selected) {
      $('client-view').classList.remove('hidden');
      $('empty').classList.add('hidden');
    } else {
      $('client-view').classList.add('hidden');
      $('empty').classList.remove('hidden');
    }
  }

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    if (filename) link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function loadDownloads() {
    const data = await api('/api/downloads');
    const files = new Map((data.files || []).map((file) => [file.name, file]));
    for (const link of document.querySelectorAll('[data-download]')) {
      const file = files.get(link.dataset.download);
      if (file) {
        link.href = file.url;
        link.download = file.name;
        link.classList.remove('disabled');
        link.removeAttribute('aria-disabled');
      } else {
        link.href = '#';
        link.classList.add('disabled');
        link.setAttribute('aria-disabled', 'true');
        link.title = '本机还没有生成这个安装包，请运行 scripts/package-agent.sh';
      }
    }
    const list = $('download-list');
    if (!data.files?.length) {
      list.innerHTML = '<div class="muted" style="padding:10px 0">本机还没有安装包。在项目目录运行 <code>./scripts/package-agent.sh</code> 生成后刷新。</div>';
      return;
    }
    list.innerHTML = data.files
      .map(
        (file) => `
        <div class="file-row">
          <span><a href="${file.url}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a></span>
          <span class="size">${formatBytes(file.size)}</span>
        </div>`,
      )
      .join('');
  }

  async function downloadAgentConfig(os) {
    try {
      const response = await fetch(`/api/agent-config?os=${encodeURIComponent(os)}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (response.status === 401) {
        showLogin('Token 无效或已过期');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `ops-agent-${os}-config.json`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      alert(`下载配置失败: ${error.message}`);
    }
  }

  async function api(path, options = {}) {
    const headers = {
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    };
    if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      showLogin('Token 无效或已过期');
      throw new Error('unauthorized');
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return data;
  }

  async function loginWithToken(token) {
    state.token = token;
    localStorage.setItem('ops-hub-token', token);
    try {
      await api('/api/auth/check');
      showApp();
      await loadClients();
    } catch (error) {
      localStorage.removeItem('ops-hub-token');
      state.token = '';
      showLogin(error.message === 'unauthorized' ? 'Token 无效' : error.message);
    }
  }

  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = $('login-token').value.trim();
    if (token) loginWithToken(token);
  });

  $('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('ops-hub-token');
    state.token = '';
    showLogin();
  });

  async function loadClients() {
    const data = await api('/api/clients');
    state.clients = data.clients || [];
    renderClients();
    $('hub-status').textContent = `在线 ${state.clients.filter((c) => c.status === 'online').length} / 共 ${state.clients.length}`;
    if (!state.selected && state.clients.length && state.view !== 'downloads') {
      const first = state.clients.find((c) => c.status === 'online') || state.clients[0];
      await selectClient(first.id);
    } else if (!state.clients.length && state.view !== 'downloads') {
      showDownloads();
    }
  }

  function renderClients() {
    const query = $('client-search').value.trim().toLowerCase();
    const status = $('client-status').value;
    const list = state.clients.filter((client) => {
      if (status && client.status !== status) return false;
      if (!query) return true;
      return [client.id, client.name, client.hostname, client.os, ...(client.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    if (!list.length) {
      clientList.innerHTML = '<div class="muted" style="padding:12px">没有匹配的客户端</div>';
      return;
    }
    clientList.innerHTML = list
      .map(
        (client) => `
        <div class="client-item ${state.selected?.id === client.id ? 'active' : ''}" data-id="${escapeHtml(client.id)}">
          <div class="name"><span class="dot ${client.status}"></span>${escapeHtml(client.name || client.hostname || client.id)}</div>
          <div class="meta">${escapeHtml(client.os || '')} ${escapeHtml(client.arch || '')} · ${escapeHtml(client.status)}</div>
          <div class="meta">${escapeHtml(client.id)}</div>
        </div>`,
      )
      .join('');
    for (const item of clientList.querySelectorAll('.client-item')) {
      item.addEventListener('click', () => selectClient(item.dataset.id));
    }
  }

  async function selectClient(id) {
    const data = await api(`/api/clients/${encodeURIComponent(id)}?refresh=1`);
    state.selected = data.client;
    state.view = 'client';
    state.currentJob = null;
    state.jobOffset = 0;
    state.terminalBusy = false;
    clearTimeout(state.jobPollTimer);
    terminalOutput.textContent = '';
    $('job-info').textContent = '';
    $('cancel-btn').disabled = true;
    $('cwd-input').value = '';
    loadCommandHistory();
    updateTerminalPrompt();
    setTerminalStatus('就绪');
    $('downloads-view').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('client-view').classList.remove('hidden');
    $('client-name').textContent = state.selected.name || state.selected.hostname || state.selected.id;
    const info = state.selected.info || {};
    const parts = [
      state.selected.id,
      state.selected.os,
      state.selected.arch,
      state.selected.remoteAddress,
      info.hostname ? `host=${info.hostname}` : '',
      info.uptimeSec ? `uptime=${Math.floor(info.uptimeSec / 3600)}h` : '',
    ].filter(Boolean);
    $('client-meta').textContent = parts.join(' · ');
    const badge = $('client-badge');
    badge.textContent = state.selected.status;
    badge.className = `badge ${state.selected.status}`;
    $('file-path').value = isWindows(state.selected) ? 'C:\\' : '/';
    state.filePath = $('file-path').value;
    renderClients();
    await Promise.all([loadJobs(), loadAudit()]);
    setTimeout(focusTerminal, 50);
  }

  function isWindows(client) {
    return String(client?.os || '').toLowerCase().includes('windows');
  }

  $('client-search').addEventListener('input', renderClients);
  $('client-status').addEventListener('change', renderClients);
  $('refresh-btn').addEventListener('click', () => loadClients().catch((e) => alert(e.message)));
  $('downloads-btn').addEventListener('click', showDownloads);
  $('empty-downloads-btn').addEventListener('click', showDownloads);
  $('close-downloads-btn').addEventListener('click', showClientOrEmpty);
  $('reload-downloads-btn').addEventListener('click', () => loadDownloads().catch((e) => alert(e.message)));
  for (const button of document.querySelectorAll('[data-config]')) {
    button.addEventListener('click', () => downloadAgentConfig(button.dataset.config));
  }
  for (const link of document.querySelectorAll('[data-download]')) {
    link.addEventListener('click', (event) => {
      if (link.classList.contains('disabled')) {
        event.preventDefault();
        alert('本机还没有生成这个安装包，请先运行 ./scripts/package-agent.sh');
      }
    });
  }
  $('refresh-client-btn').addEventListener('click', () => state.selected && selectClient(state.selected.id));
  $('delete-client-btn').addEventListener('click', async () => {
    if (!state.selected) return;
    const name = state.selected.name || state.selected.id;
    if (!confirm(`删除并封禁客户端 ${name}？这会吊销 token，Agent 将无法重连。`)) return;
    try {
      await api(`/api/clients/${encodeURIComponent(state.selected.id)}`, { method: 'DELETE' });
      state.selected = null;
      $('client-view').classList.add('hidden');
      $('empty').classList.remove('hidden');
      await loadClients();
    } catch (error) {
      alert(error.message);
    }
  });

  // tabs
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const item of document.querySelectorAll('.tab')) item.classList.toggle('active', item === tab);
      for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.add('hidden');
      $(`tab-${tab.dataset.tab}`).classList.remove('hidden');
      if (tab.dataset.tab === 'jobs') loadJobs().catch(console.error);
      if (tab.dataset.tab === 'audit') loadAudit().catch(console.error);
      if (tab.dataset.tab === 'files') listFiles().catch(console.error);
    });
  }

  // terminal
  function historyKey() {
    return `ops-hub-history:${state.selected?.id || 'default'}`;
  }

  function loadCommandHistory() {
    try {
      const raw = localStorage.getItem(historyKey());
      state.cmdHistory = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.cmdHistory)) state.cmdHistory = [];
    } catch {
      state.cmdHistory = [];
    }
    state.historyIndex = -1;
    state.historyDraft = '';
  }

  function saveCommandHistory() {
    try {
      localStorage.setItem(historyKey(), JSON.stringify(state.cmdHistory.slice(-200)));
    } catch {
      // ignore quota errors
    }
  }

  function terminalPromptText() {
    if (!state.selected) return '$';
    const name = state.selected.name || state.selected.hostname || state.selected.id;
    const cwd = $('cwd-input').value.trim() || (isWindows(state.selected) ? 'C:\\' : '~');
    if (isWindows(state.selected)) {
      return $('shell-select').value === 'powershell' ? `PS ${cwd}>` : `${cwd}>`;
    }
    return `${name}:${cwd}$`;
  }

  function updateTerminalPrompt() {
    $('terminal-prompt').textContent = terminalPromptText();
  }

  function appendTerminal(text) {
    if (!text) return;
    terminalOutput.textContent += text;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function setTerminalStatus(text, kind = '') {
    const el = $('terminal-status');
    el.textContent = text;
    el.className = `terminal-status ${kind}`.trim();
  }

  function focusTerminal() {
    if (state.selected) $('command-input').focus();
  }

  function clearTerminal() {
    terminalOutput.textContent = '';
    if (!state.terminalBusy) {
      $('job-info').textContent = '';
      setTerminalStatus('就绪');
      $('cancel-btn').disabled = true;
    }
    focusTerminal();
  }

  function navigateHistory(direction) {
    if (!state.cmdHistory.length) return;
    if (state.historyIndex === -1 && direction < 0) {
      state.historyDraft = $('command-input').value;
    }
    if (direction < 0) {
      state.historyIndex = Math.min(state.historyIndex + 1, state.cmdHistory.length - 1);
    } else {
      state.historyIndex = Math.max(state.historyIndex - 1, -1);
    }
    const input = $('command-input');
    if (state.historyIndex === -1) {
      input.value = state.historyDraft;
    } else {
      input.value = state.cmdHistory[state.cmdHistory.length - 1 - state.historyIndex] || '';
    }
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async function cancelCurrentJob() {
    if (!state.currentJob) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(state.currentJob.id)}/cancel`, { method: 'POST' });
      appendTerminal('\n^C\n');
      setTerminalStatus('cancelled', 'error');
      $('job-info').textContent = `job=${state.currentJob.id} status=cancelled`;
    } catch (error) {
      appendTerminal(`\nERROR: ${error.message}\n`);
    }
  }

  async function runCommand() {
    if (!state.selected) return;
    const input = $('command-input');
    const command = input.value.trim();
    if (!command) return;

    if (command === 'clear' || command === 'cls') {
      clearTerminal();
      input.value = '';
      return;
    }
    if (command === 'help') {
      appendTerminal(
        '\n可用快捷操作：\n' +
          '  clear / cls   清屏\n' +
          '  help          显示帮助\n' +
          '  ↑ / ↓         翻阅命令历史\n' +
          '  Ctrl+L        清屏\n' +
          '  Ctrl+C        终止当前任务\n',
      );
      input.value = '';
      return;
    }
    if (state.terminalBusy) {
      appendTerminal('\n[busy] 当前任务还没结束，Ctrl+C 可终止，或等它完成。\n');
      return;
    }

    const prompt = terminalPromptText();
    appendTerminal(`\n${prompt} ${command}\n`);
    input.value = '';
    state.historyIndex = -1;
    state.historyDraft = '';
    if (state.cmdHistory[state.cmdHistory.length - 1] !== command) {
      state.cmdHistory.push(command);
      saveCommandHistory();
    }

    state.jobOffset = 0;
    state.terminalBusy = true;
    setTerminalStatus('running', 'running');
    $('job-info').textContent = 'starting...';
    $('cancel-btn').disabled = false;

    try {
      const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          command,
          shell: $('shell-select').value || undefined,
          cwd: $('cwd-input').value.trim() || undefined,
          approveDangerous: $('approve-dangerous').checked,
        }),
      });
      state.currentJob = data.job;
      pollJob();
    } catch (error) {
      appendTerminal(`ERROR: ${error.message}\n`);
      state.terminalBusy = false;
      setTerminalStatus('error', 'error');
      $('job-info').textContent = '';
      $('cancel-btn').disabled = true;
      focusTerminal();
    }
  }

  async function pollJob() {
    const job = state.currentJob;
    if (!job) return;
    clearTimeout(state.jobPollTimer);
    try {
      const data = await api(
        `/api/jobs/${encodeURIComponent(job.id)}/output?offset=${state.jobOffset}&maxBytes=65536`,
      );
      if (data.text) appendTerminal(data.text);
      state.jobOffset = data.nextOffset;
      state.currentJob = data.job;
      $('job-info').textContent = `job=${job.id} status=${data.job.status} exit=${data.job.exitCode ?? '-'} bytes=${data.size}`;
      if (['exited', 'failed', 'cancelled', 'interrupted', 'lost'].includes(data.job.status)) {
        state.terminalBusy = false;
        $('cancel-btn').disabled = true;
        setTerminalStatus(
          data.job.status === 'exited' ? 'done' : data.job.status,
          data.job.status === 'exited' ? 'done' : 'error',
        );
        await loadJobs();
        focusTerminal();
        return;
      }
      setTerminalStatus('running', 'running');
      state.jobPollTimer = setTimeout(pollJob, 600);
    } catch (error) {
      $('job-info').textContent = `poll error: ${error.message}`;
      setTerminalStatus('poll error', 'error');
      state.jobPollTimer = setTimeout(pollJob, 2000);
    }
  }

  $('run-btn').addEventListener('click', runCommand);
  $('clear-terminal-btn').addEventListener('click', clearTerminal);
  $('cancel-btn').addEventListener('click', cancelCurrentJob);
  $('terminal-shell').addEventListener('click', (event) => {
    if (event.target.closest('button, select, input')) return;
    focusTerminal();
  });

  $('command-input').addEventListener('keydown', (event) => {
    const input = event.currentTarget;
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigateHistory(-1);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      navigateHistory(1);
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      clearTerminal();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      // 有选中文本时保留浏览器复制行为
      if (input.selectionStart !== input.selectionEnd) return;
      if (state.currentJob && state.terminalBusy) {
        event.preventDefault();
        cancelCurrentJob();
      }
    }
  });

  $('shell-select').addEventListener('change', updateTerminalPrompt);
  $('cwd-input').addEventListener('input', updateTerminalPrompt);

  // files
  function joinRemote(dir, name) {
    const sep = isWindows(state.selected) ? '\\' : '/';
    if (!dir) return name;
    return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
  }

  async function listFiles() {
    if (!state.selected) return;
    const path = $('file-path').value.trim() || (isWindows(state.selected) ? 'C:\\' : '/');
    state.filePath = path;
    const data = await api(
      `/api/clients/${encodeURIComponent(state.selected.id)}/files?path=${encodeURIComponent(path)}&pattern=${encodeURIComponent($('file-pattern').value.trim())}`,
    );
    const entries = data.entries || [];
    fileList.innerHTML = entries.length
      ? entries
          .map(
            (entry) => `
          <div class="file-row ${entry.dir ? 'dir' : ''}" data-path="${escapeHtml(entry.path)}" data-dir="${entry.dir ? '1' : '0'}">
            <span>${entry.dir ? '📁' : '📄'} ${escapeHtml(entry.name)}</span>
            <span class="size">${entry.dir ? '' : formatBytes(entry.size)} ${escapeHtml(entry.modTime || '')}</span>
          </div>`,
          )
          .join('')
      : '<div class="muted" style="padding:12px">空目录</div>';
    for (const row of fileList.querySelectorAll('.file-row')) {
      row.addEventListener('click', () => {
        if (row.dataset.dir === '1') {
          $('file-path').value = row.dataset.path;
          listFiles().catch((e) => alert(e.message));
        } else {
          selectFile(row.dataset.path);
        }
      });
    }
  }

  function selectFile(path) {
    state.selectedFile = path;
    state.tailCursor = null;
    $('file-selected').textContent = path;
    $('file-tail-btn').disabled = false;
    $('file-download-btn').disabled = false;
    fileOutput.textContent = '';
    tailFile();
  }

  async function tailFile() {
    if (!state.selected || !state.selectedFile) return;
    const data = await api(
      `/api/clients/${encodeURIComponent(state.selected.id)}/files/tail?path=${encodeURIComponent(state.selectedFile)}&lines=300&cursor=${encodeURIComponent(state.tailCursor || '')}`,
    );
    state.tailCursor = data.cursor || null;
    const lines = data.lines || [];
    fileOutput.textContent += lines.map((line) => line.text ?? line).join('\n') + (lines.length ? '\n' : '');
    fileOutput.scrollTop = fileOutput.scrollHeight;
    if (data.rotated) fileOutput.textContent += '\n[日志已轮转，cursor 已重置]\n';
  }

  $('file-list-btn').addEventListener('click', () => listFiles().catch((e) => alert(e.message)));
  $('file-tail-btn').addEventListener('click', () => tailFile().catch((e) => alert(e.message)));
  $('file-download-btn').addEventListener('click', async () => {
    if (!state.selected || !state.selectedFile) return;
    try {
      const response = await api(
        `/api/clients/${encodeURIComponent(state.selected.id)}/files/download?path=${encodeURIComponent(state.selectedFile)}`,
      );
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = state.selectedFile.split(/[\\/]/).pop() || 'download';
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      alert(error.message);
    }
  });

  $('file-upload').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file || !state.selected) return;
    const target = joinRemote($('file-path').value.trim(), file.name);
    if (!confirm(`上传到 ${target} ?`)) return;
    try {
      await api(
        `/api/clients/${encodeURIComponent(state.selected.id)}/files/upload?path=${encodeURIComponent(target)}&overwrite=1`,
        { method: 'POST', body: file },
      );
      alert('上传完成');
      listFiles().catch(console.error);
    } catch (error) {
      alert(`上传失败: ${error.message}`);
    } finally {
      event.target.value = '';
    }
  });

  async function loadJobs() {
    if (!state.selected) return;
    const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}/jobs`);
    const jobs = data.jobs || [];
    jobsBody.innerHTML = jobs.length
      ? jobs
          .map(
            (job) => `
        <tr>
          <td>${escapeHtml(job.id)}</td>
          <td class="command" title="${escapeHtml(job.command)}">${escapeHtml(job.command)}</td>
          <td class="status-${escapeHtml(job.status)}">${escapeHtml(job.status)}</td>
          <td>${escapeHtml(job.exitCode ?? '-')}</td>
          <td>${escapeHtml(job.startedAt || job.createdAt)}</td>
          <td>${['running', 'disconnected', 'queued'].includes(job.status) ? `<button data-cancel="${escapeHtml(job.id)}" class="ghost">终止</button>` : ''}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="muted">暂无任务</td></tr>';
    for (const button of jobsBody.querySelectorAll('[data-cancel]')) {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/jobs/${encodeURIComponent(button.dataset.cancel)}/cancel`, { method: 'POST' });
          await loadJobs();
        } catch (error) {
          alert(error.message);
        }
      });
    }
  }

  async function loadAudit() {
    if (!state.selected) return;
    const data = await api('/api/audit?limit=200');
    const lines = (data.audit || []).filter((item) => !item.clientId || item.clientId === state.selected.id);
    $('audit-output').textContent = lines.map((item) => JSON.stringify(item)).join('\n');
  }

  function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
  }

  async function init() {
    if (!state.token) {
      showLogin();
      return;
    }
    try {
      await api('/api/auth/check');
      showApp();
      await loadClients();
      setInterval(() => loadClients().catch(() => {}), 15000);
    } catch {
      showLogin();
    }
  }

  init();
})();
