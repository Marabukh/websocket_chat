const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
};

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= limit ? text : null;
}

function validateMessage(data, binary) {
  if (binary) throw new Error('Ожидается текстовый JSON.');
  let message;
  try { message = JSON.parse(data.toString()); }
  catch { throw new Error('Некорректный JSON.'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Ожидается объект события.');
  }
  if (message.type === 'join') {
    const name = cleanText(message.name, 30);
    if (!name) throw new Error('Имя должно содержать от 1 до 30 символов.');
    return { type: 'join', name };
  }
  if (message.type === 'chat') {
    const text = cleanText(message.text, 1000);
    if (!text) throw new Error('Текст должен содержать от 1 до 1000 символов.');
    return { type: 'chat', text };
  }
  throw new Error('Неизвестный тип события.');
}

function createChatServer() {
  const server = http.createServer(async (request, response) => {
    const asset = assets[request.url];
    if (!asset || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await fs.readFile(path.join(__dirname, 'public', asset[0]));
      response.writeHead(200, {
        'Content-Type': asset[1],
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500).end('Unable to read asset');
    }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const members = new Map();

  function send(socket, event) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event), (error) => {
      if (error) socket.terminate();
    });
  }

  function broadcast(event) {
    for (const socket of members.keys()) send(socket, event);
  }

  function presence() {
    broadcast({ type: 'presence', count: members.size });
  }

  wss.on('connection', (socket) => {
    socket.on('error', (error) => {
      console.error('Ошибка WebSocket:', error.message);
      socket.terminate();
    });
    socket.on('message', (data, binary) => {
      let message;
      try { message = validateMessage(data, binary); }
      catch (error) { send(socket, { type: 'error', message: error.message }); return; }

      if (message.type === 'join') {
        if (members.has(socket)) {
          send(socket, { type: 'error', message: 'Вы уже вошли в чат.' });
          return;
        }
        const member = { id: randomUUID(), name: message.name };
        members.set(socket, member);
        send(socket, { type: 'welcome', ...member });
        broadcast({ type: 'system', text: `${member.name} входит в чат`, time: new Date().toISOString() });
        presence();
        return;
      }
      const member = members.get(socket);
      if (!member) {
        send(socket, { type: 'error', message: 'Сначала войдите в чат.' });
        return;
      }
      // Имя и время назначает сервер; клиент присылает только текст.
      broadcast({ type: 'chat', ...member, text: message.text, time: new Date().toISOString() });
    });
    socket.on('close', () => {
      const member = members.get(socket);
      if (!member) return;
      members.delete(socket);
      broadcast({ type: 'system', text: `${member.name} выходит из чата`, time: new Date().toISOString() });
      presence();
    });
  });
  wss.on('error', (error) => console.error('Ошибка сервера WebSocket:', error.message));

  async function close() {
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    ]);
  }
  return { server, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT должен быть целым числом от 1 до 65535.');
    process.exitCode = 1;
  } else {
    const app = createChatServer();
    app.server.on('error', (error) => {
      console.error('Не удалось запустить HTTP-сервер:', error.message);
      process.exitCode = 1;
    });
    app.server.listen(port, '127.0.0.1', () => console.log(`Чат: http://127.0.0.1:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => app.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      }));
    }
  }
}

module.exports = { createChatServer };
