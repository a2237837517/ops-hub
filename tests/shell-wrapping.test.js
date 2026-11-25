import test from 'node:test';
import assert from 'node:assert/strict';

// detectShellWrapping / formatJobOutput 是 mcp/server.js 内部函数，
// 这里通过导出测试专用副本的方式校验。改这两块逻辑时同步更新。
// 为保持源码简洁，直接从文件读出函数体做行为验证。

import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'mcp', 'server.js'),
  'utf8',
);

// 把函数抽出来 eval，避免为了测试给生产代码加一堆导出
function loadFunctions() {
  const start = src.indexOf('function detectShellWrapping');
  const end = src.indexOf('function formatJobOutput');
  assert.ok(start > 0 && end > start, '找不到 detectShellWrapping');
  const code = src.slice(start, end) + '\nreturn detectShellWrapping;';
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

const detect = loadFunctions();

test('Windows: 认出 powershell -Command 套壳', () => {
  const r = detect('powershell -Command "Get-Item \\"C:\\Program Files\\""', 'cmd', 'windows');
  assert.equal(r.wrapped, true);
  assert.equal(r.shell, 'powershell');
  assert.match(r.message, /二次解析/);
  assert.match(r.message, /shell: "powershell"/);
  // 建议里应该是干净的内层命令，不带多余转义
  assert.match(r.message, /Get-Item "C:\\Program Files"/);
});

test('Windows: 认出带 -NoProfile / -ExecutionPolicy 的套壳', () => {
  const r = detect(
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Service OpsHubAgent"',
    'cmd',
    'windows',
  );
  assert.equal(r.wrapped, true);
  assert.equal(r.shell, 'powershell');
});

test('Windows: 认出 cmd /c 套壳', () => {
  const r = detect('cmd /c "dir C:\\"', 'cmd', 'windows');
  assert.equal(r.wrapped, true);
  assert.equal(r.shell, 'cmd');
});

test('Windows: 正常的 PowerShell 语法不误判', () => {
  assert.equal(detect('Get-Item "C:\\Program Files"', 'powershell', 'windows').wrapped, false);
  assert.equal(detect('Get-Service | Where-Object { $_.Status -eq "Running" }', 'powershell', 'windows').wrapped, false);
});

test('Windows: 正常 cmd 命令不误判', () => {
  assert.equal(detect('dir C:\\ /b', 'cmd', 'windows').wrapped, false);
  assert.equal(detect('ipconfig /all', 'cmd', 'windows').wrapped, false);
  assert.equal(detect('netstat -ano | findstr :19001', 'cmd', 'windows').wrapped, false);
});

test('Linux: 认出 sh -c / bash -c 套壳', () => {
  const r = detect('bash -c "ls -la /var/log"', 'bash', 'linux');
  assert.equal(r.wrapped, true);
  assert.match(r.message, /二次解析/);
});

test('Linux: 正常 bash 命令不误判', () => {
  assert.equal(detect('ls -la /var/log', 'bash', 'linux').wrapped, false);
  assert.equal(detect('ps aux | grep java', 'bash', 'linux').wrapped, false);
  assert.equal(detect('df -h', 'bash', 'linux').wrapped, false);
});

test('自动化修正：套壳时自动拆掉外层并切换 shell', () => {
  const r = detect('powershell -Command "Get-Date"', undefined, 'windows');
  assert.equal(r.wrapped, true);
  assert.equal(r.shell, 'powershell');
  assert.equal(r.command, 'Get-Date');
});

test('自动化修正：内层命令还原转义后可执行', () => {
  const r = detect(
    'powershell -Command "Get-Item \\"C:\\Program Files\\" | Select-Object -Expand Name"',
    'cmd',
    'windows',
  );
  assert.equal(r.wrapped, true);
  assert.equal(r.command, 'Get-Item "C:\\Program Files" | Select-Object -Expand Name');
});

test('Linux 套壳自动拆外壳', () => {
  const r = detect('bash -c "df -h"', 'bash', 'linux');
  assert.equal(r.wrapped, true);
  assert.equal(r.shell, 'bash');
  assert.equal(r.command, 'df -h');
});
