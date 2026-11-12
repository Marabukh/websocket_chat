const $ = (id) => document.getElementById(id);
let socket;
let memberId = null;
let lastName = '';
let autoReconnect = false;
let retryTimer = null;
let retryAttempt = 0;
let nextDelay = 1;
let connectionLost = false;

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
  const busy = autoReconnect || (socket && socket.readyState !== WebSocket.CLOSED);
  $('text').disabled = !active;
  $('send').disabled = !active;
  $('disconnect').disabled = !autoReconnect;
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

function cancelRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
}

function localSystem(text) {
  addMessage({ type: 'system', text, time: new Date().toISOString() });
}

function scheduleRetry() {
  if (!autoReconnect || retryTimer !== null) return;
  const delay = nextDelay;
  nextDelay = Math.min(nextDelay * 2, 10);
  retryAttempt += 1;
  const deadline = Date.now() + delay * 1000;
  log('•', `Попытка ${retryAttempt} запланирована через ${delay} с`);
  function tick() {
    retryTimer = null;
    if (!autoReconnect) return;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) { connect(); return; }
    setState('waiting', `Связь потеряна. Повторная попытка через ${remaining} с`);
    retryTimer = setTimeout(tick, Math.min(1000, deadline - Date.now()));
  }
  tick();
}

function startConnection(name) {
  if (autoReconnect || (socket && socket.readyState !== WebSocket.CLOSED)) return;
  cancelRetry();
  lastName = name;
  autoReconnect = true;
  retryAttempt = 0;
  nextDelay = 1;
  connectionLost = false;
  $('notice').textContent = '';
  connect();
}

function connect() {
  if (!autoReconnect) return;
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  memberId = null;
  const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = current;
  const label = retryAttempt ? `Переподключение… Попытка ${retryAttempt}` : 'Подключение…';
  setState('connecting', label);
  log('•', label);
  current.addEventListener('open', () => {
    if (socket !== current) return;
    log('•', 'Соединение открыто');
    send({ type: 'join', name: lastName });
  });
  current.addEventListener('message', ({ data }) => {
    if (socket !== current) return;
    log('←', data);
    let event;
    try { event = JSON.parse(data); }
    catch { $('notice').textContent = 'Сервер прислал некорректный JSON.'; return; }
    if (event.type === 'welcome') {
      if (memberId !== null) return;
      memberId = event.id;
      log('•', `Вход подтверждён${retryAttempt ? `; попытка ${retryAttempt} успешна` : ''}`);
      cancelRetry();
      retryAttempt = 0;
      nextDelay = 1;
      $('notice').textContent = '';
      setState('online', 'Подключено');
      if (connectionLost) {
        localSystem('Соединение восстановлено. Сообщения за время отсутствия не восстановлены');
        connectionLost = false;
      }
      $('text').focus();
    } else if (event.type === 'presence') {
      if (memberId !== null) $('count').textContent = event.count;
    } else if (event.type === 'chat' || event.type === 'system') {
      // Сообщения, включая собственные, добавляются только из рассылки сервера.
      if (memberId !== null) addMessage(event);
    } else if (event.type === 'error') {
      $('notice').textContent = event.message;
      if (memberId === null) {
        autoReconnect = false;
        cancelRetry();
        log('•', `Вход отклонён: ${event.message}`);
        // Отсоединяем обработчики логически до close, чтобы разрешить исправить имя.
        socket = null;
        current.close(1000, 'Join rejected');
        setState('error', 'Ошибка входа. Исправьте имя');
        $('name').focus();
      }
    }
  });
  current.addEventListener('error', () => {
    if (socket !== current) return;
    log('•', 'Ошибка соединения');
    $('notice').textContent = 'Ошибка соединения. Проверьте, запущен ли сервер.';
    setState('error', 'Ошибка');
  });
  current.addEventListener('close', (event) => {
    if (socket !== current) return;
    log('•', `Соединение закрыто: код ${event.code}, причина: ${event.reason || 'не указана'}`);
    if (retryAttempt) log('•', `Попытка ${retryAttempt} не завершилась входом`);
    socket = null;
    memberId = null;
    if (!autoReconnect) return;
    if (!connectionLost) {
      localSystem('Связь потеряна. Выполняется автоматическое переподключение');
      connectionLost = true;
    }
    scheduleRetry();
  });
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (name && name.length <= 30) startConnection(name);
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (memberId && text && text.length <= 1000 && send({ type: 'chat', text })) $('text').value = '';
});
$('disconnect').addEventListener('click', () => {
  autoReconnect = false;
  cancelRetry();
  const previous = socket;
  socket = null;
  if (previous && previous.readyState < WebSocket.CLOSING) previous.close(1000, 'User disconnected');
  log('•', 'Отключено пользователем; повторные попытки отменены');
  memberId = null;
  setState('offline', 'Отключено пользователем');
});
$('reconnect').addEventListener('click', () => startConnection($('name').value.trim() || lastName));
setState('offline', 'Отключено');
