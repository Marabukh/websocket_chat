const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createChatServer } = require('../server');

// Минимальная DOM-модель проверяет клиентскую логику без браузерных зависимостей.
class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
  }
  append(...items) {
    for (const item of items) { item.parent = this; this.children.push(item); }
  }
  remove() {
    if (!this.parent) return;
    const list = this.parent.children;
    list.splice(list.indexOf(this), 1);
    this.parent = null;
  }
  get firstElementChild() { return this.children[0]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  fire(type) { this.listeners[type]({ preventDefault() {} }); }
  focus() {}
}

function createUI(Socket, host = '127.0.0.1:3000') {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  elements.messages.append(elements.empty);
  const document = {
    getElementById: (id) => id === 'empty' && !elements.empty.parent ? null : elements[id],
    createElement: () => new Element(),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/client.js'), 'utf8'), {
    document, WebSocket: Socket, location: { protocol: 'http:', host },
    Date, setTimeout, clearTimeout,
  });
  elements.name.value = 'Анна';
  return elements;
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets = [];
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    static CLOSING = 2;
    constructor() { this.readyState = 0; this.handlers = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, callback) {
      (this.handlers[type] ??= []).push(callback);
    }
    emit(type, event = {}) { for (const callback of this.handlers[type] ?? []) callback(event); }
    open() { this.readyState = 1; this.emit('open'); }
    message(event) { this.emit('message', { data: JSON.stringify(event) }); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 2; }
    drop() { this.readyState = 3; this.emit('close', { code: 1006, reason: 'network' }); }
  }
  const ui = createUI(Socket);
  ui.login.fire('submit');
  return { ui, sockets, tick: (ms) => t.mock.timers.tick(ms) };
}

function welcome(socket) {
  socket.open();
  socket.message({ type: 'welcome', id: 'id', name: 'Анна' });
  socket.message({ type: 'presence', count: 2 });
}

test('задержки 1, 2, 4, 8, 10, 10 с, обратный отсчёт и сброс после welcome', (t) => {
  const { ui, sockets, tick } = setup(t);
  welcome(sockets[0]);
  sockets[0].drop();
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.count.textContent, '—');
  for (const delay of [1, 2, 4, 8, 10, 10]) {
    assert.equal(ui.status.textContent, `Связь потеряна. Повторная попытка через ${delay} с`);
    const count = sockets.length;
    for (let second = delay; second > 1; second--) {
      tick(1000);
      assert.equal(ui.status.textContent, `Связь потеряна. Повторная попытка через ${second - 1} с`);
    }
    tick(999);
    assert.equal(sockets.length, count);
    tick(1);
    assert.equal(sockets.length, count + 1);
    assert.equal(ui.status.textContent, `Переподключение… Попытка ${count}`);
    sockets.at(-1).emit('error');
    sockets.at(-1).emit('error');
    assert.equal(sockets.length, count + 1);
    sockets.at(-1).drop();
  }
  tick(10000);
  const current = sockets.at(-1);
  current.open();
  assert.equal(ui.send.disabled, true);
  assert.deepEqual(current.sent, [{ type: 'join', name: 'Анна' }]);
  current.message({ type: 'welcome', id: 'new' });
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.count.textContent, '—');
  current.message({ type: 'presence', count: 1 });
  assert.equal(ui.count.textContent, 1);
  const text = ui.messages.children.map((e) => e.textContent);
  assert.equal(text.filter((s) => s.includes('Связь потеряна')).length, 1);
  assert.equal(text.filter((s) => s.includes('Соединение восстановлено')).length, 1);
  current.drop();
  assert.match(ui.status.textContent, /через 1 с$/);
});

