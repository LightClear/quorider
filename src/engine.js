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

/** 道具种类：3 随机传送、1 破墙、2 陷阱。数字与 ITEM_COLORS 下标一一对应。 */
export const ITEM_KIND = { TELEPORT: 3, BREAK: 1, TRAP: 2 };

export const ITEM_META = [
  { kind: ITEM_KIND.TELEPORT, key: 'teleport', icon: '🎲', name: '随机传送', color: '#a06bff' },
  { kind: ITEM_KIND.BREAK, key: 'break', icon: '🔨', name: '破墙锤', color: '#ff7a3d' },
  { kind: ITEM_KIND.TRAP, key: 'trap', icon: '💣', name: '陷阱', color: '#ff3d6e' },
];

export const ITEM_KEYS = ITEM_META.map((m) => m.key);
export const ALL_ITEM_KEYS = [...ITEM_KEYS];

const ITEM_BY_KIND = new Map(ITEM_META.map((m) => [m.kind, m]));

export function itemMetaByKind(kind) {
  return ITEM_BY_KIND.get(kind) || null;
}

export function itemMetaByKey(key) {
  return ITEM_META.find((m) => m.key === key) || null;
}

/** key -> kind 的数字映射，专门给「开关数组」形式的设置用。 */
export const ITEM_KIND_BY_KEY = {
  teleport: ITEM_KIND.TELEPORT,
  break: ITEM_KIND.BREAK,
  trap: ITEM_KIND.TRAP,
};

