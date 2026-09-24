/**
 * 前端主逻辑：WebSocket 客户端、界面状态机、棋盘交互。
 */
import { BoardView } from '/board.js';
import { legalMoves, canPlaceWall, createGame, reasonText, COLORS } from '/shared/engine.js';

const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('quorider.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('quorider.' + key, JSON.stringify(value));
    } catch { /* 忽略隐私模式 */ }
  },
  del(key) {
    try {
      localStorage.removeItem('quorider.' + key);
    } catch { /* 忽略 */ }
  },
};

function makePid() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().slice(0, 36);
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const $ = (sel) => document.querySelector(sel);

const S = {
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 800,
  intentionalClose: false,
  pid: LS.get('pid', null),
  name: LS.get('name', ''),
  roomCode: LS.get('room', null),
  state: null,
  mySeat: -1,
  skew: 0,
  mode: 'move',
  toastTimer: null,
};
if (!S.pid) {
  S.pid = makePid();
  LS.set('pid', S.pid);
}

const board = new BoardView($('#board'));

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function send(obj) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function showScreen(name) {
  $('#screen-home').classList.toggle('active', name === 'home');
  $('#screen-room').classList.toggle('active', name === 'room');
}

function myName() {
  return S.name || '玩家';
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect() {
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(wsUrl());
  S.ws = ws;

  ws.onopen = () => {
    S.reconnectDelay = 800;
    setConn(true);
    // 若之前有房间（含刷新后），自动重连回房
    if (S.roomCode) {
      send({ t: 'join', code: S.roomCode, pid: S.pid, name: myName() });
    }
    // 其他初始化逻辑（例如带 ?pid= 的身份接管）在这里挂接
    window.dispatchEvent(new Event('qdr:ws-open'));
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setConn(false);
    if (S.intentionalClose) return;
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose 会紧随其后 */
  };
}

function scheduleReconnect() {
  if (S.reconnectTimer) return;
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    S.reconnectDelay = Math.min(S.reconnectDelay * 1.6, 8000);
    connect();
  }, S.reconnectDelay);
}

function setConn(ok) {
  const el = $('#conn-state');
  el.classList.toggle('off', !ok);
  $('#conn-text').textContent = ok ? '已连接' : '重连中…';
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'pong':
      return;
    case 'error':
      toast(msg.msg, true);
      // 刷新后自动回房失败：清掉失效的房间码，避免反复报错
      if (!S.state && S.roomCode) {
        S.roomCode = null;
        LS.del('room');
      }
      return;
    case 'kicked':
      S.intentionalClose = true;
      S.roomCode = null;
      LS.del('room');
      toast('你被房主移出了房间', true);
      showScreen('home');
      S.ws?.close();
      return;
    case 'replaced':
      S.intentionalClose = true;
      toast('账号在别处登录，本页面已断开', true);
      showScreen('home');
      return;
    case 'state':
      applyState(msg);
      return;
  }
}

/* ------------------------------------------------------------------ */
/* 状态渲染                                                            */
/* ------------------------------------------------------------------ */

function applyState(st) {
  S.state = st;
  S.skew = (st.serverNow || Date.now()) - Date.now();
  const me = st.players.find((p) => p.pid === S.pid);
  S.mySeat = me && st.seatByPid && st.seatByPid[S.pid] !== undefined ? st.seatByPid[S.pid] : -1;

  // 大厅没有对局对象时，用一份预览棋盘展示站位与中央方块
  let game = st.game;
  if (!game) {
    const contenders = st.players.filter((p) => !p.spectator);
    game = createGame(st.settings, contenders.map((p) => ({ id: p.pid, name: p.name })));
  }
  board.setGame(game, st.phase);
  board.mySeat = S.mySeat;
  board.winnerSeat = st.game?.winner ?? -1;
  board.mode = S.mode;

  showScreen('room');
  // 记住房间，刷新页面后可自动回到对局
  if (S.roomCode !== st.code) {
    S.roomCode = st.code;
    LS.set('room', st.code);
  }
  renderTop(st);
  renderPlayers(st, me);
  renderSettings(st, me);
  renderHostPanel(st, me);
  renderActionbar(st, me);
  renderOverlays(st, me);
  renderLog(st);
  recomputeLegal();
}

