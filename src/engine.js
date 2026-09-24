/**
 * 路障棋 (Quorider) 规则引擎
 *
 * 同构模块：浏览器与 Node 服务端共用同一份代码，不含任何平台 API。
 * 全部为纯数据 + 纯函数，状态对象可直接 JSON 序列化后通过网络传输。
 *
 * 坐标系统
 *   格位 (r, c)：r 行号、c 列号，均为 0 .. size-1。
 *   横墙 h[r][c]：位于第 r 条水平线上的半格，挡住 (r-1, c) 与 (r, c) 之间。
 *     一面横墙 (r, c) 会同时点亮 h[r][c] 与 h[r][c+1]（跨越两格）。
 *   竖墙 v[r][c]：位于第 c 条竖线上的半格，挡住 (r, c-1) 与 (r, c) 之间。
 *     一面竖墙 (r, c) 会同时点亮 v[r][c] 与 v[r+1][c]。
 *   横墙合法范围：r ∈ [1, size-1]，c ∈ [0, size-2]
 *   竖墙合法范围：r ∈ [0, size-2]，c ∈ [1, size-1]
 *
 *   另有 hs / vs 两个「墙根」矩阵，记录每一面墙的起始槽位。
 *   判断交叉必须用墙根而不是半格标记：半格 v[r][c] 可能来自起点 (r,c) 的墙，
 *   也可能来自起点 (r-1,c) 的墙，后者只是「末端触及」而非「交叉」。
 *   例如 H(4,3) 与 V(3,5)：竖墙下端只碰到横墙中点，属于合法的 T 型相接。
 */

export const COLORS = ['#3aa0ff', '#ff2e63', '#ffa62b', '#2ee36b'];
export const COLOR_NAMES = ['蓝', '红', '橙', '绿'];

/** 方向：0 上、1 右、2 下、3 左（邻接方向与垂直方向都依赖这个顺序）。 */
export const DIRS = [
  { dr: -1, dc: 0 },
  { dr: 0, dc: 1 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
];

export const DEFAULT_SETTINGS = {
  size: 9,
  walls: 10,
  goalSize: 1,
  turnTimer: 60,
  maxPlayers: 4,
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 棋盘越大，默认路障越多。 */
export function defaultWallsFor(size) {
  return clampInt(Math.round((size * 10) / 9), 0, 20, 10);
}

export function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  let size = clampInt(raw.size, 5, 15, DEFAULT_SETTINGS.size);
  if (size % 2 === 0) size += 1; // 必须为奇数，中央格才唯一
  return {
    size,
    walls: clampInt(raw.walls, 0, 20, defaultWallsFor(size)),
    goalSize: Number(raw.goalSize) >= 2 ? 2 : 1,
    turnTimer: clampInt(raw.turnTimer, 0, 300, DEFAULT_SETTINGS.turnTimer),
    maxPlayers: clampInt(raw.maxPlayers, 2, 4, 4),
  };
}

export function centerOf(size) {
  return (size - 1) >> 1;
}

/** 中央目标区：默认 1 格；goalSize=2 时为偏右下的 2x2 方块。 */
export function goalCells(size, goalSize) {
  const m = centerOf(size);
  if (goalSize >= 2) {
    return [
      { r: m, c: m },
      { r: m, c: m + 1 },
      { r: m + 1, c: m },
      { r: m + 1, c: m + 1 },
    ];
  }
  return [{ r: m, c: m }];
}

const goalKey = (size, goalSize) => `${size}:${goalSize}`;
const goalCache = new Map();

/** 返回目标格集合的 Set（"r,c" 形式），带缓存。 */
export function goalSet(size, goalSize) {
  const key = goalKey(size, goalSize);
  let hit = goalCache.get(key);
  if (!hit) {
    hit = new Set(goalCells(size, goalSize).map((p) => `${p.r},${p.c}`));
    goalCache.set(key, hit);
  }
  return hit;
}

export function inBoard(size, r, c) {
  return r >= 0 && c >= 0 && r < size && c < size;
}

/** 仅用于相邻两格；非相邻时返回 true（视为不可通行）。 */
export function wallBetween(g, a, b) {
  if (a.r === b.r && Math.abs(a.c - b.c) === 1) {
    return !!g.v[a.r][Math.max(a.c, b.c)];
  }
  if (a.c === b.c && Math.abs(a.r - b.r) === 1) {
    return !!g.h[Math.max(a.r, b.r)][a.c];
  }
  return true;
}

export function isGoal(g, r, c) {
  return goalSet(g.size, g.goalSize).has(`${r},${c}`);
}

/** 开局站位：2 人上下对峙，3 人下右上，4 人各占一边。 */
export function startPositions(size, count) {
  const m = centerOf(size);
  const sides = [
    { r: size - 1, c: m }, // 下
    { r: m, c: size - 1 }, // 右
    { r: 0, c: m }, // 上
    { r: m, c: 0 }, // 左
  ];
  const pick = count <= 2 ? [0, 2] : count === 3 ? [0, 1, 2] : [0, 1, 2, 3];
  return pick.map((i) => sides[i]);
}

export function createGame(settings, seats) {
  const s = normalizeSettings(settings);
  const n = s.size;
  const list = (seats || []).slice(0, s.maxPlayers);
  const starts = startPositions(n, list.length);
  const pawns = [];
  for (let i = 0; i < s.maxPlayers; i++) pawns.push(i < list.length ? { ...starts[i] } : null);

  return {
    size: n,
    goalSize: s.goalSize,
    wallsPerPlayer: s.walls,
    phase: 'playing',
    turn: 0,
    winner: null,
    lastMove: null,
    turnCount: 0,
    pawns,
    // (size+1)x(size+1) 的 0/1 矩阵，可直接 JSON 传输
    h: Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)),
    v: Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)),
    hs: Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)),
    vs: Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)),
    walls: [],
    seats: list.map((p, i) => ({
      seat: i,
      id: p.id,
      name: p.name,
      color: COLORS[i % COLORS.length],
      wallsLeft: s.walls,
      connected: true,
    })),
  };
}