export const DEFAULT_SETTINGS = {
  size: 9,
  walls: 10,
  goalSize: 1,
  turnTimer: 60,
  maxPlayers: 4,
  chests: 0,
  chestOnce: true,
  chestItems: ALL_ITEM_KEYS,
  itemSlots: 3,
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

/**
 * 宝箱可产出道具池。接受字符串数组 / 数字数组 / 布尔开关对象；
 * 空池回落到「全部道具」，避免房主勾没了导致宝箱永远开不出东西。
 */
export function normalizeChestItems(input) {
  if (input === undefined || input === null || input === '') return [...ALL_ITEM_KEYS];
  const kinds = new Set();
  if (Array.isArray(input)) {
    for (const v of input) {
      if (typeof v === 'string') {
        const k = ITEM_KIND_BY_KEY[v];
        if (k) kinds.add(k);
      } else if (ITEM_BY_KIND.has(Number(v))) {
        kinds.add(Number(v));
      }
    }
  } else if (typeof input === 'object') {
    for (const [key, on] of Object.entries(input)) {
      const k = ITEM_KIND_BY_KEY[key];
      if (on && k) kinds.add(k);
    }
  } else {
    return [...ALL_ITEM_KEYS];
  }
  if (!kinds.size) return [...ALL_ITEM_KEYS];
  // 按 ITEM_META 的固定顺序输出，保证前端勾选框与广播内容稳定
  return ITEM_META.filter((m) => kinds.has(m.kind)).map((m) => m.key);
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
    chests: clampInt(raw.chests, 0, 10, DEFAULT_SETTINGS.chests),
    chestOnce: raw.chestOnce === undefined ? DEFAULT_SETTINGS.chestOnce : !!raw.chestOnce,
    chestItems: normalizeChestItems(raw.chestItems),
    itemSlots: clampInt(raw.itemSlots, 1, 5, DEFAULT_SETTINGS.itemSlots),
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

  const g = {
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
    // 陷阱：公开数据（谁埋的也公开），但「埋在哪」只发给埋雷的人，见 rooms.js
    traps: [],
    // 每个座位的临时状态（跳过回合的层数）
    seatState: list.map(() => ({ skipTurns: 0 })),
    // 宝箱配置：一次性模式（chestOnce）下 openedBy 用来记录已开过的玩家
    chestMode: s.chestOnce ? 'once' : 'forever',
    chestPool: s.chestItems,
    itemSlots: s.itemSlots,
    chests: [],
    seats: list.map((p, i) => ({
      seat: i,
      id: p.id,
      name: p.name,
      color: COLORS[i % COLORS.length],
      wallsLeft: s.walls,
      connected: true,
    })),
  };
  // 宝箱随机落在非目标格上。RNG 在客户端（大厅预览）也一致可用。
  g.chests = placeChests(g, s.chests);
  return g;
}

/**
 * 在棋盘上随机挑选若干非目标格放宝箱（不会重复落点）。
 * 导出出来是为了让房间管理在「同一局内补种宝箱」时复用同一套规则。
 */
export function placeChests(g, count, rng = Math.random) {
  const total = clampInt(count, 0, 10, 0);
  const taken = new Set();
  const out = [];
  const pool = [];
  const goals = goalSet(g.size, g.goalSize);
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (goals.has(`${r},${c}`)) continue;
      pool.push({ r, c });
    }
  }
  for (let i = 0; i < total && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    const cell = pool.splice(idx, 1)[0];
    const key = `${cell.r},${cell.c}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ id: i, r: cell.r, c: cell.c, openedBy: [] });
  }
  return out;
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
  if (g.seatState?.[seat]?.skipTurns > 0) return { ok: false, reason: 'skipped' };
  const pawn = g.pawns[seat];
  if (!pawn) return { ok: false, reason: 'no-seat' };

  const move = legalMoves(g, seat).find((m) => m.r === r && m.c === c);
  if (!move) return { ok: false, reason: 'illegal-move' };

  const from = { r: pawn.r, c: pawn.c };
  pawn.r = r;
  pawn.c = c;
  g.lastMove = { type: 'move', seat, from, to: { r, c } };

  return settleAfterArrival(g, seat, r, c, 'move');
}

/**
 * 棋子落到某格之后的统一结算：开宝箱 → 踩陷阱 → 判断胜负 → 换手。
 * 走子与随机传送都走这条路径（「任何方式移动到宝箱格」都能拿到道具）。
 */
export function settleAfterArrival(g, seat, r, c, kind = 'move') {
  const chest = openChestAt(g, seat, r, c);
  const trap = triggerTrapAt(g, seat, r, c);

  if (isGoal(g, r, c)) {
    g.phase = 'finished';
    g.winner = seat;
    return { ok: true, opened: chest, trapped: !!trap, won: true };
  }

  const skipped = trap ? markSkip(g, seat, 1) : false;
  g.turnCount++;
  advanceTurn(g);
  return { ok: true, opened: chest, trapped: !!trap, skipped, won: false };
}

/** 棋子所在格的宝箱；没有则返回 null。 */
export function chestAt(g, r, c) {
  return (g.chests || []).find((ch) => ch.r === r && ch.c === c) || null;
}

/**
 * 开启 (r, c) 上的宝箱。
 * 返回 { chestId, index }，没开成（没有箱子 / 一次性已开过 / 道具池为空）返回 null。
 * 注意：这里只改「宝箱被谁开过」，发道具由房间管理写入私有背包。
 */
export function openChestAt(g, seat, r, c) {
  const chest = chestAt(g, r, c);
  if (!chest) return null;
  const opened = chest.openedBy || (chest.openedBy = []);
  if (g.chestMode === 'once' && opened.length) return null;
  if (g.chestMode === 'forever' && opened.includes(seat)) return null;
  if (!g.chestPool?.length) return null;
  opened.push(seat);
  return { chestId: chest.id, index: (g.chests || []).indexOf(chest) };
}

/** 触发 (r, c) 上的陷阱。返回 { index, owner } 或 null。 */
export function triggerTrapAt(g, seat, r, c) {
  const traps = g.traps || [];
  const index = traps.findIndex((t) => t.r === r && t.c === c && t.seat !== seat);
  if (index < 0) return null;
  const [trap] = traps.splice(index, 1);
  return { index, owner: trap.seat };
}

/** 本回合跳过 skipTurns 次；返回是否真的标记成功。 */
export function markSkip(g, seat, skipTurns = 1) {
  if (!g.seatState?.[seat]) return false;
  g.seatState[seat].skipTurns = Math.max(g.seatState[seat].skipTurns || 0, skipTurns);
  return true;
}

/** 当前座位上是否处于「跳过回合」状态。 */
export function isSkipped(g, seat) {
  return (g.seatState?.[seat]?.skipTurns || 0) > 0;
}

/**
 * 结算一次「被跳过的回合」：消耗一层跳过标记并换手。
 * 返回 { ok, finished }；没有跳过标记时返回 { ok:false }。
 */
export function skipTurn(g, seat) {
  if (g.phase !== 'playing') return { ok: false, reason: 'not-playing' };
  if (g.turn !== seat) return { ok: false, reason: 'not-turn' };
  const st = g.seatState?.[seat];
  if (!st || !(st.skipTurns > 0)) return { ok: false, reason: 'not-skipped' };
  st.skipTurns--;
  g.lastMove = { type: 'skip', seat };
  g.turnCount++;
  advanceTurn(g);
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
  if (isSkipped(g, seat)) return fails('skipped');

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
  return { ok: true, r: check.r, c: check.c, count: g.walls.length };
}

/* ------------------------------------------------------------------ */
/* 道具与陷阱                                                          */
/* ------------------------------------------------------------------ */

/** 破坏一面路障（破墙道具）。只能砸对手的墙。 */
export function removeWall(g, seat, index) {
  if (g.phase !== 'playing') return fails('not-playing');
  if (g.turn !== seat) return fails('not-turn');
  if (isSkipped(g, seat)) return fails('skipped');
  const wall = g.walls[index];
  if (!wall) return fails('no-wall');
  if (wall.seat === seat) return fails('own-wall');

  setWall(g, wall.d, wall.r, wall.c, false);
  g.walls.splice(index, 1);
  return { ok: true, removed: wall };
}

/**
 * 随机传送：落到棋盘上随机一格（可以是空闲格、也可以是别人棋子/宝箱/陷阱所在格）。
 * 唯一硬性排除是中央目标格——不能靠传送直接获胜。
 * rng 可注入，测试里用来固定落点。
 */
export function randomTeleportCell(g, seat, rng = Math.random) {
  const pool = [];
  const goals = goalSet(g.size, g.goalSize);
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (goals.has(`${r},${c}`)) continue; // 不能传送到终点
      const self = g.pawns[seat];
      if (self && self.r === r && self.c === c) continue; // 传送原地没意义
      pool.push({ r, c });
    }
  }
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/** 陷阱不能埋在中央目标格上（房主可勾选的「任一位置」按此口径执行）。 */
export function canPlaceTrap(g, seat, r, c) {
  if (g.phase !== 'playing') return fails('not-playing');
  if (g.turn !== seat) return fails('not-turn');
  if (isSkipped(g, seat)) return fails('skipped');
  const rr = Math.round(Number(r));
  const cc = Math.round(Number(c));
  if (!Number.isFinite(rr) || !Number.isFinite(cc)) return fails('out-of-board');
  if (!inBoard(g.size, rr, cc)) return fails('out-of-board');
  if (isGoal(g, rr, cc)) return fails('trap-on-goal');
  if ((g.traps || []).some((t) => t.r === rr && t.c === cc)) return fails('trap-occupied');
  return { ok: true, r: rr, c: cc };
}

export function applyPlaceTrap(g, seat, r, c) {
  const check = canPlaceTrap(g, seat, r, c);
  if (!check.ok) return check;
  g.traps = g.traps || [];
  g.traps.push({ r: check.r, c: check.c, seat });
  return { ok: true, r: check.r, c: check.c };
}

/** 清理所有过期的临时状态（跳过标记）并推进到下一个能行动的座位。 */
export function clearExpired(g) {
  if (!g.seatState) return;
  for (const st of g.seatState) {
    if (st && st.skipTurns < 0) st.skipTurns = 0;
  }
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

/**
 * 超时托管：处于「跳过回合」状态时直接跳过；否则走一步。
 * 返回 { type:'move', r, c } 或 { type:'skip' }，无事可做返回 null。
 */
export function pickAutoAction(g, seat) {
  if (isSkipped(g, seat)) return { type: 'skip' };
  const mv = pickAutoMove(g, seat);
  return mv ? { type: 'move', r: mv.r, c: mv.c } : null;
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
  skipped: '你踩中了陷阱，本回合无法行动',
  'no-wall': '这里没有可以破坏的路障',
  'own-wall': '不能破坏自己的路障',
  'trap-on-goal': '陷阱不能放在中央方块上',
  'trap-occupied': '这里已经有一个陷阱了',
  'bad-item': '没有这种道具',
  'no-item': '你没有这件道具',
  'item-full': '道具已满，先用掉一件再来',
  'no-chest': '这里没有宝箱',
  'chest-used': '这个宝箱你已经开过了',
  unknown: '无法放置',
};

export function reasonText(code) {
  return REASON_TEXT[code] || REASON_TEXT.unknown;
}