function renderTop(st) {
  $('#room-code').textContent = st.code;
  $('#lobby-code').textContent = st.code;
}

function renderPlayers(st, me) {
  const list = $('#player-list');
  list.innerHTML = '';
  const seats = st.game?.seats || [];
  const seatByPid = st.seatByPid || {};
  const contenders = st.players.filter((p) => !p.spectator);
  const spectators = st.players.filter((p) => p.spectator);

  $('#player-count').textContent = `${contenders.length}/${st.settings.maxPlayers}`;

  contenders.forEach((p) => {
    const seat = seatByPid[p.pid];
    const seatInfo = seats[seat];
    const li = document.createElement('li');
    li.className = 'player-item';
    if (p.pid === S.pid) li.classList.add('me');
    if (!p.connected) li.classList.add('off');
    if (st.game && st.phase === 'playing' && st.game.turn === seat) li.classList.add('turn');
    const color = seatInfo ? seatInfo.color : COLORS[seat ?? 0];
    li.style.color = color;

    const ppColor = document.createElement('span');
    ppColor.className = 'pp-color';
    ppColor.style.background = color;
    li.appendChild(ppColor);

    const name = document.createElement('span');
    name.className = 'pp-name';
    name.textContent = p.name;
    li.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'pp-meta';
    if (p.host) {
      const crown = document.createElement('span');
      crown.className = 'pp-crown';
      crown.textContent = '★';
      crown.title = '房主';
      meta.appendChild(crown);
    }
    if (seatInfo && st.phase !== 'lobby') {
      const walls = document.createElement('span');
      walls.className = 'pp-walls';
      walls.textContent = `墙×${seatInfo.wallsLeft}`;
      meta.appendChild(walls);
    }
    if (!p.connected) {
      const off = document.createElement('span');
      off.textContent = '掉线';
      meta.appendChild(off);
    }
    if (me?.host && st.phase === 'lobby' && p.pid !== S.pid) {
      const kick = document.createElement('button');
      kick.className = 'pp-kick';
      kick.type = 'button';
      kick.textContent = '移出';
      kick.onclick = () => send({ t: 'kick', pid: p.pid });
      meta.appendChild(kick);
    }
    li.appendChild(meta);
    list.appendChild(li);
  });

  for (const p of spectators) {
    const li = document.createElement('li');
    li.className = 'player-item spectator';
    if (p.pid === S.pid) li.classList.add('me');
    const dot = document.createElement('span');
    dot.className = 'pp-color';
    dot.style.background = '#3a3a44';
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'pp-name';
    name.textContent = `${p.name}（观众）`;
    li.appendChild(name);
    list.appendChild(li);
  }
}

function settingRows(st) {
  const s = st.settings;
  return [
    ['棋盘', `${s.size} × ${s.size}`],
    ['人数上限', `${s.maxPlayers} 人`],
    ['每人路障', `${s.walls} 面`],
    ['回合限时', s.turnTimer ? `${s.turnTimer} 秒` : '不限时'],
    ['中央方块', s.goalSize >= 2 ? '2 × 2' : '1 格'],
  ];
}

function renderSettings(st, me) {
  const isHost = me?.host;
  const editable = isHost && st.phase !== 'playing';
  $('#settings-lock').classList.toggle('hidden', !!isHost);
  $('#settings-form').classList.toggle('hidden', !editable);
  $('#settings-view').classList.toggle('hidden', !!editable);

  if (editable) {
    $('#s-size').value = String(st.settings.size);
    $('#s-max').value = String(st.settings.maxPlayers);
    $('#s-walls').value = String(st.settings.walls);
    $('#s-timer').value = String(st.settings.turnTimer);
    $('#s-goal').value = String(st.settings.goalSize);
  } else {
    const view = $('#settings-view');
    view.innerHTML = '';
    for (const [k, v] of settingRows(st)) {
      const div = document.createElement('div');
      div.className = 'sv-item';
      const b = document.createElement('b');
      b.textContent = v;
      div.textContent = k;
      div.appendChild(b);
      view.appendChild(div);
    }
  }
}

