'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_DIR = path.join(__dirname, '..', 'public', 'dashboard');

function loadDashboardScript(file, context) {
  const code = fs.readFileSync(path.join(DASHBOARD_DIR, file), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: file });
}

test('audit dash-panels-4: status view registers even when localStorage access throws', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  const FDSA = { h() {}, s() {}, fmt: {}, views: {}, on() {}, charts: {} };
  const window = { FDSA };
  const context = { window, localStorage: blocked };

  assert.doesNotThrow(() => loadDashboardScript('status.js', context));
  assert.equal(typeof window.FDSA.views.status, 'object');
  assert.ok(window.FDSA.views.status, 'F.views.status must be registered');
});

test('no scrollbar is drawn anywhere; long commands wrap instead of scrolling', () => {
  const css = fs.readFileSync(path.join(DASHBOARD_DIR, 'app.css'), 'utf8');
  assert.match(css, /^\* \{ scrollbar-width: none; \}$/m, 'scrollbars are hidden for every element');
  assert.match(css, /^\*::-webkit-scrollbar \{ display: none; \}$/m, 'and in WebKit and Blink');
  assert.match(css, /\.code-line code \{[^}]*white-space: pre-wrap;/, 'a long command wraps');
  assert.doesNotMatch(css, /::-webkit-scrollbar-thumb/, 'no scrollbar is styled back in');
  const core = fs.readFileSync(path.join(DASHBOARD_DIR, 'core.js'), 'utf8');
  assert.match(core, /F\.scrollEdges = /, 'scrollable areas mark the edges that have more past them');
});

test('dashboard Chinese covers every English string and translates the main navigation', () => {
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const navigator = { language: 'en-US' };
  const window = { FDSA: {} };
  loadDashboardScript('i18n.js', { window, localStorage, navigator });
  const { en, zh } = window.FDSA.I18N;
  const t = window.FDSA.t;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], 'string', key);
    assert.ok(zh[key].trim(), `empty Chinese for ${key}`);
  }
  for (const key of ['Chat', 'Status', 'Accounts', 'Usage', 'Requests', 'Settings']) {
    assert.equal(en[key], key, key);
    assert.notEqual(zh[key], en[key], key);
  }
  assert.equal(window.FDSA.lang.get(), 'en');
  assert.equal(t('Chat'), 'Chat');
  assert.equal(t('not a stored sentence'), 'not a stored sentence');
  navigator.language = 'zh-CN';
  assert.equal(window.FDSA.lang.get(), 'zh');
  assert.equal(t('Settings'), '设置');
  assert.equal(t('{n} accounts', { n: 4 }), '4 个账号');
  localStorage.setItem('fdsa.lang', 'en');
  assert.equal(window.FDSA.lang.get(), 'en', 'a stored choice wins over the browser language');
  assert.equal(t('Chat'), 'Chat');
  const saved = zh.Chat;
  delete zh.Chat;
  localStorage.setItem('fdsa.lang', 'zh');
  assert.equal(t('Chat'), 'Chat', 'a missing Chinese string falls back to English');
  zh.Chat = saved;
  assert.equal(Object.getPrototypeOf(en), null);
  assert.equal(Object.getPrototypeOf(zh), null);
  assert.equal(t('{toString} {constructor}', {}), '{toString} {constructor}');
});


test('the dashboard uses private web routes and no longer advertises external LLM endpoints', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const chat = fs.readFileSync(path.join(DASHBOARD_DIR, 'chat.js'), 'utf8');
  const settings = fs.readFileSync(path.join(DASHBOARD_DIR, 'settings.js'), 'utf8');
  const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8');
  assert.match(server, /const acceptedPostPaths = \['\/app\/chat'\]/);
  assert.match(server, /web_interface_only/);
  assert.doesNotMatch(server, /acceptedPostPaths = \[[^\]]*\/v1\//);
  assert.match(chat, /fetch\('\/app\/chat'/);
  assert.match(chat, /'\/app\/models'/);
  assert.doesNotMatch(chat, /\/v1\/(chat\/completions|messages|responses)/);
  assert.doesNotMatch(settings, /OpenAI SDK|Anthropic SDK|\/v1\/chat\/completions/);
  assert.doesNotMatch(index, /data-nav="agents"|view-agents|dashboard\/agents\.js/);
});

test('workspace download URLs render as clickable same-origin markdown links', () => {
  const markdown = fs.readFileSync(path.join(DASHBOARD_DIR, 'markdown.js'), 'utf8');
  assert.match(markdown, /new URL\(url, currentOrigin\)/);
  assert.match(markdown, /u\.origin === currentOrigin/);
});

test('the chat exposes workspace mode and sends its state with chat requests', () => {
  const chat = fs.readFileSync(path.join(DASHBOARD_DIR, 'chat.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8');
  assert.ok(chat.includes('fdsa.chat.workMode'));
  assert.ok(chat.includes('workspace_mode: S.workMode'));
  assert.ok(chat.includes("F.iconBtn('workspace'"));
  assert.ok(server.includes('rawParams.workspace_mode === true'));
  assert.ok(server.includes('runWorkspaceAgentLoop'));
  assert.ok(server.includes('workspaceForAgent'));
  assert.ok(index.includes('id="i-workspace"'));
});