test('отмена ожидания, ручной вход и запоздалые события старого соединения', (t) => {
  const { ui, sockets, tick } = setup(t);
  const old = sockets[0];
  welcome(old);
  old.drop();
  ui.disconnect.fire('click');
  assert.equal(ui.status.textContent, 'Отключено пользователем');
  tick(60000);
  assert.equal(sockets.length, 1);
  ui.reconnect.fire('click');
  const current = sockets[1];
  welcome(current);
  const before = ui.messages.children.length;
  old.emit('open');
  old.message({ type: 'welcome', id: 'stale' });
  old.message({ type: 'chat', id: 'stale', text: 'Лишнее', time: new Date().toISOString() });
  old.emit('error');
  old.drop();
  tick(60000);
  assert.equal(sockets.length, 2);
  assert.equal(ui.status.textContent, 'Подключено');
  assert.equal(ui.messages.children.length, before);
  for (let i = 0; i < 3; i++) {
    sockets.at(-1).drop();
    tick(1000);
    welcome(sockets.at(-1));
  }
  const active = sockets.at(-1);
  ui.text.value = 'Черновик';
  assert.equal(active.sent.length, 1);
  ui.composer.fire('submit');
  assert.equal(active.sent.filter((e) => e.type === 'chat').length, 1);
  const message = { type: 'chat', id: 'id', text: 'Ответ', time: new Date().toISOString() };
  active.message(message);
  assert.equal(ui.messages.children.length, before + 7);
  ui.disconnect.fire('click');
  active.drop();
  tick(60000);
  assert.equal(ui.status.textContent, 'Отключено пользователем');
});

test('отключение при CONNECTING и отказ во входе не запускают повторы', (t) => {
  const { ui, sockets, tick } = setup(t);
  ui.disconnect.fire('click');
  assert.equal(sockets[0].readyState, 2);
  sockets[0].emit('error');
  sockets[0].drop();
  tick(60000);
  assert.equal(sockets.length, 1);
  ui.login.fire('submit');
  sockets[1].open();
  sockets[1].message({ type: 'error', message: 'Исправьте имя' });
  assert.equal(ui.notice.textContent, 'Исправьте имя');
  assert.equal(ui.name.disabled, false);
  assert.equal(ui.send.disabled, true);
  sockets[1].drop();
  tick(60000);
  assert.equal(sockets.length, 2);
  ui.name.value = 'Борис';
  ui.login.fire('submit');
  sockets[2].open();
  assert.equal(sockets[2].sent[0].name, 'Борис');
});

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Истекло время ожидания клиента');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('реальный сервер: остановка, повторный запуск и автоматический вход двух клиентов', { timeout: 15000 }, async () => {
  let app = createChatServer();
  let a;
  let b;
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  try {
    a = createUI(WebSocket, `127.0.0.1:${port}`);
    b = createUI(WebSocket, `127.0.0.1:${port}`);
    b.name.value = 'Борис';
    a.login.fire('submit');
    b.login.fire('submit');
    await waitFor(() => a.count.textContent === 2 && b.count.textContent === 2);
    a.text.value = 'До обрыва';
    a.composer.fire('submit');
    const chats = (ui) => ui.messages.children.filter((e) => e.className?.startsWith('message'));
    await waitFor(() => chats(b).length === 1);
    b.text.value = 'Не отправлять автоматически';
    await app.close();
    app = null;
    await waitFor(() => a.status.textContent.includes('Повторная попытка'));
    assert.equal(a.send.disabled, true);
    assert.equal(a.count.textContent, '—');
    // Дожидаемся хотя бы одной неуспешной попытки при выключенном сервере.
    await waitFor(() => a.events.children.some((e) => e.textContent.includes('Попытка 1 не завершилась')));
    app = createChatServer();
    app.server.listen(port, '127.0.0.1');
    await once(app.server, 'listening');
    await waitFor(() => a.count.textContent === 2 && b.count.textContent === 2);
    assert.equal(a.status.textContent, 'Подключено');
    assert.equal(b.text.value, 'Не отправлять автоматически');
    assert.equal(chats(a).length, 1);
    b.text.value = 'После восстановления';
    b.composer.fire('submit');
    await waitFor(() => chats(a).length === 2 && chats(b).length === 2);
    assert.equal(chats(a)[1].children[1].textContent, 'После восстановления');
    assert.equal(chats(b)[1].className, 'message own');
  } finally {
    a?.disconnect.fire('click');
    b?.disconnect.fire('click');
    if (app) await app.close();
  }
});