function renderHostPanel(st, me) {
  const isHost = me?.host;
  const panel = $('#host-panel');
  const start = $('#btn-start');
  const restart = $('#btn-restart');
  const hint = $('#host-hint');

  if (!isHost) {
    panel.querySelector('h3').textContent = '对局控制';
    start.classList.add('hidden');
    restart.classList.add('hidden');
    hint.textContent =
      st.phase === 'lobby'
        ? '等待房主开始游戏…'
        : st.phase === 'finished'
          ? '等待房主重开对局…'
          : '对局进行中';
    return;
  }
  start.classList.toggle('hidden', st.phase !== 'lobby');
  restart.classList.toggle('hidden', st.phase !== 'finished');
  if (st.phase === 'lobby') {
    const contenders = st.players.filter((p) => !p.spectator).length;
    start.disabled = contenders < 2;
    hint.textContent = contenders < 2 ? '至少 2 名玩家即可开始。' : '点击开始，进入对局。';
  } else {
    hint.textContent = '重开将保留玩家与当前设置。';
  }
}

function renderActionbar(st, me) {
  const ti = $('#turn-indicator');
  const dot = $('#ti-dot');
  const text = $('#ti-text');

  const isMyTurn = st.phase === 'playing' && st.game.turn === S.mySeat;
  board.legal = [];
  if (st.phase === 'lobby') {
    dot.style.background = '#8a8a97';
    dot.style.boxShadow = 'none';
    text.textContent = '等待房主开始…';
  } else if (st.phase === 'finished') {
    const winnerSeat = st.game.winner;
    const winner = st.game.seats[winnerSeat];
    dot.style.background = winner?.color || '#8a8a97';
    dot.style.boxShadow = `0 0 10px ${winner?.color}`;
    text.textContent = `${winner?.name} 获胜！`;
  } else {
    const seatInfo = st.game.seats[st.game.turn];
    dot.style.background = seatInfo.color;
    dot.style.boxShadow = `0 0 10px ${seatInfo.color}`;
    text.textContent = me?.spectator
      ? `观众模式 · 轮到 ${seatInfo.name}`
      : isMyTurn
        ? '轮到你行动'
        : `轮到 ${seatInfo.name}`;
  }

  // 路障余量
  const mySeatInfo = st.game?.seats?.[S.mySeat];
  $('#wall-count').textContent = mySeatInfo ? String(mySeatInfo.wallsLeft) : String(st.settings.walls);
  $('#btn-mode-wall').disabled = !mySeatInfo || mySeatInfo.wallsLeft <= 0;

  updateTimer();
}

function updateTimer() {
  const el = $('#ti-timer');
  const st = S.state;
  if (!st || st.phase !== 'playing' || !st.deadline) {
    el.textContent = '';
    el.classList.remove('warn');
    return;
  }
  const remain = Math.max(0, Math.ceil((st.deadline - (Date.now() + S.skew)) / 1000));
  el.textContent = `${remain}s`;
  el.classList.toggle('warn', remain <= 10);
}
setInterval(updateTimer, 250);

