import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function mainViewIds() {
  // .main 下所有 id 以 -view 结尾的 section，加上 #empty
  const ids = new Set();
  for (const m of indexHtml.matchAll(/id="([a-z0-9-]+-view)"/g)) ids.add(m[1]);
  if (/id="empty"/.test(indexHtml)) ids.add('empty');
  return [...ids].sort();
}

test('switchView 的 VIEWS 必须覆盖 index.html 里所有主视图', () => {
  const match = appJs.match(/function switchView\(target\)[\s\S]*?const VIEWS = \[([^\]]+)\]/);
  assert.ok(match, '找不到 switchView 里的 VIEWS 定义');
  const declared = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .sort();
  const actual = mainViewIds();
  assert.deepEqual(
    declared,
    actual,
    `VIEWS 和实际的主视图不一致。\n声明: ${declared.join(', ')}\n实际: ${actual.join(', ')}\n` +
      '新增视图时记得同时加进 switchView 的 VIEWS，否则会出现两个视图叠在一起。',
  );
});

test('主视图只能通过 switchView 控制，不能手工逐个隐藏', () => {
  // 允许出现的切换写法只有 switchView(...)
  const forbidden = [];
  for (const m of appJs.matchAll(/\$\('([a-z0-9-]+-view|empty)'\)\.classList\.(add|remove)\('hidden'\)/g)) {
    forbidden.push(m[0]);
  }
  assert.deepEqual(
    forbidden,
    [],
    `发现手工控制主视图可见性的代码，请改用 switchView()：\n  ${forbidden.join('\n  ')}\n` +
      '手工隐藏漏一个就会两个视图叠加显示（已踩过两次：proxy-view、settings-view）。',
  );
});

test('app.js / style.css 的版本号一致且带缓存戳', () => {
  const appMatch = indexHtml.match(/app\.js\?v=([\w]+)/);
  const cssMatch = indexHtml.match(/style\.css\?v=([\w]+)/);
  assert.ok(appMatch, 'index.html 里 app.js 缺少 ?v= 缓存戳');
  assert.ok(cssMatch, 'index.html 里 style.css 缺少 ?v= 缓存戳');
  assert.equal(appMatch[1], cssMatch[1], 'app.js 和 style.css 的版本号应保持一致');
});
