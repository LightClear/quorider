/**
 * 前端主逻辑：WebSocket 客户端、界面状态机、棋盘交互。
 */
import { BoardView } from '/board.js';
import {
  legalMoves,
  canPlaceWall,
  canPlaceTrap,
  createGame,
  reasonText,
  COLORS,
  ITEM_META,
  ITEM_KIND,
} from '/shared/engine.js';

const ITEM_BY_KIND = new Map(ITEM_META.map((m) => [m.kind, m]));

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
  mode: 'move',        // 'move' | 'wall' | 'break' | 'trap'
  itemMode: null,      // 当前选中的道具 kind（null 表示没在用道具）
  selectedSlot: -1,    // 道具栏里被选中的槽位
  toastTimer: null,
  danmakuSeq: 0,       // 已经播放到的弹幕序号（服务端每条弹幕带单调递增的 seq）
  danmakuPrimed: false,// 本次连接是否已经「跳过历史弹幕」对齐过序号
  reactionTarget: null,
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
    // 新连接先把弹幕「对齐」标记清掉：下一条 state 里的历史弹幕只用来记序号、
    // 不播放。否则刷新/重连时会把房间里的旧弹幕一次性全放出来。
    S.danmakuPrimed = false;
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
    case 'danmaku':
      // 弹幕是独立帧（服务端直接推给所有人，不重发整份 state）
      playDanmaku(msg.entry);
      return;
    case 'reaction':
      // 兼容独立帧；实际服务端把 reaction 挂在 state 上，见 applyState
      if (msg.reaction) showReaction(msg.reaction);
      return;
  }
}

/* ------------------------------------------------------------------ */
/* 弹幕                                                                */
/* ------------------------------------------------------------------ */

/**
 * 播放一条弹幕，按 seq 去重后交给 pushDanmaku。
 *
 * 同一条弹幕有两条到达路径：实时帧 `t:'danmaku'`，以及之后某个 state 里的历史数组。
 * 只按「数组下标/条数」判断会把同一条播两遍，所以统一用服务端给的 seq 比对。
 */
function playDanmaku(entry) {
  if (!entry) return;
  const seq = Number(entry.seq);
  if (Number.isFinite(seq)) {
    if (seq <= S.danmakuSeq) return; // 放过了，跳过
    S.danmakuSeq = seq;
  }
  pushDanmaku(entry);
}

/**
 * 播放一条弹幕：从屏幕最右侧之外冒出来，一路左移到完全移出屏幕左侧。
 * 文字格式就是需求里的「玩家名称：弹幕内容」，颜色用发送者座位的颜色。
 *
 * 起止位移都由**实测宽度**算出来，不能写死：
 *   - 起点 translateX(span)：整条弹幕的左边缘贴到弹幕层右边缘之外，
 *     靠 .danmaku-layer 的 overflow:hidden 藏住，看起来就是「从右边冒出来」；
 *   - 终点 translateX(-width)：整条弹幕的右边缘移到屏幕左边缘，才算完全移出。
 * 注意：位移必须通过 CSS 变量交给 keyframes 用。
 * 如果在元素上直接写 transform，会被动画的 from 覆盖掉
 * （动画在层叠里比行内样式优先级更高），结果弹幕就从屏幕左边冒出来了。
 */