function renderOverlays(st, me) {
  const lobby = $('#overlay-lobby');
  const win = $('#overlay-winner');

  lobby.classList.toggle('hidden', st.phase !== 'lobby');
  win.classList.toggle('hidden', st.phase !== 'finished');

  if (st.phase === 'lobby') {
    const preview = $('#seats-preview');
    preview.innerHTML = '';
    const contenders = st.players.filter((p) => !p.spectator);
    for (let i = 0; i < st.settings.maxPlayers; i++) {
      const chip = document.createElement('span');
      chip.className = 'seat-chip';
      const p = contenders[i];
      if (p) {
        const color = COLORS[i % COLORS.length];
        chip.classList.add('taken');
        chip.style.color = color;
        chip.style.borderColor = color;
        chip.style.boxShadow = `0 0 12px ${color}`;
        chip.textContent = p.name.slice(0, 1);
        chip.title = p.name;
      } else {
        chip.textContent = i + 1;
      }
      preview.appendChild(chip);
    }
  }

  if (st.phase === 'finished') {
    const winnerSeat = st.game.winner;
    const winner = st.game.seats[winnerSeat];
    const title = $('#winner-title');
    title.textContent = `${winner?.name} 获胜`;
    title.style.color = winner?.color;
    $('#winner-sub').textContent = '率先触碰到了中央方块';

    const actions = $('#winner-actions');
    actions.innerHTML = '';
    if (me?.host) {
      const again = document.createElement('button');
      again.className = 'btn primary';
      again.textContent = '快速重开';
      again.onclick = () => send({ t: 'restart' });
      actions.appendChild(again);
    } else {
      const wait = document.createElement('span');
      wait.className = 'hint';
      wait.textContent = '等待房主重开…';
      actions.appendChild(wait);
    }
  }
}

function renderLog(st) {
  const list = $('#log-list');
  list.innerHTML = '';
  for (const entry of st.log || []) {
    const li = document.createElement('li');
    li.textContent = entry.text;
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function recomputeLegal() {
  const st = S.state;
  if (!st || st.phase !== 'playing' || S.mySeat < 0) {
    board.legal = [];
    return;
  }
  if (st.game.turn !== S.mySeat) {
    board.legal = [];
    return;
  }
  board.legal = legalMoves(st.game, S.mySeat);
}

function pointerPos(ev) {
  const rect = board.canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function canAct() {
  const st = S.state;
  if (!st || st.phase !== 'playing') return false;
  if (S.mySeat < 0) return false;
  const me = st.players.find((p) => p.pid === S.pid);
  if (me?.spectator) return false;
  return st.game.turn === S.mySeat;
}

board.canvas.addEventListener('pointermove', (ev) => {
  if (!canAct()) {
    board.hoverCell = null;
    board.wallPreview = null;
    return;
  }
  const { x, y } = pointerPos(ev);
  if (S.mode === 'move') {
    board.hoverCell = board.hitCell(x, y);
    board.wallPreview = null;
  } else {
    const hit = board.hitWall(x, y);
    board.hoverCell = null;
    if (hit && hit.score < 0.8) {
      const res = canPlaceWall(S.state.game, S.mySeat, hit.d, hit.r, hit.c);
      board.wallPreview = res.ok
        ? { d: hit.d, r: res.r, c: res.c, ok: true }
        : { d: hit.d, r: res.r ?? hit.r, c: res.c ?? hit.c, ok: false, reason: res.reason };
    } else {
      board.wallPreview = null;
    }
  }
});

board.canvas.addEventListener('pointerleave', () => {
  board.hoverCell = null;
  board.wallPreview = null;
});

board.canvas.addEventListener('click', (ev) => {
  if (!canAct()) {
    if (S.state?.phase === 'playing' && S.state.game.turn !== S.mySeat && S.mySeat >= 0) {
      toast('还没轮到你', true);
    }
    return;
  }
  const { x, y } = pointerPos(ev);
  if (S.mode === 'move') {
    const cell = board.hitCell(x, y);
    if (!cell) return;
    const ok = board.legal.some((m) => m.r === cell.r && m.c === cell.c);
    if (!ok) return;
    send({ t: 'move', to: { r: cell.r, c: cell.c } });
    board.hoverCell = null;
  } else {
    const hit = board.hitWall(x, y);
    if (!hit || hit.score > 0.8) return;
    const res = canPlaceWall(S.state.game, S.mySeat, hit.d, hit.r, hit.c);
    if (!res.ok) {
      toast(reasonText(res.reason), true);
      return;
    }
    send({ t: 'wall', wall: { d: hit.d, r: res.r, c: res.c } });
    board.wallPreview = null;
    setMode('move');
  }
});

function setMode(mode) {
  S.mode = mode;
  board.mode = mode;
  $('#btn-mode-move').classList.toggle('active', mode === 'move');
  $('#btn-mode-wall').classList.toggle('active', mode === 'wall');
  board.wallPreview = null;
  board.hoverCell = null;
}
$('#btn-mode-move').addEventListener('click', () => setMode('move'));
$('#btn-mode-wall').addEventListener('click', () => setMode('wall'));

/* 顶栏 */
$('#room-code-btn').addEventListener('click', async () => {
  const code = $('#room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast(`邀请码已复制：${code}`);
  } catch {
    // 非 HTTPS 环境的回退方案
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* 忽略 */ }
    ta.remove();
    toast(ok ? `邀请码已复制：${code}` : `邀请码：${code}（请手动复制）`, !ok);
  }
});

$('#btn-leave').addEventListener('click', () => {
  S.intentionalClose = true;
  send({ t: 'leave' });
  S.roomCode = null;
  LS.del('room');
  showScreen('home');
  setTimeout(() => {
    S.intentionalClose = false;
    connect();
  }, 300);
});

/* 首页表单 */
$('#form-create').addEventListener('submit', (ev) => {
  ev.preventDefault();
  S.name = ($('#in-create-name').value || '').trim() || '玩家';
  LS.set('name', S.name);
  const settings = {
    size: Number($('#in-size').value),
    walls: Number($('#in-walls').value),
    goalSize: Number($('#in-goal').value),
    turnTimer: Number($('#in-timer').value),
    maxPlayers: Number($('#in-max-players').value),
  };
  connect();
  send({ t: 'create', pid: S.pid, name: S.name, settings });
});

$('#form-join').addEventListener('submit', (ev) => {
  ev.preventDefault();
  S.name = ($('#in-join-name').value || '').trim() || '玩家';
  LS.set('name', S.name);
  const code = ($('#in-join-code').value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) {
    toast('邀请码应为 5 位字符', true);
    return;
  }
  connect();
  send({ t: 'join', code, pid: S.pid, name: S.name });
});

/* 房间设置提交 */
$('#settings-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  send({
    t: 'settings',
    settings: {
      size: Number($('#s-size').value),
      walls: Number($('#s-walls').value),
      goalSize: Number($('#s-goal').value),
      turnTimer: Number($('#s-timer').value),
      maxPlayers: Number($('#s-max').value),
    },
  });
  toast('设置已保存');
});

