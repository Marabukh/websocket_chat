const $ = (id) => document.getElementById(id);
let socket;
let memberId = null;
let lastName = '';
let failed = false;

function log(direction, payload) {
  const entry = document.createElement('li');
  entry.textContent = `${new Date().toLocaleTimeString('ru-RU')} ${direction} ${payload}`;
  $('events').append(entry);
  while ($('events').children.length > 100) $('events').firstElementChild.remove();
  $('events').scrollTop = $('events').scrollHeight;
}

function setState(state, label) {
  $('status').dataset.state = state;
  $('status').textContent = label;
  const active = state === 'online' && memberId !== null;
  const busy = socket && socket.readyState !== WebSocket.CLOSED;
  $('text').disabled = !active;
  $('send').disabled = !active;
  $('disconnect').disabled = !busy || socket.readyState === WebSocket.CLOSING;
  $('connect').disabled = Boolean(busy);
  $('name').disabled = Boolean(busy);
  $('login').hidden = active;
  $('reconnect').hidden = !lastName || Boolean(busy);
  if (!active) $('count').textContent = '—';
}

function send(event) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    const json = JSON.stringify(event);
    socket.send(json);
    log('→', json);
    return true;
  } catch {
    $('notice').textContent = 'Не удалось отправить сообщение.';
    return false;
  }
}

function addMessage(event) {
  $('empty')?.remove();
  const time = new Date(event.time).toLocaleTimeString('ru-RU');
  const element = document.createElement(event.type === 'system' ? 'p' : 'article');
  if (event.type === 'system') {
    element.className = 'system';
    element.textContent = `${time} · ${event.text}`;
  } else {
    element.className = `message${event.id === memberId ? ' own' : ''}`;
    const meta = document.createElement('small');
    meta.textContent = `${event.name} · ${time}`;
    const text = document.createElement('p');
    text.textContent = event.text;
    element.append(meta, text);
  }
  $('messages').append(element);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function connect(name) {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  lastName = name;
  failed = false;
  memberId = null;
  $('notice').textContent = '';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  setState('connecting', 'Подключение');
  log('•', 'Подключение');
  socket.addEventListener('open', () => {
    log('•', 'Соединение открыто');
    send({ type: 'join', name });
  });
  socket.addEventListener('message', ({ data }) => {
    log('←', data);
    let event;
    try { event = JSON.parse(data); }
    catch { $('notice').textContent = 'Сервер прислал некорректный JSON.'; return; }
    if (event.type === 'welcome') {
      memberId = event.id;
      setState('online', 'Подключено');
      $('text').focus();
    } else if (event.type === 'presence') {
      $('count').textContent = event.count;
    } else if (event.type === 'chat' || event.type === 'system') {
      // Сообщения, включая собственные, добавляются только из рассылки сервера.
      addMessage(event);
    } else if (event.type === 'error') {
      $('notice').textContent = event.message;
      if (!memberId) { failed = true; socket.close(); setState('error', 'Ошибка'); }
    }
  });
  socket.addEventListener('error', () => {
    failed = true;
    log('•', 'Ошибка соединения');
    $('notice').textContent = 'Ошибка соединения. Проверьте, запущен ли сервер.';
    setState('error', 'Ошибка');
  });
  socket.addEventListener('close', (event) => {
    log('•', `Соединение закрыто: ${event.code}`);
    memberId = null;
    setState(failed ? 'error' : 'offline', failed ? 'Ошибка' : 'Отключено');
  });
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (name && name.length <= 30) connect(name);
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (memberId && text && text.length <= 1000 && send({ type: 'chat', text })) $('text').value = '';
});
$('disconnect').addEventListener('click', () => {
  socket?.close(1000, 'User disconnected');
  memberId = null;
  setState('offline', 'Отключено');
});
$('reconnect').addEventListener('click', () => connect(lastName));
setState('offline', 'Отключено');