function pushDanmaku(entry) {
  const layer = $('#danmaku-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'danmaku-item' + (entry.system ? ' system' : '');
  el.textContent = entry.system ? entry.text : `${entry.name}：${entry.text}`;
  el.style.color = entry.color || '#ececf2';
  layer.appendChild(el);
  el.style.top = `${danmakuLane()}px`;

  // 弹幕层的实际宽度才是「屏幕宽度」（有滚动条时比 window.innerWidth 小）
  const span = layer.clientWidth || window.innerWidth || 0;
  const width = el.offsetWidth || 200;
  const fromX = span;
  const toX = -width;
  const distance = fromX - toX;

  el.style.setProperty('--from-x', `${fromX}px`);
  el.style.setProperty('--to-x', `${toX}px`);
  // 速度按像素恒定：屏幕越宽走得越久，观感才一致（7~18 秒兜住极端宽度）
  const duration = Math.max(7, Math.min(18, distance / 110));
  el.style.animation = `danmaku-fly ${duration}s linear forwards`;
  setTimeout(() => el.remove(), duration * 1000 + 150);
}

/** 弹幕轨道：在屏幕上半部分错开，避免互相完全重叠。 */
function danmakuLane() {
  const lanes = 7;
  const idx = pushDanmaku.lane = ((pushDanmaku.lane || 0) + 1) % lanes;
  const top = 70 + idx * 42;
  return Math.min(top, Math.max(70, window.innerHeight * 0.55));
}

/* ------------------------------------------------------------------ */
/* 头像互动特效                                                        */
/* ------------------------------------------------------------------ */

const REACTION_FX = {
  poop: { icon: '💩', label: '被扔了一坨大便', count: 7 },
  bomb: { icon: '💣', label: '被炸了一下', count: 7 },
  heart: { icon: '❤️', label: '收到了爱心', count: 9 },
  rose: { icon: '🌹', label: '收到了玫瑰', count: 7 },
  coffee: { icon: '☕', label: '被请了一杯咖啡', count: 6 },
};

function showReaction(ev) {
  const fx = REACTION_FX[ev.kind];
  if (!fx) return;
  const layer = $('#fx-layer');
  const label = ev.mine
    ? `你向 ${ev.toName} 发出了 ${fx.icon}`
    : `${ev.fromName} 向你发出了 ${fx.icon} ${fx.label}`;
  burstEmoji(layer, fx.icon, fx.count);
  const text = document.createElement('div');
  text.className = 'fx-label';
  text.textContent = label;
  text.style.color = ev.mine ? '#8a8a97' : '#ffd21f';
  layer.appendChild(text);
  setTimeout(() => text.remove(), 1900);

  // 被炸/被扔大便时抖一下屏幕，强化反馈
  if (!ev.mine && (ev.kind === 'bomb' || ev.kind === 'poop')) {
    const app = $('#app');
    app.classList.add('fx-shake');
    setTimeout(() => app.classList.remove('fx-shake'), 520);
  }
}

/** 从屏幕中央炸开一堆 emoji。 */
function burstEmoji(layer, icon, count) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'fx-burst';
    el.textContent = icon;
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 120 + Math.random() * 200;
    el.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    el.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    el.style.setProperty('--rot', `${(Math.random() * 2 - 1) * 180}deg`);
    el.style.animationDelay = `${i * 45}ms`;
    el.style.fontSize = `${34 + Math.random() * 28}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2100);
  }
}

/** 踩中陷阱的全屏红闪。 */
function trapFlash() {
  const layer = $('#fx-layer');
  const el = document.createElement('div');
  el.className = 'fx-trap';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

/* ------------------------------------------------------------------ */
/* 状态渲染                                                            */
/* ------------------------------------------------------------------ */

function applyState(st) {
  S.state = st;
  S.skew = (st.serverNow || Date.now()) - Date.now();
  const me = st.players.find((p) => p.pid === S.pid);
  S.mySeat = me && st.seatByPid && st.seatByPid[S.pid] !== undefined ? st.seatByPid[S.pid] : -1;

  // 服务端发来的私密提示（例如「获得道具：🎲 随机传送」）
  if (st.toast) {
    toast(st.toast, st.toastKind === 'err' || st.toastKind === 'warn');
    if (st.toastKind === 'warn') trapFlash();
  }
  // 头像互动特效（服务端挂在 state 帧上一起下发）
  if (st.reaction) showReaction(st.reaction);

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
  board.breakHover = null;
  board.trapHover = null;

  showScreen('room');
  // 记住房间，刷新页面后可自动回到对局
  if (S.roomCode !== st.code) {
    S.roomCode = st.code;
    LS.set('room', st.code);
    // 换房间（含服务器重启后进新房间）：弹幕序号从 0 重新对齐，
    // 否则新房子里 seq 只有个位数，会被旧房间留下的高序号一直挡住播不出来。
    S.danmakuSeq = 0;
    S.danmakuPrimed = false;
  }
  // 弹幕：只播「本次连接之后新来的」。
  // 第一次收到 state 时（刚打开或刚刷新页面），服务端会把最近 30 条历史一起发下来，
  // 那批必须直接标记成已看过——否则刷新一下就会把之前发过的弹幕全部同时重放一遍。
  // 之后每次 WS 重连也会重新 prime 一次（断开期间的老弹幕同样不值得补播）。
  const danmaku = st.danmaku || [];
  if (!S.danmakuPrimed) {
    for (const entry of danmaku) {
      const seq = Number(entry?.seq);
      if (Number.isFinite(seq)) S.danmakuSeq = Math.max(S.danmakuSeq, seq);
    }
    S.danmakuPrimed = true;
  } else {
    for (const entry of danmaku) playDanmaku(entry);
  }

  renderTop(st);
  renderPlayers(st, me);
  renderSettings(st, me);
  renderHostPanel(st, me);
  renderActionbar(st, me);
  renderItems(st, me);
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

    // 头像互动：鼠标移到这一行上就出现表情按钮
    if (p.pid !== S.pid && p.connected) {
      const react = document.createElement('button');
      react.className = 'pp-react';
      react.type = 'button';
      react.textContent = '💬';
      react.title = `向 ${p.name} 发送互动`;
      react.onclick = (ev) => {
        ev.stopPropagation();
        openReactionPicker(react, p);
      };
      li.appendChild(react);
    }
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
  const chestItems = (s.chestItems || [])
    .map((k) => ITEM_META.find((m) => m.key === k)?.icon || '')
    .join(' ');
  return [
    ['棋盘', `${s.size} × ${s.size}`],
    ['人数上限', `${s.maxPlayers} 人`],
    ['每人路障', `${s.walls} 面`],
    ['回合限时', s.turnTimer ? `${s.turnTimer} 秒` : '不限时'],
    ['中央方块', s.goalSize >= 2 ? '2 × 2' : '1 格'],
    ['宝箱', s.chests ? `${s.chests} 个 · ${s.chestOnce ? '一次性' : '常驻'}` : '不生成'],
    ['宝箱道具', chestItems || '—'],
    ['道具栏', `${s.itemSlots} 件`],
  ];
}

function renderSettings(st, me) {
  const isHost = me?.host;
  const editable = isHost && st.phase !== 'playing';
  $('#settings-lock').classList.toggle('hidden', !!isHost);
  $('#settings-form').classList.toggle('hidden', !editable);
  $('#settings-view').classList.toggle('hidden', !!editable);

  if (editable) {
    const s = st.settings;
    $('#s-size').value = String(s.size);
    $('#s-max').value = String(s.maxPlayers);
    $('#s-walls').value = String(s.walls);
    $('#s-timer').value = String(s.turnTimer);
    $('#s-goal').value = String(s.goalSize);
    $('#s-chests').value = String(s.chests);
    $('#s-chest-mode').value = s.chestOnce ? '1' : '0';
    $('#s-item-slots').value = String(s.itemSlots);
    const picked = new Set(s.chestItems || []);
    $('#s-chest-items').querySelectorAll('input').forEach((el) => {
      el.checked = picked.has(el.value);
    });
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

/* ------------------------------------------------------------------ */
/* 道具栏                                                              */
/* ------------------------------------------------------------------ */

function renderItems(st, me) {
  const bar = $('#itembar');
  const slotsEl = $('#items-slots');
  const my = st.me || { items: [], itemSlots: st.settings.itemSlots };
  const playing = st.phase === 'playing';
  const hasChests = (st.settings.chests || 0) > 0 || (st.game?.chests?.length || 0) > 0;

  // 没开宝箱的房间不必显示道具栏（破墙/陷阱也只有宝箱才产出）
  const show = playing && (hasChests || (my.items || []).length > 0);
  bar.classList.toggle('hidden', !show);
  // 道具栏占高度，棋盘相应缩小，保证整块棋盘区仍然一屏放得下
  document.querySelector('.board-zone')?.classList.toggle('has-itembar', show);
  if (!show) {
    S.itemMode = null;
    S.selectedSlot = -1;
    slotsEl.innerHTML = '';
    return;
  }

  const total = my.itemSlots || st.settings.itemSlots || 3;
  const items = my.items || [];
  slotsEl.innerHTML = '';

  // 手牌为空时提示怎么获得
  $('#items-hint').textContent = me?.spectator
    ? '观众不能使用道具'
    : my.skipped
      ? '💥 你踩中了陷阱，本回合无法行动'
      : items.length
        ? '点一件道具来使用 · 使用道具会消耗本回合'
        : '踩到宝箱格随机获得 · 每回合限用一件';

  for (let i = 0; i < total; i++) {
    const kind = items[i];
    const meta = kind ? ITEM_BY_KIND.get(kind) : null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-slot' + (meta ? ' filled' : '');
    if (S.selectedSlot === i && meta) btn.classList.add('active');
    if (meta) {
      btn.textContent = meta.icon;
      btn.title = `${meta.name} · ${itemHint(meta.key)}`;
      btn.style.color = meta.color;
      btn.style.borderColor = meta.color;
      btn.disabled = !canAct();
      btn.onclick = () => selectItem(i, kind);
      const count = items.filter((k) => k === kind).length;
      if (count > 1) {
        const tag = document.createElement('span');
        tag.className = 'is-count';
        tag.textContent = `×${count}`;
        btn.appendChild(tag);
      }
    } else {
      btn.textContent = '';
      btn.disabled = true;
    }
    slotsEl.appendChild(btn);
  }
}

function itemHint(key) {
  if (key === 'teleport') return '把你随机传送到棋盘上一格（不会传到终点）';
  if (key === 'break') return '破坏场上任意对手的一面路障';
  return '埋一个陷阱，只有你能看见；踩中的人下一回合被跳过';
}

/** 点道具栏 → 进入对应的瞄准模式。 */
function selectItem(slot, kind) {
  if (!canAct()) {
    toast('还没轮到你', true);
    return;
  }
  if (S.selectedSlot === slot) {
    cancelItemMode();
    return;
  }
  S.selectedSlot = slot;
  if (kind === ITEM_KIND.BREAK) {
    setMode('break');
    toast('点一个对手的路障来砸掉它');
  } else if (kind === ITEM_KIND.TRAP) {
    setMode('trap');
    toast('点一个格子埋下陷阱（不能放在中央方块上）');
  } else {
    // 随机传送不需要选目标，直接发
    setMode('move');
    S.selectedSlot = -1;
    send({ t: 'item', kind: ITEM_KIND.TELEPORT });
  }
  renderItems(S.state, S.state?.players.find((p) => p.pid === S.pid));
}

function cancelItemMode() {
  S.selectedSlot = -1;
  S.itemMode = null;
  board.breakHover = null;
  board.trapHover = null;
  setMode('move');
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
    const skippedNow = (st.game.seatState?.[st.game.turn]?.skipTurns || 0) > 0;
    if (isMyTurn && st.me?.skipped) {
      text.textContent = '💥 你踩中了陷阱，本回合被跳过';
    } else if (skippedNow) {
      text.textContent = `💥 ${seatInfo.name} 被陷阱困住，本回合跳过`;
    } else {
      text.textContent = me?.spectator
        ? `观众模式 · 轮到 ${seatInfo.name}`
        : isMyTurn
          ? '轮到你行动'
          : `轮到 ${seatInfo.name}`;
    }
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
  if (st.me?.skipped) return false;   // 踩中陷阱：本回合不能做任何操作
  return st.game.turn === S.mySeat;
}

board.canvas.addEventListener('pointermove', (ev) => {
  if (!canAct()) {
    board.hoverCell = null;
    board.wallPreview = null;
    board.breakHover = null;
    board.trapHover = null;
    return;
  }
  const { x, y } = pointerPos(ev);
  if (S.mode === 'move') {
    board.hoverCell = board.hitCell(x, y);
    board.wallPreview = null;
    board.breakHover = null;
    board.trapHover = null;
  } else if (S.mode === 'wall') {
    const hit = board.hitWall(x, y);
    board.hoverCell = null;
    board.breakHover = null;
    board.trapHover = null;
    if (hit && hit.score < 0.8) {
      const res = canPlaceWall(S.state.game, S.mySeat, hit.d, hit.r, hit.c);
      board.wallPreview = res.ok
        ? { d: hit.d, r: res.r, c: res.c, ok: true }
        : { d: hit.d, r: res.r ?? hit.r, c: res.c ?? hit.c, ok: false, reason: res.reason };
    } else {
      board.wallPreview = null;
    }
  } else if (S.mode === 'break') {
    // 破墙：高亮悬停到的路障（自己的墙不能砸）
    board.hoverCell = null;
    board.wallPreview = null;
    board.trapHover = null;
    const hit = board.hitExistingWall(x, y);
    board.breakHover = hit
      ? { wall: hit.wall, index: hit.index, ok: hit.wall.seat !== S.mySeat }
      : null;
  } else if (S.mode === 'trap') {
    // 陷阱：预览落点，非法位置标红
    board.hoverCell = null;
    board.wallPreview = null;
    board.breakHover = null;
    const cell = board.hitCell(x, y);
    const res = cell ? canPlaceTrap(S.state.game, S.mySeat, cell.r, cell.c) : null;
    board.trapHover = cell && res?.ok ? { r: res.r, c: res.c } : null;
  }
});

board.canvas.addEventListener('pointerleave', () => {
  board.hoverCell = null;
  board.wallPreview = null;
  board.breakHover = null;
  board.trapHover = null;
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
  } else if (S.mode === 'wall') {
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
  } else if (S.mode === 'break') {
    const hit = board.hitExistingWall(x, y);
    if (!hit) return;
    if (hit.wall.seat === S.mySeat) {
      toast('不能破坏自己的路障', true);
      return;
    }
    send({ t: 'item', kind: ITEM_KIND.BREAK, data: { index: hit.index } });
    cancelItemMode();
  } else if (S.mode === 'trap') {
    const cell = board.hitCell(x, y);
    if (!cell) return;
    const res = canPlaceTrap(S.state.game, S.mySeat, cell.r, cell.c);
    if (!res.ok) {
      toast(reasonText(res.reason), true);
      return;
    }
    send({ t: 'item', kind: ITEM_KIND.TRAP, data: { r: res.r, c: res.c } });
    cancelItemMode();
  }
});

function setMode(mode) {
  S.mode = mode;
  board.mode = mode === 'break' || mode === 'trap' ? 'move' : mode;
  board.wallPreview = null;
  board.hoverCell = null;
  board.breakHover = null;
  board.trapHover = null;
  $('#btn-mode-move').classList.toggle('active', mode === 'move');
  $('#btn-mode-wall').classList.toggle('active', mode === 'wall');
  if (mode !== 'break' && mode !== 'trap') S.selectedSlot = -1;
}
$('#btn-mode-move').addEventListener('click', () => {
  S.selectedSlot = -1;
  setMode('move');
});
$('#btn-mode-wall').addEventListener('click', () => {
  S.selectedSlot = -1;
  setMode('wall');
});

/* ------------------------------------------------------------------ */
/* 弹幕发送                                                            */
/* ------------------------------------------------------------------ */

function sendDanmaku() {
  const input = $('#danmaku-input');
  const text = (input.value || '').trim();
  if (!text) return;
  send({ t: 'danmaku', text });
  input.value = '';
}

$('#btn-danmaku').addEventListener('click', sendDanmaku);
$('#danmaku-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    sendDanmaku();
  }
});

/* ------------------------------------------------------------------ */
/* 头像互动                                                            */
/* ------------------------------------------------------------------ */

const REACTION_BUTTONS = [
  ['poop', '💩'], ['bomb', '💣'], ['heart', '❤️'], ['rose', '🌹'], ['coffee', '☕'],
];

function openReactionPicker(anchor, target) {
  const picker = $('#reaction-picker');
  if (S.reactionTarget === target.pid && !picker.classList.contains('hidden')) {
    closeReactionPicker();
    return;
  }
  picker.innerHTML = '';
  for (const [kind, icon] of REACTION_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = icon;
    btn.title = `向 ${target.name} 发送 ${icon}`;
    btn.onclick = (ev) => {
      ev.stopPropagation();
      send({ t: 'react', target: target.pid, kind });
      closeReactionPicker();
    };
    picker.appendChild(btn);
  }
  const r = anchor.getBoundingClientRect();
  picker.classList.remove('hidden');
  // 先显示再量尺寸，避免算出 0 宽
  const pw = picker.offsetWidth || 220;
  const left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
  picker.style.left = `${left}px`;
  picker.style.top = `${Math.max(8, r.bottom + 6)}px`;
  S.reactionTarget = target.pid;
}

function closeReactionPicker() {
  $('#reaction-picker').classList.add('hidden');
  S.reactionTarget = null;
}

document.addEventListener('click', (ev) => {
  const picker = $('#reaction-picker');
  if (picker.classList.contains('hidden')) return;
  if (!picker.contains(ev.target)) closeReactionPicker();
});
window.addEventListener('resize', closeReactionPicker);

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

/** 从表单里读宝箱相关的设置。 */
function readChestSettings(prefix) {
  const items = [...document.querySelectorAll(`#${prefix}-chest-items input:checked`)]
    .map((el) => el.value);
  return {
    chests: Number($(`#${prefix}-chests`).value),
    // 下拉框用 1/0 表示「一次性 / 常驻」，服务端收布尔
    chestOnce: $(`#${prefix}-chest-mode`) ? $(`#${prefix}-chest-mode`).value === '1' : true,
    chestItems: items,
  };
}

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
    itemSlots: Number($('#in-item-slots').value),
    ...readChestSettings('in'),
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
      itemSlots: Number($('#s-item-slots').value),
      ...readChestSettings('s'),
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