$('#btn-start').addEventListener('click', () => send({ t: 'start' }));
$('#btn-restart').addEventListener('click', () => send({ t: 'restart' }));

/* 渲染循环 */
function frame(time) {
  board.draw(time);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* 启动 */

/** 允许用 ?pid= 指定身份：换设备/换浏览器时也能回到原来的座位。 */
function adoptPidFromUrl() {
  const raw = new URLSearchParams(location.search).get('pid');
  if (!raw || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return false;
  if (raw === S.pid) return true; // 已经是这个身份，无需改写
  S.pid = raw;
  LS.set('pid', raw);
  return true;
}

(function init() {
  const hasPidParam = adoptPidFromUrl();
  // 预填昵称
  $('#in-create-name').value = S.name;
  $('#in-join-name').value = S.name;

  // 深链 ?r=CODE
  const params = new URLSearchParams(location.search);
  const deepCode = (params.get('r') || '').toUpperCase();
  if (deepCode) {
    $('#in-join-code').value = deepCode;
  }

  // ?pid= + ?r= 一起用时，连上就用这个身份回座（等价于「带着座位换设备」）
  if (hasPidParam && deepCode) {
    window.addEventListener('qdr:ws-open', () => {
      send({ t: 'join', code: deepCode, pid: S.pid, name: myName() });
    }, { once: true });
  }

  connect();
})();