/** 用「玩家名单 + 已有对局配置」开一局新棋（用于快速重开）。 */
export function resetGame(settings, seats) {
  return createGame(settings, seats);
}

export function colorOf(seat) {
  return COLORS[seat % COLORS.length];
}

/* ------------------------------------------------------------------ */
/* 走子                                                                */
/* ------------------------------------------------------------------ */

/**
 * 计算某个座位所有合法的走法。
 * 支持标准路障棋的直跳与「跳位被挡时斜走」。
 */
export function legalMoves(g, seat) {
  const pawn = g.pawns[seat];
  if (!pawn) return [];
  const size = g.size;
  const occupied = new Set();
  for (let i = 0; i < g.pawns.length; i++) {
    const p = g.pawns[i];
    if (p && i !== seat) occupied.add(`${p.r},${p.c}`);
  }

  const seen = new Set();
  const out = [];
  const push = (r, c, kind) => {
    const k = `${r},${c}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ r, c, kind });
  };

  for (let d = 0; d < 4; d++) {
    const { dr, dc } = DIRS[d];
    const t = { r: pawn.r + dr, c: pawn.c + dc };
    if (!inBoard(size, t.r, t.c)) continue;
    if (wallBetween(g, pawn, t)) continue;

    if (!occupied.has(`${t.r},${t.c}`)) {
      push(t.r, t.c, 'step');
      continue;
    }

    // 正前方有棋子：先尝试跳过它
    const j = { r: t.r + dr, c: t.c + dc };
    if (inBoard(size, j.r, j.c) && !wallBetween(g, t, j) && !occupied.has(`${j.r},${j.c}`)) {
      push(j.r, j.c, 'jump');
      continue;
    }

    // 跳不过去（棋盘外 / 有墙 / 后面还有棋子）：改走斜向
    for (const pd of [(d + 1) % 4, (d + 3) % 4]) {
      const p = DIRS[pd];
      const diag = { r: t.r + p.dr, c: t.c + p.dc };
      if (!inBoard(size, diag.r, diag.c)) continue;
      if (wallBetween(g, t, diag)) continue;
      const side = { r: pawn.r + p.dr, c: pawn.c + p.dc };
      if (!inBoard(size, side.r, side.c)) continue;
      if (wallBetween(g, pawn, side)) continue;
      if (occupied.has(`${diag.r},${diag.c}`)) continue;
      push(diag.r, diag.c, 'diag');
    }
  }
  return out;
}

/** 执行走子；非法返回 {ok:false, reason}。原地修改 g。 */
export function applyMove(g, seat, r, c) {
  if (g.phase !== 'playing') return { ok: false, reason: 'not-playing' };
  if (g.turn !== seat) return { ok: false, reason: 'not-turn' };
  const pawn = g.pawns[seat];
  if (!pawn) return { ok: false, reason: 'no-seat' };

  const move = legalMoves(g, seat).find((m) => m.r === r && m.c === c);
  if (!move) return { ok: false, reason: 'illegal-move' };

  const from = { r: pawn.r, c: pawn.c };
  pawn.r = r;
  pawn.c = c;
  g.lastMove = { type: 'move', seat, from, to: { r, c } };
  g.turnCount++;

  if (isGoal(g, r, c)) {
    g.phase = 'finished';
    g.winner = seat;
  } else {
    advanceTurn(g);
  }
  return { ok: true };
}

function advanceTurn(g) {
  const n = g.seats.length;
  for (let i = 1; i <= n; i++) {
    const next = (g.turn + i) % n;
    if (g.pawns[next]) {
      g.turn = next;
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路障                                                                */
/* ------------------------------------------------------------------ */

const fails = (reason, extra) => ({ ok: false, reason, ...extra });

/**
 * 判断一面墙能否放在 (d, r, c)。
 * 依次检查：范围、占用、交叉、以及「不得封死任何玩家 / 不得封死中央方块」。
 */
export function canPlaceWall(g, seat, d, r, c) {
  if (g.phase !== 'playing') return fails('not-playing');
  if (g.turn !== seat) return fails('not-turn');

  const info = g.seats[seat];
  if (!info) return fails('no-seat');
  if (info.wallsLeft <= 0) return fails('no-walls-left');

  const bounds = wallBounds(g, d, r, c);
  if (!bounds) return fails('out-of-board');
  ({ r, c } = bounds);

  const size = g.size;

  if (d === 'h') {
    if (g.h[r][c] || g.h[r][c + 1]) return fails('occupied', { r, c });
    if (g.vs[r - 1][c + 1]) return fails('cross', { r, c });
  } else {
    if (g.v[r][c] || g.v[r + 1][c]) return fails('occupied', { r, c });
    if (g.hs[r + 1][c - 1]) return fails('cross', { r, c });
  }

  // 试放，然后做连通性校验
  setWall(g, d, r, c, true);
  let reason = null;
  for (const p of g.pawns) {
    if (!p) continue;
    if (!hasPathToGoal(g, p.r, p.c)) {
      reason = 'seal-player';
      break;
    }
  }
  if (!reason && !goalHasExit(g)) reason = 'seal-goal';
  setWall(g, d, r, c, false);

  if (reason) return fails(reason, { r, c });
  return { ok: true, r, c };
}

/** 把越界的墙吸附回最近的合法槽位；完全不可能时返回 null。 */
export function wallBounds(g, d, r, c) {
  const size = g.size;
  if (d === 'h') {
    if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
    r = clampInt(r, 1, size - 1, 1);
    c = clampInt(c, 0, size - 2, 0);
    return { r, c };
  }
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  r = clampInt(r, 0, size - 2, 0);
  c = clampInt(c, 1, size - 1, 1);
  return { r, c };
}

function setWall(g, d, r, c, on) {
  const bit = on ? 1 : 0;
  if (d === 'h') {
    g.h[r][c] = bit;
    g.h[r][c + 1] = bit;
    g.hs[r][c] = bit;
  } else {
    g.v[r][c] = bit;
    g.v[r + 1][c] = bit;
    g.vs[r][c] = bit;
  }
}

/** 执行放墙；非法返回 {ok:false, reason}。原地修改 g。 */
export function applyWall(g, seat, d, r, c) {
  const check = canPlaceWall(g, seat, d, r, c);
  if (!check.ok) return check;

  setWall(g, d, check.r, check.c, true);
  g.seats[seat].wallsLeft--;
  g.walls.push({ d, r: check.r, c: check.c, seat });
  g.lastMove = { type: 'wall', seat, d, r: check.r, c: check.c };
  g.turnCount++;
  advanceTurn(g);
  return { ok: true, r: check.r, c: check.c };
}

/* ------------------------------------------------------------------ */
/* 连通性                                                              */
/* ------------------------------------------------------------------ */

/** 从 (r, c) 出发能否抵达中央目标区（BFS，可穿过其他棋子所在格）。 */
export function hasPathToGoal(g, r, c) {
  const size = g.size;
  const goals = goalSet(size, g.goalSize);
  const seen = new Uint8Array(size * size);
  const stack = [[r, c]];
  seen[r * size + c] = 1;
  while (stack.length) {
    const [cr, cc] = stack.pop();
    if (goals.has(`${cr},${cc}`)) return true;
    for (let d = 0; d < 4; d++) {
      const nr = cr + DIRS[d].dr;
      const nc = cc + DIRS[d].dc;
      if (!inBoard(size, nr, nc)) continue;
      if (seen[nr * size + nc]) continue;
      if (wallBetween(g, { r: cr, c: cc }, { r: nr, c: nc })) continue;
      seen[nr * size + nc] = 1;
      stack.push([nr, nc]);
    }
  }
  return false;
}

/** 中央方块是否还留有对外的开口（即没有被完全封死）。 */
export function goalHasExit(g) {
  const goals = goalSet(g.size, g.goalSize);
  for (const p of goalCells(g.size, g.goalSize)) {
    for (let d = 0; d < 4; d++) {
      const t = { r: p.r + DIRS[d].dr, c: p.c + DIRS[d].dc };
      if (!inBoard(g.size, t.r, t.c)) continue;
      if (wallBetween(g, p, t)) continue;
      if (!goals.has(`${t.r},${t.c}`)) return true;
    }
  }
  return false;
}

/** 每格到中央的步数（多源 BFS），不可达为 Infinity。 */
export function distancesToGoal(g) {
  const size = g.size;
  const dist = new Array(size * size).fill(Infinity);
  const queue = [];
  for (const p of goalCells(size, g.goalSize)) {
    dist[p.r * size + p.c] = 0;
    queue.push(p);
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const base = dist[cur.r * size + cur.c];
    for (let d = 0; d < 4; d++) {
      const nr = cur.r + DIRS[d].dr;
      const nc = cur.c + DIRS[d].dc;
      if (!inBoard(size, nr, nc)) continue;
      if (dist[nr * size + nc] !== Infinity) continue;
      if (wallBetween(g, cur, { r: nr, c: nc })) continue;
      dist[nr * size + nc] = base + 1;
      queue.push({ r: nr, c: nc });
    }
  }
  return dist;
}

/** 超时托管：在合法走法中选一个最接近中央的（并列随机）。 */
export function pickAutoMove(g, seat) {
  const moves = legalMoves(g, seat);
  if (!moves.length) return null;
  const dist = distancesToGoal(g);
  let best = Infinity;
  let pool = [];
  for (const m of moves) {
    const d = dist[m.r * g.size + m.c];
    if (d < best) {
      best = d;
      pool = [m];
    } else if (d === best) {
      pool.push(m);
    }
  }
  return pool[Math.floor(Math.random() * pool.length)] || moves[0];
}

/** 给 UI 用的可读原因。 */
export const REASON_TEXT = {
  'not-playing': '对局尚未开始',
  'not-turn': '还没轮到你',
  'no-seat': '你不在对局中',
  'no-walls-left': '你的路障已经用完了',
  'illegal-move': '这一步走不过去',
  'out-of-board': '位置超出棋盘',
  occupied: '这里已经有路障了',
  cross: '路障不能交叉',
  'seal-player': '这面墙会让有玩家无法抵达中央',
  'seal-goal': '这面墙会把中央方块完全封死',
  unknown: '无法放置',
};

export function reasonText(code) {
  return REASON_TEXT[code] || REASON_TEXT.unknown;
}