(() => {
  const state = {
    token: localStorage.getItem('ops-hub-token') || '',
    clients: [],
    latestVersion: '',
    socks5: null,
    socks5User: '',
    tunnelMode: 'forward',
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
    collapsedGroups: new Set(),
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
  function shorten(value, max = 40) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function shortOs(value) {
    let text = String(value || '').replace(/^(windows|linux)\s+/i, '');
    if (/windows/i.test(text)) text = text.replace(/\s+\d+(\.\d+)+.*$/, '');
    return shorten(text.trim(), 34);
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

  let dialogResolver = null;

  function openDialog({
    title,
    message = '',
    input = null,
    confirmText = '确定',
    danger = false,
    icon = '✎',
  }) {
    return new Promise((resolve) => {
      dialogResolver = resolve;
      $('dialog-title').textContent = title;
      $('dialog-message').textContent = message;
      $('dialog-message').classList.toggle('hidden', !message);
      $('dialog-icon').textContent = icon;
      const inputEl = $('dialog-input');
      const hasInput = input !== null;
      inputEl.classList.toggle('hidden', !hasInput);
      inputEl.value = hasInput ? String(input) : '';
      $('dialog-error').textContent = '';
      const confirm = $('dialog-confirm');
      confirm.textContent = confirmText;
      confirm.className = `dialog-btn ${danger ? 'danger' : 'primary'}`;
      $('dialog-backdrop').classList.remove('hidden');
      setTimeout(() => {
        if (hasInput) {
          inputEl.focus();
          inputEl.select();
        } else {
          confirm.focus();
        }
      }, 30);
    });
  }

  function closeDialog(value) {
    $('dialog-backdrop').classList.add('hidden');
    const resolve = dialogResolver;
    dialogResolver = null;
    if (resolve) resolve(value);
  }

  function submitDialog() {
    const inputEl = $('dialog-input');
    if (!inputEl.classList.contains('hidden')) {
      const value = inputEl.value.trim();
      if (!value) {
        $('dialog-error').textContent = '不能为空';
        inputEl.focus();
        return;
      }
      closeDialog(value);
      return;
    }
    closeDialog(true);
  }

  $('dialog-cancel').addEventListener('click', () => closeDialog(null));
  $('dialog-confirm').addEventListener('click', submitDialog);
  $('dialog-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitDialog();
    }
  });
  $('dialog-backdrop').addEventListener('click', (event) => {
    if (event.target === $('dialog-backdrop')) closeDialog(null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('socks5-backdrop').classList.contains('hidden')) {
      event.preventDefault();
      $('socks5-backdrop').classList.add('hidden');
      return;
    }
    if (!$('tunnel-backdrop').classList.contains('hidden')) {
      event.preventDefault();
      hideTunnel();
      return;
    }
    if ($('dialog-backdrop').classList.contains('hidden')) return;
    event.preventDefault();
    closeDialog(null);
  });

  async function upgradeClient() {
    if (!state.selected) return;
    try {
      const versions = await api('/api/agent-versions');
      const latest = versions.version || '';
      const current = state.selected.version || '';
      if (!latest || latest === current) {
        alert(`已经是最新版本 ${latest || current}`);
        return;
      }
      const ok = await openDialog({
        title: '升级客户端',
        message: `客户端：${state.selected.displayName || state.selected.hostname || state.selected.id}\n当前版本：${current || '未知'}\n最新版本：${latest}\n\n升级会下载新版本并自动重启服务，客户端会短暂离线。`,
        confirmText: '升级',
        icon: '⬆',
      });
      if (!ok) return;
      const result = await api(`/api/clients/${encodeURIComponent(state.selected.id)}/upgrade`, {
        method: 'POST',
      });
      alert(`已下发升级：${result.from || '?'} → ${result.to}\n约 10-30 秒后客户端会自动上线。`);
      setTimeout(() => loadClients().catch(() => {}), 5000);
      setTimeout(() => loadClients().catch(() => {}), 15000);
      setTimeout(() => {
        if (state.selected?.id === result.clientId) refreshClientInfo().catch(() => {});
      }, 15000);
    } catch (error) {
      alert(`升级失败: ${error.message}`);
    }
  }

  function setTunnelMode(mode) {
    state.tunnelMode = mode === 'socks5' ? 'socks5' : 'forward';
    const socks = state.tunnelMode === 'socks5';
    $('tunnel-form').classList.toggle('socks5', socks);
    $('tunnel-desc').textContent = socks
      ? '在本地开一个 SOCKS5 端口，通过当前客户端访问任意 TCP 目标。走现有 443，不开新端口；Clash 填 127.0.0.1:端口。'
      : '在本地 127.0.0.1 开一个端口，通过当前客户端访问一个固定目标 TCP 端口。';
    $('tunnel-local').value = socks ? '1080' : '13306';
    for (const radio of document.querySelectorAll('input[name="tunnel-mode"]')) {
      radio.checked = radio.value === state.tunnelMode;
    }
  }

  function showTunnel() {
    if (!state.selected) return;
    $('tunnel-backdrop').classList.remove('hidden');
    setTunnelMode(state.tunnelMode || 'forward');
    $('tunnel-command').classList.add('hidden');
    $('tunnel-actions').classList.add('hidden');
    $('tunnel-copy').textContent = '复制命令';
    $('tunnel-list').textContent = '加载中...';
    loadTunnels().catch((error) => {
      $('tunnel-list').textContent = `加载失败: ${error.message}`;
    });
  }

  function hideTunnel() {
    $('tunnel-backdrop').classList.add('hidden');
  }

  async function generateTunnelCommand() {
    if (!state.selected) return;
    const local = Number($('tunnel-local').value);
    const host = $('tunnel-host').value.trim();
    const port = Number($('tunnel-port').value);
    const socks = state.tunnelMode === 'socks5';
    if (!local || (!socks && (!host || !port))) {
      alert(socks ? '请填写本地端口' : '请填写本地端口、目标地址和目标端口');
      return;
    }
    try {
      const body = socks
        ? { socks5: { port: local } }
        : { forwards: [{ local, host, port }] };
      const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}/tunnel-command`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      $('tunnel-command').textContent = data.command;
      $('tunnel-command').classList.remove('hidden');
      $('tunnel-actions').classList.remove('hidden');
    } catch (error) {
      alert(`生成失败: ${error.message}`);
    }
  }

  async function copyTunnelCommand() {
    const text = $('tunnel-command').textContent || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      $('tunnel-copy').textContent = '已复制';
      setTimeout(() => {
        $('tunnel-copy').textContent = '复制命令';
      }, 1500);
    } catch {
      alert('复制失败，请手动选中命令复制');
    }
  }

  async function loadTunnels() {
    if (!state.selected) return;
    const data = await api(`/api/tunnels?clientId=${encodeURIComponent(state.selected.id)}`);
    const list = data.tunnels || [];
    if (!list.length) {
      $('tunnel-list').textContent = '暂无';
      return;
    }
    $('tunnel-list').innerHTML = list
      .map((tunnel) => {
        const targets = (tunnel.streams || [])
          .map((stream) => `${stream.target}（本地 ${stream.localPort || '-'}）`)
          .join('，');
        return `
        <div class="tunnel-item">
          <span>${escapeHtml(targets || '无活动连接')}<br /><span class="muted">${escapeHtml(tunnel.remoteAddress || '')} · ${escapeHtml(tunnel.createdAt || '')}</span></span>
          <button class="ghost" data-close-tunnel="${escapeHtml(tunnel.id)}">关闭</button>
        </div>`;
      })
      .join('');
    for (const button of $('tunnel-list').querySelectorAll('[data-close-tunnel]')) {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/tunnels/${encodeURIComponent(button.dataset.closeTunnel)}/close`, { method: 'POST' });
          await loadTunnels();
        } catch (error) {
          alert(`关闭失败: ${error.message}`);
        }
      });
    }
  }

  function showDownloads() {
    state.view = 'downloads';
    $('empty').classList.add('hidden');
    $('client-view').classList.add('hidden');
    $('revoked-view').classList.add('hidden');
    $('downloads-view').classList.remove('hidden');
    loadDownloads().catch((error) => {
      $('download-list').textContent = `加载失败: ${error.message}`;
    });
  }

  function showClientOrEmpty() {
    state.view = state.selected ? 'client' : 'clients';
    $('downloads-view').classList.add('hidden');
    $('revoked-view').classList.add('hidden');
    if (state.selected) {
      $('client-view').classList.remove('hidden');
      $('empty').classList.add('hidden');
    } else {
      $('client-view').classList.add('hidden');
      $('empty').classList.remove('hidden');
    }
  }

  async function loadRevoked() {
    const data = await api('/api/revoked');
    const list = data.revoked || [];
    const body = $('revoked-body');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="3" class="muted">没有封禁的客户端</td></tr>';
      return;
    }
    body.innerHTML = list
      .map(
        (item) => `
        <tr>
          <td><span class="info-net-ip">${escapeHtml(item.id)}</span></td>
          <td>${escapeHtml(item.revokedAt || '-')}</td>
          <td><button class="ghost" data-unrevoke="${escapeHtml(item.id)}">解除封禁</button></td>
        </tr>`,
      )
      .join('');
    for (const button of body.querySelectorAll('[data-unrevoke]')) {
      button.addEventListener('click', () => unrevokeClient(button.dataset.unrevoke));
    }
  }

  async function showRevoked() {
    state.view = 'revoked';
    $('empty').classList.add('hidden');
    $('client-view').classList.add('hidden');
    $('downloads-view').classList.add('hidden');
    $('revoked-view').classList.remove('hidden');
    try {
      await loadRevoked();
    } catch (error) {
      $('revoked-body').innerHTML = `<tr><td colspan="3" class="error">加载失败: ${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function unrevokeClient(id) {
    const ok = await openDialog({
      title: '解除封禁',
      message: `客户端 ID：\n${id}\n\n解除后 Agent 下一次重连会自动重新注册。`,
      confirmText: '解除',
      icon: '🔓',
    });
    if (!ok) return;
    try {
      await api(`/api/clients/${encodeURIComponent(id)}/unrevoke`, { method: 'POST' });
      await loadRevoked();
      await loadClients();
    } catch (error) {
      alert(`解除失败: ${error.message}`);
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
      const response = await fetch(apiUrl(`api/agent-config?os=${encodeURIComponent(os)}`), {
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

  function apiUrl(path) {
    return new URL(String(path).replace(/^\/+/, ''), document.baseURI).toString();
  }

  async function api(path, options = {}) {
    const headers = {
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    };
    if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(apiUrl(path), { ...options, headers });
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
      loadAgentVersions().catch(() => {});
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
    if (!state.selected && state.clients.length && !['downloads', 'revoked'].includes(state.view)) {
      const first = state.clients.find((c) => c.status === 'online') || state.clients[0];
      await selectClient(first.id);
    } else if (!state.clients.length && !['downloads', 'revoked'].includes(state.view)) {
      showDownloads();
    }
  }

  function renderClients() {
    const query = $('client-search').value.trim().toLowerCase();
    const status = $('client-status').value;
    const list = state.clients.filter((client) => {
      if (status && client.status !== status) return false;
      if (!query) return true;
      return [client.id, client.name, client.group, client.hostname, client.os, ...(client.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    if (!list.length) {
      clientList.innerHTML = '<div class="muted" style="padding:12px">没有匹配的客户端</div>';
      return;
    }

    // 按客户名分组：同一个安装包复制到多台机器时，name 相同，自然归到一组。
    const groups = new Map();
    for (const client of list) {
      const key = client.group || client.name || client.hostname || client.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(client);
    }

    clientList.innerHTML = [...groups.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b), 'zh-CN'))
      .map(([group, clients]) => {
        const online = clients.filter((client) => client.status === 'online').length;
        const collapsed = state.collapsedGroups.has(group);
        const items = clients
          .map((client) => {
            const label =
              client.displayName && client.displayName !== group
                ? client.displayName
                : client.hostname || client.id;
            const outdated = Boolean(
              state.latestVersion && client.version && client.version !== state.latestVersion,
            );
            const version = client.version
              ? `<span class="version-tag ${outdated ? 'outdated' : ''}">v${escapeHtml(client.version)}${outdated ? ' ↑' : ''}</span>`
              : '';
            const ip = client.primaryIp ? `IP ${escapeHtml(client.primaryIp)}` : '';
            const line = [ip, version].filter(Boolean).join(' · ');
            const fullOs = client.info?.platform || client.os || '';
            const platform = shortOs(fullOs);
            return `
        <div class="client-item ${state.selected?.id === client.id ? 'active' : ''}" data-id="${escapeHtml(client.id)}">
          <div class="name"><span class="dot ${client.status}"></span>${escapeHtml(label)}</div>
          ${line ? `<div class="meta">${line}</div>` : ''}
          ${platform ? `<div class="meta" title="${escapeHtml(fullOs)}">${escapeHtml(platform)}</div>` : ''}
        </div>`;
          })
          .join('');
        return `
        <div class="client-group ${collapsed ? 'collapsed' : ''}">
          <button class="client-group-head" data-group="${escapeHtml(group)}">
            <span class="group-arrow">${collapsed ? '▸' : '▾'}</span>
            <span class="group-name">${escapeHtml(group)}</span>
            <span class="group-count">${online}/${clients.length}</span>
          </button>
          <div class="client-group-body">${items}</div>
        </div>`;
      })
      .join('');

    for (const head of clientList.querySelectorAll('.client-group-head')) {
      head.addEventListener('click', () => {
        const group = head.dataset.group;
        if (state.collapsedGroups.has(group)) state.collapsedGroups.delete(group);
        else state.collapsedGroups.add(group);
        renderClients();
      });
    }
    for (const item of clientList.querySelectorAll('.client-item')) {
      item.addEventListener('click', () => selectClient(item.dataset.id));
    }
  }

  function formatUptime(seconds) {
    const s = Number(seconds) || 0;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天 ${h}小时`;
    if (h > 0) return `${h}小时 ${m}分`;
    return `${m}分`;
  }

  function collectClientIps(client) {
    const result = [];
    const seen = new Set();
    const push = (ip, label) => {
      const value = String(ip || '').split('/')[0].replace(/^::ffff:/, '');
      if (!value || seen.has(value)) return;
      seen.add(value);
      result.push({ ip: value, label: label || '' });
    };
    if (client.primaryIp) push(client.primaryIp, '主 IP');
    if (client.remoteAddress) push(client.remoteAddress, '连接 IP');
    const interfaces = client.info?.network;
    if (Array.isArray(interfaces)) {
      for (const iface of interfaces) {
        for (const addr of iface.addrs || []) push(addr, iface.name || '网卡');
      }
    }
    return result;
  }

  function renderClientInfo() {
    const client = state.selected;
    if (!client) {
      $('client-info').innerHTML = '';
      return;
    }
    const info = client.info || {};
    const memory = info.memory || {};
    const cpu = info.cpu || {};
    const disks = Array.isArray(info.disks) ? info.disks : [];
    const ips = collectClientIps(client);
    const tags = Array.isArray(client.tags) ? client.tags : [];

    const card = (title, lines) => `
      <div class="info-card">
        <h4>${escapeHtml(title)}</h4>
        ${lines.map((line) => `<div class="info-line"><span class="k">${escapeHtml(line.k)}</span><span class="v ${line.cls || ''}">${escapeHtml(line.v)}</span></div>`).join('')}
      </div>`;

    const systemLines = [
      { k: '主机名', v: info.hostname || client.hostname || '-' },
      { k: '系统', v: [info.os, info.platform, info.platformVersion].filter(Boolean).join(' ') || client.os || '-' },
      { k: '内核', v: [info.kernelVersion, info.kernelArch].filter(Boolean).join(' ') || client.arch || '-' },
      { k: '运行时间', v: info.uptimeSec ? formatUptime(info.uptimeSec) : '-' },
      { k: 'Agent', v: info.agentVersion || client.version || '-' },
      { k: '客户端 ID', v: client.id },
    ];
    const networkLines = [
      { k: '连接地址', v: client.remoteAddress || '-' },
      ...ips.slice(0, 8).map((item) => ({ k: item.label || 'IP', v: item.ip, cls: 'info-net-ip' })),
    ];
    if (!networkLines.length) networkLines.push({ k: 'IP', v: '未采集' });
    const cpuLines = [
      { k: 'CPU', v: cpu.model || '-' },
      { k: '核心', v: cpu.logical ? `${cpu.cores || '?'} 物理 / ${cpu.logical} 逻辑` : '-' },
      { k: '负载', v: info.load ? `${info.load.load1 ?? '-'} / ${info.load.load5 ?? '-'} / ${info.load.load15 ?? '-'}` : '-' },
      { k: '内存', v: memory.total ? `${formatBytes(memory.used || 0)} / ${formatBytes(memory.total)} (${Number(memory.percent || 0).toFixed(1)}%)` : '-' },
    ];
    const diskLines = disks.slice(0, 6).map((disk) => ({
      k: disk.mountpoint || disk.device || '磁盘',
      v: `${formatBytes(disk.free || 0)} 可用 / ${formatBytes(disk.total || 0)}`,
    }));
    if (!diskLines.length) diskLines.push({ k: '磁盘', v: '未采集' });

    $('client-info').innerHTML = [
      card('系统信息', systemLines),
      card('网络 / IP', networkLines),
      card('CPU / 内存', cpuLines),
      card('磁盘', diskLines),
    ].join('') + (tags.length
      ? `<div class="info-card"><h4>标签</h4><div class="info-tags">${tags.map((tag) => `<span class="info-tag">${escapeHtml(tag)}</span>`).join('')}</div></div>`
      : '');
  }

  async function refreshClientInfo() {
    if (!state.selected) return;
    const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}?refresh=1`);
    state.selected = data.client;
    $('client-name').textContent = state.selected.displayName || state.selected.name || state.selected.hostname || state.selected.id;
    renderClientMeta();
    renderClientInfo();
    renderVersionBadge();
    renderDiskChips();
    renderClients();
  }

  async function renameClient() {
    if (!state.selected) return;
    const current = state.selected.displayName || state.selected.name || state.selected.hostname || state.selected.id;
    const name = await openDialog({
      title: '重命名客户端',
      message: '只修改 Hub 显示名，不会修改 Agent 上报的主机名。',
      input: current,
      confirmText: '保存',
      icon: '✎',
    });
    if (!name || name.trim() === current) return;
    try {
      const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      state.selected = data.client;
      $('client-name').textContent = state.selected.displayName || state.selected.name || state.selected.id;
      await loadClients();
      renderClientInfo();
      renderClients();
    } catch (error) {
      alert(`重命名失败: ${error.message}`);
    }
  }

  async function loadAgentVersions() {
    try {
      const data = await api('/api/agent-versions');
      state.latestVersion = data.version || '';
    } catch {
      state.latestVersion = '';
    }
    renderVersionBadge();
    renderClients();
  }

  function renderSocks5Yaml() {
    const host = $('socks5-host').value.trim() || '<公网IP>';
    const port = $('socks5-port').value || '1080';
    const user = state.socks5User || '<clientId>';
    const pass = $('socks5-pass').value || '<密码>';
    $('socks5-yaml').textContent = `proxies:
  - name: ops-${user}
    type: socks5
    server: ${host}
    port: ${port}
    username: ${user}
    password: "${pass}"
    udp: false`;
  }

  function renderSocks5(data) {
    const info = data.socks5 || data || {};
    state.socks5 = info;
    const enabled = Boolean(info.enabled);
    const stateEl = $('socks5-state');
    stateEl.textContent = enabled ? 'running' : 'stopped';
    stateEl.className = `badge ${enabled ? 'online' : ''}`;
    $('socks5-toggle').textContent = enabled ? '停用' : '启用';
    $('socks5-toggle').className = enabled ? 'ghost danger' : 'primary-btn';
    const host = String(info.publicHost || info.host || '');
    $('socks5-host').value = host === '0.0.0.0' ? '' : host;
    $('socks5-port').value = Number(info.port) || 1080;
    $('socks5-max').value = Number(info.maxStreamsPerClient) || 16;
    $('socks5-idle').value = Number(info.idleTimeoutSec) || 1800;
    $('socks5-pass').value = info.token || '';
    const clients = info.clients || [];
    if (!state.socks5User || !clients.some((item) => item.id === state.socks5User)) {
      state.socks5User = clients[0]?.id || '';
    }
    $('socks5-user').value = state.socks5User || '';
    $('socks5-client-list').innerHTML = clients.length
      ? clients
          .map(
            (item) => `<div class="socks5-client ${item.id === state.socks5User ? 'active' : ''}" data-socks-client="${escapeHtml(item.id)}">
              <span>${escapeHtml(item.name || item.id)}</span><span class="muted">${escapeHtml(item.id)}</span>
            </div>`,
          )
          .join('')
      : '<div class="muted">没有在线客户端</div>';
    for (const row of $('socks5-client-list').querySelectorAll('[data-socks-client]')) {
      row.addEventListener('click', () => {
        state.socks5User = row.dataset.socksClient;
        $('socks5-user').value = state.socks5User;
        for (const other of $('socks5-client-list').querySelectorAll('.socks5-client')) {
          other.classList.toggle('active', other.dataset.socksClient === state.socks5User);
        }
        renderSocks5Yaml();
      });
    }
    renderSocks5Yaml();
  }

  async function showSocks5() {
    $('socks5-backdrop').classList.remove('hidden');
    $('socks5-client-list').textContent = '加载中...';
    try {
      const data = await api('/api/socks5');
      renderSocks5(data);
    } catch (error) {
      $('socks5-client-list').textContent = `加载失败: ${error.message}`;
    }
  }

  async function toggleSocks5() {
    const enabled = Boolean(state.socks5?.enabled);
    try {
      const data = await api(`/api/socks5/${enabled ? 'disable' : 'enable'}`, { method: 'POST' });
      renderSocks5(data);
    } catch (error) {
      alert(`操作失败: ${error.message}`);
    }
  }

  async function rotateSocks5() {
    const ok = await openDialog({
      title: '重置 SOCKS5 密码',
      message: '重置后所有已配置的 Clash/浏览器都要更新密码。',
      confirmText: '重置',
      danger: true,
      icon: '🔑',
    });
    if (!ok) return;
    try {
      const data = await api('/api/socks5/token', { method: 'POST' });
      renderSocks5(data);
    } catch (error) {
      alert(`重置失败: ${error.message}`);
    }
  }

  async function saveSocks5() {
    try {
      const data = await api('/api/socks5', {
        method: 'PUT',
        body: JSON.stringify({
          publicHost: $('socks5-host').value.trim(),
          port: Number($('socks5-port').value),
          maxStreamsPerClient: Number($('socks5-max').value),
          idleTimeoutSec: Number($('socks5-idle').value),
        }),
      });
      renderSocks5(data);
      alert('已保存。修改端口后需要同步调整容器端口映射。');
    } catch (error) {
      alert(`保存失败: ${error.message}`);
    }
  }

  function renderVersionBadge() {
    const el = $('client-version');
    if (!el) return;
    if (!state.selected) {
      el.className = 'badge version hidden';
      el.textContent = 'v-';
      return;
    }
    const version = String(state.selected.version || '');
    const latest = state.latestVersion;
    const outdated = Boolean(latest && version && version !== latest);
    el.className = `badge version ${outdated ? 'outdated' : 'latest'}`;
    el.textContent = version ? `v${version}` : 'v?';
    el.title = outdated ? `可升级到 v${latest}，点击升级` : '已是最新版本';
    el.onclick = outdated ? () => upgradeClient() : null;

    const button = $('upgrade-client-btn');
    if (button) {
      if (outdated) {
        button.disabled = false;
        button.textContent = '升级';
        button.title = `升级到 v${latest}`;
      } else if (version && latest) {
        button.disabled = true;
        button.textContent = '已最新';
        button.title = '已是最新版本';
      } else {
        button.disabled = false;
        button.textContent = '升级';
        button.title = '升级客户端';
      }
    }
  }

  function renderDiskChips() {
    const wrap = $('file-disks');
    if (!wrap) return;
    const disks = state.selected?.info?.disks || [];
    if (!disks.length) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    const win = isWindows(state.selected);
    wrap.classList.remove('hidden');
    wrap.innerHTML = disks
      .map((disk) => {
        const device = String(disk.device || '').trim();
        const mount = String(disk.mountpoint || '').trim();
        const label = win ? device || mount : mount || device;
        if (!label) return '';
        const diskPath = win ? (label.endsWith('\\') ? label : `${label}\\`) : label;
        const total = Number(disk.total) || 0;
        const free = Number(disk.free) || 0;
        const percent = Math.round(Number(disk.percent) || (total ? ((total - free) / total) * 100 : 0));
        const freeText = total ? ` · ${formatBytes(free)}` : '';
        return `<button class="disk-chip ${percent >= 90 ? 'warn' : ''}" data-disk-path="${escapeHtml(diskPath)}" title="${escapeHtml(label)} 已用 ${percent}%，剩余 ${formatBytes(free)}">
          <span class="disk-name">${escapeHtml(label)}</span>
          <span class="disk-meta">${percent}%${freeText}</span>
        </button>`;
      })
      .join('');
    for (const button of wrap.querySelectorAll('[data-disk-path]')) {
      button.addEventListener('click', () => {
        $('file-path').value = button.dataset.diskPath;
        listFiles().catch((error) => alert(error.message));
      });
    }
  }

  function renderClientMeta() {
    if (!state.selected) return;
    const info = state.selected.info || {};
    const platform = shortOs(info.platform || state.selected.os || '');
    const parts = [];
    if (state.selected.primaryIp) {
      parts.push(`<span class="meta-item">IP ${escapeHtml(state.selected.primaryIp)}</span>`);
    }
    if (platform) {
      parts.push(`<span class="meta-item" title="${escapeHtml(platform)}">${escapeHtml(shorten(platform, 44))}</span>`);
    }
    if (info.uptimeSec) {
      parts.push(`<span class="meta-item">运行 ${escapeHtml(formatUptime(info.uptimeSec))}</span>`);
    }
    if (info.hostname) {
      parts.push(`<span class="meta-item">${escapeHtml(info.hostname)}</span>`);
    }
    $('client-meta').innerHTML = parts.join('');
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
    $('revoked-view').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('client-view').classList.remove('hidden');
    $('client-name').textContent = state.selected.displayName || state.selected.name || state.selected.hostname || state.selected.id;
    renderClientMeta();
    const badge = $('client-badge');
    badge.textContent = state.selected.status;
    badge.className = `badge ${state.selected.status}`;
    renderClientInfo();
    renderVersionBadge();
    renderDiskChips();
    $('file-path').value = isWindows(state.selected) ? 'C:\\' : '/';
    state.filePath = $('file-path').value;
    state.selectedFile = null;
    $('file-selected').textContent = '未选择文件';
    fileOutput.textContent = '';
    $('file-tail-btn').disabled = true;
    $('file-download-btn').disabled = true;
    $('file-delete-btn').disabled = true;
    setFileStatus('上传/下载/删除都在左侧；点击文件行可预览文本');
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
  $('revoked-btn').addEventListener('click', showRevoked);
  $('close-revoked-btn').addEventListener('click', showClientOrEmpty);
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
  $('copy-client-id').addEventListener('click', async () => {
    if (!state.selected) return;
    try {
      await navigator.clipboard.writeText(state.selected.id);
    } catch {
      alert(state.selected.id);
    }
  });
  $('upgrade-client-btn').addEventListener('click', upgradeClient);
  $('socks5-btn').addEventListener('click', showSocks5);
  $('socks5-close').addEventListener('click', () => $('socks5-backdrop').classList.add('hidden'));
  $('socks5-backdrop').addEventListener('click', (event) => {
    if (event.target === $('socks5-backdrop')) $('socks5-backdrop').classList.add('hidden');
  });
  $('socks5-toggle').addEventListener('click', toggleSocks5);
  $('socks5-rotate').addEventListener('click', rotateSocks5);
  $('socks5-save').addEventListener('click', saveSocks5);
  $('socks5-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('socks5-yaml').textContent || '');
      $('socks5-copy').textContent = '已复制';
      setTimeout(() => { $('socks5-copy').textContent = '复制配置'; }, 1500);
    } catch {
      alert('复制失败，请手动选中配置');
    }
  });
  for (const id of ['socks5-host', 'socks5-port']) {
    $(id).addEventListener('input', renderSocks5Yaml);
  }
  $('tunnel-btn').addEventListener('click', showTunnel);
  $('tunnel-close').addEventListener('click', hideTunnel);
  for (const radio of document.querySelectorAll('input[name="tunnel-mode"]')) {
    radio.addEventListener('change', () => setTunnelMode(radio.value));
  }
  $('tunnel-generate').addEventListener('click', generateTunnelCommand);
  $('tunnel-copy').addEventListener('click', copyTunnelCommand);
  $('tunnel-refresh').addEventListener('click', () => loadTunnels().catch((e) => alert(e.message)));
  $('tunnel-backdrop').addEventListener('click', (event) => {
    if (event.target === $('tunnel-backdrop')) hideTunnel();
  });
  $('refresh-client-btn').addEventListener('click', () => refreshClientInfo().catch((e) => alert(e.message)));
  $('rename-client-btn').addEventListener('click', () => renameClient());
  $('delete-client-btn').addEventListener('click', async () => {
    if (!state.selected) return;
    const name = state.selected.name || state.selected.id;
    const ok = await openDialog({
      title: '删除并封禁客户端',
      message: `客户端：${name}\n\n这会吊销 token，Agent 将无法重连。`,
      confirmText: '删除',
      danger: true,
      icon: '🗑',
    });
    if (!ok) return;
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
    const name = state.selected.displayName || state.selected.name || state.selected.hostname || state.selected.id;
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

  function rememberCommand(command) {
    state.historyIndex = -1;
    state.historyDraft = '';
    if (state.cmdHistory[state.cmdHistory.length - 1] !== command) {
      state.cmdHistory.push(command);
      saveCommandHistory();
    }
  }

  function isCdCommand(command) {
    return /^(cd|chdir)(\s|$)/i.test(command);
  }

  function currentCwd() {
    return $('cwd-input').value.trim();
  }

  async function waitJobOutput(jobId, timeoutMs = 20000) {
    let offset = 0;
    let text = '';
    const started = Date.now();
    for (;;) {
      const data = await api(
        `/api/jobs/${encodeURIComponent(jobId)}/output?offset=${offset}&maxBytes=65536`,
      );
      text += data.text || '';
      offset = data.nextOffset;
      if (['exited', 'failed', 'cancelled', 'interrupted', 'lost'].includes(data.job.status)) {
        return { job: data.job, text };
      }
      if (Date.now() - started > timeoutMs) {
        return { job: data.job, text };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  function extractPathFromOutput(text) {
    const lines = String(text || '')
      .split('\n')
      .map((line) => line.replace(/^\[(stdout|stderr)\]\s?/, '').trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!/^(\/|[A-Za-z]:[\\/])/.test(line)) continue;
      if (line === '/' || /^[A-Za-z]:\\?$/.test(line)) return line;
      return line.replace(/[\\/]+$/, '');
    }
    return '';
  }

  function cleanJobText(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.replace(/^\[(stdout|stderr)\]\s?/, ''))
      .join('\n')
      .trim();
  }

  async function changeDirectory(command) {
    if (!state.selected) return;
    const input = $('command-input');
    const raw = command.replace(/^(cd|chdir)\b/i, '').trim();
    const target = raw || '~';
    const prompt = terminalPromptText();
    appendTerminal(`\n${prompt} ${command}\n`);
    input.value = '';
    rememberCommand(command);

    state.terminalBusy = true;
    $('cancel-btn').disabled = false;
    setTerminalStatus('cd', 'running');

    const windows = isWindows(state.selected);
    const shell = $('shell-select').value;
    let probe;
    if (windows) {
      if (shell === 'powershell') {
        const value = target === '~' ? '$HOME' : target.replace(/"/g, '`"');
        probe = `Set-Location -LiteralPath "${value}"; (Get-Location).Path`;
      } else {
        const value = target === '~' ? '%USERPROFILE%' : target.replace(/"/g, '""');
        probe = `cd /d "${value}" && cd`;
      }
    } else {
      const value = target === '~' ? '$HOME' : `'${target.replace(/'/g, "'\\''")}'`;
      probe = `cd -- ${value} && pwd`;
    }

    try {
      const data = await api(`/api/clients/${encodeURIComponent(state.selected.id)}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          command: probe,
          shell: $('shell-select').value || undefined,
          cwd: currentCwd() || undefined,
        }),
      });
      const result = await waitJobOutput(data.job.id);
      const path = extractPathFromOutput(result.text);
      if (result.job.status === 'exited' && path) {
        $('cwd-input').value = path;
        updateTerminalPrompt();
        setTerminalStatus('done', 'done');
        $('job-info').textContent = `cwd=${path}`;
      } else {
        appendTerminal(`${cleanJobText(result.text) || 'cd: 切换目录失败'}\n`);
        setTerminalStatus('error', 'error');
        $('job-info').textContent = `cwd=${currentCwd() || '~'}（未改变）`;
      }
    } catch (error) {
      appendTerminal(`cd: ${error.message}\n`);
      setTerminalStatus('error', 'error');
    } finally {
      state.terminalBusy = false;
      $('cancel-btn').disabled = true;
      focusTerminal();
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
          '  cd <路径>     切换当前目录（后续命令沿用）\n' +
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

    if (isCdCommand(command)) {
      input.value = '';
      await changeDirectory(command);
      return;
    }

    const prompt = terminalPromptText();
    appendTerminal(`\n${prompt} ${command}\n`);
    input.value = '';
    rememberCommand(command);

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
      if (!input.value) input.value = command;
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

  function parentRemotePath(raw, windows) {
    if (!raw) return null;
    if (windows) {
      let p = String(raw).replace(/\//g, '\\').replace(/\\+$/, '');
      if (/^[A-Za-z]:$/.test(p)) return null;
      if (/^[A-Za-z]:\\/.test(p)) {
        const idx = p.lastIndexOf('\\');
        if (idx <= 2) return p.slice(0, 2) + '\\';
        return p.slice(0, idx);
      }
      if (p.startsWith('\\\\')) {
        const parts = p.replace(/^\\\\/, '').split('\\').filter(Boolean);
        if (parts.length <= 2) return null;
        parts.pop();
        return '\\\\' + parts.join('\\');
      }
      return null;
    }
    let p = String(raw).replace(/\/+$/, '');
    if (!p || p === '/') return null;
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx);
  }

  function currentRemotePath() {
    return $('file-path').value.trim() || (isWindows(state.selected) ? 'C:\\' : '/');
  }

  function fileExtension(name) {
    const value = String(name || '').split(/[\\/]/).pop() || '';
    const idx = value.lastIndexOf('.');
    return idx >= 0 ? value.slice(idx + 1).toLowerCase() : '';
  }

  function isPreviewableFile(path) {
    const ext = fileExtension(path);
    const blocked = new Set([
      'gz', 'tgz', 'zip', 'rar', '7z', 'bz2', 'xz', 'zst', 'tar',
      'exe', 'dll', 'so', 'bin', 'iso', 'img', 'jar', 'war', 'class',
      'db', 'sqlite', 'sqlite3', 'pdf', 'png', 'jpg', 'jpeg', 'gif',
      'webp', 'ico', 'bmp', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
    ]);
    return !blocked.has(ext);
  }

  function fileIcon(entry) {
    if (entry.dir) return '📁';
    const ext = fileExtension(entry.name);
    if (['gz', 'tgz', 'zip', 'rar', '7z', 'bz2', 'xz', 'zst', 'tar'].includes(ext)) return '📦';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'].includes(ext)) return '🖼️';
    if (['exe', 'dll', 'so', 'bin', 'jar', 'war'].includes(ext)) return '⚙️';
    return '📄';
  }

  function setFileStatus(text, kind = '') {
    const el = $('file-status');
    if (!el) return;
    el.textContent = text;
    el.className = `muted ${kind}`.trim();
  }

  function navigateUp() {
    if (!state.selected) return;
    const parent = parentRemotePath(currentRemotePath(), isWindows(state.selected));
    if (!parent) return;
    $('file-path').value = parent;
    listFiles().catch((e) => alert(e.message));
  }

  async function listFiles() {
    if (!state.selected) return;
    const path = currentRemotePath();
    state.filePath = path;
    const data = await api(
      `/api/clients/${encodeURIComponent(state.selected.id)}/files?path=${encodeURIComponent(path)}&pattern=${encodeURIComponent($('file-pattern').value.trim())}`,
    );
    const entries = data.entries || [];
    const parent = parentRemotePath(path, isWindows(state.selected));
    $('file-up-btn').disabled = !parent;
    const rows = [];
    if (parent) {
      rows.push(
        '<div class="file-row dir file-up-row" data-up="1"><span>⬆️ 上一级</span><span class="size">..</span></div>',
      );
    }
    for (const entry of entries) {
      rows.push(`
        <div class="file-row ${entry.dir ? 'dir' : ''}" data-path="${escapeHtml(entry.path)}" data-dir="${entry.dir ? '1' : '0'}">
          <span>${fileIcon(entry)} ${escapeHtml(entry.name)}</span>
          <span class="row-actions">
            <span class="size">${entry.dir ? '' : formatBytes(entry.size)} ${escapeHtml(entry.modTime || '')}</span>
            ${entry.dir ? '' : `<button class="row-download" data-download-path="${escapeHtml(entry.path)}" title="下载 ${escapeHtml(entry.name)}">⬇</button>`}
            <button class="row-delete" data-delete-path="${escapeHtml(entry.path)}" data-delete-dir="${entry.dir ? '1' : '0'}" title="删除 ${escapeHtml(entry.name)}">🗑</button>
          </span>
        </div>`);
    }
    if (!entries.length && !parent) {
      rows.push('<div class="muted" style="padding:12px">空目录</div>');
    }
    fileList.innerHTML = rows.join('');
    for (const row of fileList.querySelectorAll('.file-row')) {
      const downloadButton = row.querySelector('[data-download-path]');
      if (downloadButton) {
        downloadButton.addEventListener('click', (event) => {
          event.stopPropagation();
          downloadFile(downloadButton.dataset.downloadPath);
        });
      }
      const deleteButton = row.querySelector('[data-delete-path]');
      if (deleteButton) {
        deleteButton.addEventListener('click', (event) => {
          event.stopPropagation();
          deleteFile(deleteButton.dataset.deletePath, deleteButton.dataset.deleteDir === '1');
        });
      }
      row.addEventListener('click', () => {
        if (row.dataset.up === '1') {
          navigateUp();
        } else if (row.dataset.dir === '1') {
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
    const previewable = isPreviewableFile(path);
    $('file-tail-btn').disabled = !previewable;
    $('file-download-btn').disabled = false;
    $('file-delete-btn').disabled = false;
    fileOutput.textContent = previewable
      ? ''
      : '该文件是压缩包、二进制或媒体文件，不支持文本预览。\n请点击左侧「⬇ 下载」或文件行的 ⬇ 下载到本地。\n';
    if (previewable) {
      tailFile().catch((e) => {
        fileOutput.textContent = `读取失败: ${e.message}`;
      });
      setFileStatus(`已选择 ${path}`, 'ok');
    } else {
      setFileStatus(`压缩/二进制文件：${path}，请下载查看`, '');
    }
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
  $('file-up-btn').addEventListener('click', navigateUp);
  $('file-path').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      listFiles().catch((e) => alert(e.message));
    } else if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      navigateUp();
    }
  });
  async function downloadFile(path) {
    if (!state.selected || !path) return;
    setFileStatus(`下载中: ${path}`, '');
    try {
      const response = await fetch(
        apiUrl(`api/clients/${encodeURIComponent(state.selected.id)}/files/download?path=${encodeURIComponent(path)}`),
        { headers: { Authorization: `Bearer ${state.token}` } },
      );
      if (response.status === 401) {
        showLogin('Token 无效或已过期');
        return;
      }
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          message = data.message || message;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, String(path).split(/[\\/]/).pop() || 'download');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFileStatus(`已下载 ${path} (${formatBytes(blob.size)})`, 'ok');
    } catch (error) {
      setFileStatus(`下载失败: ${error.message}`, 'error');
      alert(`下载失败: ${error.message}`);
    }
  }

  async function deleteFile(path, isDir) {
    if (!state.selected || !path) return;
    const label = isDir ? '目录（含目录下全部内容）' : '文件';
    const ok = await openDialog({
      title: isDir ? '删除目录' : '删除文件',
      message: `${label}：\n${path}\n\n此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
      icon: '🗑',
    });
    if (!ok) return;
    setFileStatus(`删除中: ${path}`, '');
    try {
      await api(
        `/api/clients/${encodeURIComponent(state.selected.id)}/files?path=${encodeURIComponent(path)}&recursive=${isDir ? '1' : '0'}`,
        { method: 'DELETE' },
      );
      setFileStatus(`已删除 ${path}`, 'ok');
      const selected = state.selectedFile;
      if (
        selected &&
        (selected === path ||
          (isDir && (selected.startsWith(`${path}/`) || selected.startsWith(`${path}\\`))))
      ) {
        state.selectedFile = null;
        state.tailCursor = null;
        $('file-selected').textContent = '未选择文件';
        $('file-tail-btn').disabled = true;
        $('file-download-btn').disabled = true;
        $('file-delete-btn').disabled = true;
        fileOutput.textContent = '';
      }
      await listFiles();
    } catch (error) {
      setFileStatus(`删除失败: ${error.message}`, 'error');
      alert(`删除失败: ${error.message}`);
    }
  }

  function setUploadProgress(percent, text) {
    $('upload-progress-wrap').classList.remove('hidden');
    $('upload-progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    $('upload-progress-text').textContent = text;
  }

  function hideUploadProgress(delay = 0) {
    setTimeout(() => {
      $('upload-progress-wrap').classList.add('hidden');
      $('upload-progress-bar').style.width = '0%';
      $('upload-progress-text').textContent = '';
    }, delay);
  }

  const CHUNK_UPLOAD_THRESHOLD = 8 * 1024 * 1024;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function uploadSingleFile(file, targetPath, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'POST',
        apiUrl(`api/clients/${encodeURIComponent(state.selected.id)}/files/upload?path=${encodeURIComponent(targetPath)}&overwrite=1`),
      );
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          // ignore
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.message || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(file);
    });
  }

  function uploadChunk(blob, uploadId, offset, clientId, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'POST',
        apiUrl(
          `api/clients/${encodeURIComponent(clientId)}/files/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${offset}`,
        ),
      );
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          // ignore
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
          return;
        }
        const error = new Error(data.message || `HTTP ${xhr.status}`);
        if (xhr.status === 409 && typeof data.received === 'number') error.received = data.received;
        reject(error);
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(blob);
    });
  }

  async function uploadChunkedFile(file, targetPath, onProgress) {
    const clientId = state.selected.id;
    const init = await api(`api/clients/${encodeURIComponent(clientId)}/files/upload/init`, {
      method: 'POST',
      body: JSON.stringify({ path: targetPath, size: file.size, overwrite: true }),
    });
    const uploadId = init.uploadId;
    const chunkSize = init.chunkSize || CHUNK_UPLOAD_THRESHOLD;
    let offset = 0;

    while (offset < file.size) {
      const end = Math.min(offset + chunkSize, file.size);
      const blob = file.slice(offset, end);
      let attempt = 0;
      let progressed = false;
      let lastError = null;

      while (!progressed) {
        try {
          const result = await uploadChunk(blob, uploadId, offset, clientId, (loaded) => {
            onProgress?.(Math.round(((offset + loaded) / file.size) * 100));
          });
          offset = Number.isFinite(result.received) ? result.received : end;
          progressed = true;
        } catch (error) {
          // 服务端已经确认收到另一段位置（例如上一个分片响应丢了），直接从那里续传。
          if (typeof error.received === 'number' && error.received !== offset) {
            offset = error.received;
            progressed = true;
            break;
          }
          attempt += 1;
          if (attempt >= 4) {
            lastError = error;
            break;
          }
          await sleep(1000 * attempt);
        }
      }
      if (lastError) throw lastError;
      onProgress?.(Math.round((offset / file.size) * 100));
    }

    onProgress?.(99);
    const result = await api(`api/clients/${encodeURIComponent(clientId)}/files/upload/complete`, {
      method: 'POST',
      body: JSON.stringify({ uploadId, overwrite: true }),
    });
    onProgress?.(100);
    return result;
  }

  function uploadFileToClient(file, targetPath, onProgress) {
    if (file.size > CHUNK_UPLOAD_THRESHOLD) {
      return uploadChunkedFile(file, targetPath, onProgress);
    }
    return uploadSingleFile(file, targetPath, onProgress);
  }

  async function handleUploadFiles(fileList) {
    if (!state.selected) return;
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const dir = currentRemotePath();
    const preview = files.length === 1 ? joinRemote(dir, files[0].name) : `${dir}（${files.length} 个文件）`;
    const ok = await openDialog({
      title: '上传文件',
      message: `上传到：\n${preview}`,
      confirmText: '上传',
      icon: '📤',
    });
    if (!ok) return;
    setFileStatus(`准备上传 ${files.length} 个文件...`, '');
    let index = 0;
    try {
      for (const file of files) {
        index += 1;
        setUploadProgress(0, `上传 ${index}/${files.length}: ${file.name} 0%`);
        await uploadFileToClient(file, joinRemote(dir, file.name), (percent) => {
          setUploadProgress(percent, `上传 ${index}/${files.length}: ${file.name} ${percent}%`);
        });
      }
      setFileStatus(`上传完成: ${files.length} 个文件`, 'ok');
      setUploadProgress(100, '上传完成');
      hideUploadProgress(1200);
      await listFiles();
    } catch (error) {
      setFileStatus(`上传失败: ${error.message}`, 'error');
      hideUploadProgress(2000);
      alert(`上传失败: ${error.message}`);
    }
  }

  $('file-tail-btn').addEventListener('click', () => tailFile().catch((e) => alert(e.message)));
  $('file-download-btn').addEventListener('click', () => downloadFile(state.selectedFile));
  $('file-delete-btn').addEventListener('click', () => deleteFile(state.selectedFile, false));

  $('file-upload').addEventListener('change', async (event) => {
    await handleUploadFiles(event.target.files);
    event.target.value = '';
  });

  const dropZone = $('file-drop');
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
    });
  }
  dropZone.addEventListener('drop', (event) => {
    handleUploadFiles(event.dataTransfer?.files);
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
    const urlToken = new URLSearchParams(location.search).get('token');
    if (urlToken) {
      history.replaceState(null, '', location.pathname + location.hash);
      await loginWithToken(urlToken);
      return;
    }
    if (!state.token) {
      showLogin();
      return;
    }
    try {
      await api('/api/auth/check');
      showApp();
      await loadClients();
      loadAgentVersions().catch(() => {});
      setInterval(() => loadClients().catch(() => {}), 15000);
    } catch {
      showLogin();
    }
  }

  init();
})();
