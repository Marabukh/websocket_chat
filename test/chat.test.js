const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createChatServer } = require('../server');

async function start(t) {
  const app = createChatServer();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `127.0.0.1:${app.server.address().port}`;
  return { base, app };
}

async function client(base) {
  const socket = new WebSocket(`ws://${base}/ws`);
  const events = [];
  const waiters = new Set();
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    for (const check of [...waiters]) check();
  });
  await once(socket, 'open');
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('Не получено ожидаемое событие'));
      }, 3000);
      function check() {
        const event = events.find(predicate);
        if (event) { clearTimeout(timer); waiters.delete(check); resolve(event); }
      }
      waiters.add(check);
      check();
    });
  }
  return { socket, events, wait, send: (event) => socket.send(JSON.stringify(event)) };
}

test('два участника: вход, рассылка, имя сервера, выход и восстановление после ошибки', { timeout: 15000 }, async (t) => {
  const { base } = await start(t);
  const a = await client(base);
  const b = await client(base);
  a.send({ type: 'join', name: ' Анна ' });
  const welcome = await a.wait((e) => e.type === 'welcome');
  assert.equal(welcome.name, 'Анна');
  await a.wait((e) => e.type === 'presence' && e.count === 1);
  assert.equal(b.events.length, 0);
  b.send({ type: 'join', name: 'Борис' });
  await b.wait((e) => e.type === 'welcome');
  await Promise.all([a, b].map((c) => c.wait((e) => e.type === 'presence' && e.count === 2)));
  await a.wait((e) => e.type === 'system' && e.text === 'Борис входит в чат');
  a.send({ type: 'chat', text: 'Привет', name: 'Подмена', time: 'fake' });
  const first = await b.wait((e) => e.type === 'chat' && e.text === 'Привет');
  assert.equal(first.name, 'Анна');
  assert.equal(first.id, welcome.id);
  assert.ok(Number.isFinite(Date.parse(first.time)));
  await a.wait((e) => e.type === 'chat' && e.text === 'Привет');
  b.send({ type: 'chat', text: 'Здравствуйте' });
  await Promise.all([a, b].map((c) => c.wait((e) => e.type === 'chat' && e.text === 'Здравствуйте')));
  a.socket.send('{broken');
  await a.wait((e) => e.type === 'error' && e.message === 'Некорректный JSON.');
  a.send({ type: 'chat', text: 'Сервер работает' });
  await b.wait((e) => e.type === 'chat' && e.text === 'Сервер работает');
  // Ответ ping приходит после предыдущих кадров: проверяем отсутствие лишних копий.
  const pong = once(a.socket, 'pong');
  a.socket.ping();
  await pong;
  for (const c of [a, b]) {
    for (const text of ['Привет', 'Здравствуйте']) {
      assert.equal(c.events.filter((e) => e.type === 'chat' && e.text === text).length, 1);
    }
  }
  const closed = once(b.socket, 'close');
  b.socket.close();
  await closed;
  await a.wait((e) => e.type === 'system' && e.text === 'Борис выходит из чата');
  // Не используем раннее presence=1 от первого входа.
  assert.equal(a.events.filter((e) => e.type === 'presence').at(-1).count, 1);
});

test('валидация, запрет сообщений до входа и повторного входа', { timeout: 15000 }, async (t) => {
  const { base } = await start(t);
  const c = await client(base);
  async function rejected(value, binary = false) {
    const before = c.events.length;
    c.socket.send(binary ? Buffer.from('data') : JSON.stringify(value));
    await c.wait((e) => c.events.indexOf(e) >= before && e.type === 'error');
  }
  await rejected({ type: 'chat', text: 'Рано' });
  for (const value of [null, [], {}, { type: 'other' }, { type: 'join', name: 12 },
    { type: 'join', name: '   ' }, { type: 'join', name: 'а'.repeat(31) }]) await rejected(value);
  await rejected(null, true);
  c.send({ type: 'join', name: 'а'.repeat(30) });
  await c.wait((e) => e.type === 'welcome');
  await rejected({ type: 'join', name: 'Другое имя' });
  for (const text of ['', '  ', 12, 'а'.repeat(1001)]) await rejected({ type: 'chat', text });
  c.send({ type: 'chat', text: 'а'.repeat(1000) });
  await c.wait((e) => e.type === 'chat' && e.text.length === 1000);
  assert.equal(c.events.filter((e) => e.type === 'welcome').length, 1);
});

test('HTTP-файлы, закрытый путь и ограничение WebSocket payload', { timeout: 15000 }, async (t) => {
  const { base } = await start(t);
  for (const [route, type] of [['/', 'text/html'], ['/client.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const response = await fetch(`http://${base}${route}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(`http://${base}/server.js`)).status, 404);
  const c = await client(base);
  const closed = once(c.socket, 'close');
  c.socket.send('x'.repeat(17000));
  assert.equal((await closed)[0], 1009);
  const next = await client(base);
  next.send({ type: 'join', name: 'После ошибки' });
  await next.wait((e) => e.type === 'welcome');
});
