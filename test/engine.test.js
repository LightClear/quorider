import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  legalMoves,
  applyMove,
  applyWall,
  canPlaceWall,
  hasPathToGoal,
  goalCells,
  goalHasExit,
  normalizeSettings,
  centerOf,
  defaultWallsFor,
  wallBetween,
  canPlaceTrap,
  applyPlaceTrap,
  removeWall,
  randomTeleportCell,
  chestAt,
  openChestAt,
  triggerTrapAt,
  skipTurn,
  isSkipped,
  pickAutoAction,
  normalizeChestItems,
  ITEM_KIND,
} from '../src/engine.js';

const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const newGame = (settings, n = 2) => createGame(settings, seats(n));
const at = (g, seat) => g.pawns[seat];

test('棋盘尺寸：偶数会被修正为奇数，越界会被夹取', () => {
  assert.equal(normalizeSettings({ size: 8 }).size, 9);
  assert.equal(normalizeSettings({ size: 9 }).size, 9);
  assert.equal(normalizeSettings({ size: 100 }).size, 15);
  assert.equal(normalizeSettings({ size: 2 }).size, 5);
  assert.equal(defaultWallsFor(9), 10);
});

test('中央格与开局站位', () => {
  const g = newGame({ size: 9 }, 4);
  assert.deepEqual(goalCells(9, 1), [{ r: 4, c: 4 }]);
  assert.deepEqual(goalCells(9, 2), [
    { r: 4, c: 4 },
    { r: 4, c: 5 },
    { r: 5, c: 4 },
    { r: 5, c: 5 },
  ]);
  assert.equal(centerOf(9), 4);
  assert.deepEqual(at(g, 0), { r: 8, c: 4 });
  assert.deepEqual(at(g, 1), { r: 4, c: 8 });
  assert.deepEqual(at(g, 2), { r: 0, c: 4 });
  assert.deepEqual(at(g, 3), { r: 4, c: 0 });
});

test('两人对局：上下对峙', () => {
  const g = newGame({ size: 9 }, 2);
  assert.deepEqual(at(g, 0), { r: 8, c: 4 });
  assert.deepEqual(at(g, 1), { r: 0, c: 4 });
});

test('基础走子与回合轮转', () => {
  const g = newGame({ size: 9 }, 2);
  assert.equal(g.turn, 0);
  assert.deepEqual(
    legalMoves(g, 0).map((m) => `${m.r},${m.c}`).sort(),
    ['7,4', '8,3', '8,5'],
  );
  const r = applyMove(g, 0, 7, 4);
  assert.equal(r.ok, true);
  assert.equal(g.turn, 1);
  // 不是自己的回合
  assert.equal(applyMove(g, 0, 6, 4).ok, false);
  assert.equal(applyMove(g, 0, 6, 4).reason, 'not-turn');
});

test('路障阻挡走子', () => {
  const g = newGame({ size: 9 }, 2);
  // 在 (8,4) 上方放一面横墙
  assert.equal(applyWall(g, 0, 'h', 8, 3).ok, true);
  g.turn = 0;
  const moves = legalMoves(g, 0).map((m) => `${m.r},${m.c}`);
  assert.ok(!moves.includes('7,4'), '被墙挡住，不能上移');
  assert.ok(moves.includes('8,3'));
  assert.ok(moves.includes('8,5'));
});

test('正面棋子：可以跳过去', () => {
  const g = newGame({ size: 9 }, 2);
  g.pawns[1] = { r: 7, c: 4 }; // 对手紧贴在我正前方
  const moves = legalMoves(g, 0).map((m) => `${m.r},${m.c}`);
  assert.ok(moves.includes('6,4'), '应该能跳过对手');
  assert.ok(!moves.includes('7,4'), '不能停在对手身上');
});

test('跳位被墙挡住时改走斜向', () => {
  const g = newGame({ size: 9 }, 2);
  g.pawns[0] = { r: 7, c: 4 };
  g.pawns[1] = { r: 6, c: 4 };
  // 在对手上方放横墙，使跳跃落点失效
  g.h[6][4] = 1;
  g.h[6][5] = 1;
  const moves = legalMoves(g, 0).map((m) => `${m.r},${m.c}`);
  assert.ok(moves.includes('6,3'), '应能斜walk到 (6,3)');
  assert.ok(moves.includes('6,5'), '应能斜walk到 (6,5)');
  assert.ok(!moves.includes('5,4'), '被墙挡住，不能直跳');
});

test('棋盘边缘被挡时斜走', () => {
  const g = newGame({ size: 9 }, 2);
  g.pawns[1] = { r: 0, c: 4 }; // 对手在顶边
  g.pawns[0] = { r: 1, c: 4 };
  const moves = legalMoves(g, 0).map((m) => `${m.r},${m.c}`);
  assert.ok(moves.includes('0,3'));
  assert.ok(moves.includes('0,5'));
  assert.ok(!moves.includes('-1,4'));
});

test('路障不能重叠、不能交叉', () => {
  const g = newGame({ size: 9 }, 2);
  assert.equal(applyWall(g, 0, 'h', 4, 3).ok, true);
  g.turn = 0;
  assert.equal(canPlaceWall(g, 0, 'h', 4, 3).reason, 'occupied');
  assert.equal(canPlaceWall(g, 0, 'h', 4, 4).reason, 'occupied');
  assert.equal(canPlaceWall(g, 0, 'h', 4, 2).reason, 'occupied');
  // 竖墙 (3, 4) 覆盖 v[3][4] 与 v[4][4]，正好穿过横墙 (4,3) 的中点
  assert.equal(canPlaceWall(g, 0, 'v', 3, 4).reason, 'cross');
  // T 型相接是允许的：竖墙 (4,4) 的顶端只接触横墙端点
  assert.equal(canPlaceWall(g, 0, 'v', 4, 4).ok, true);
  // 隔壁一条线上的竖墙完全没问题
  assert.equal(canPlaceWall(g, 0, 'v', 3, 5).ok, true);
});

test('不能把对手完全封死', () => {
  const g = newGame({ size: 9 }, 2);
  g.pawns[0] = { r: 8, c: 8 };
  g.pawns[1] = { r: 0, c: 0 }; // 把对手挪到角落，方便构造围困

  // 竖墙 (0,2) 封住 x=2 这条线；横墙 (2,0) 封住 y=2 这条线。
  // 两面墙只在端点相接，是合法组合，合起来把 {(0,0),(0,1),(1,0),(1,1)} 围死。
  g.turn = 0;
  assert.equal(applyWall(g, 0, 'v', 0, 2).ok, true);
  assert.equal(hasPathToGoal(g, 0, 0), true, '只放一面墙还不该封死');

  g.turn = 0;
  const second = applyWall(g, 0, 'h', 2, 0);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'seal-player');
  assert.equal(hasPathToGoal(g, 0, 0), true, '被拒绝的墙不能留在棋盘上');
});

test('不能把中央方块完全封死', () => {
  const g = newGame({ size: 9 }, 2);
  g.pawns[0] = { r: 8, c: 8 };
  g.pawns[1] = { r: 0, c: 0 };

  // 逐条封住中央格 (4,4) 的四条边，四面墙互不交叉：
  //   h(4,3) 封上边、h(5,4) 封下边、v(4,4) 封左边
  const first = [
    ['h', 4, 3],
    ['h', 5, 4],
    ['v', 4, 4],
  ];
  for (const [d, r, c] of first) {
    g.turn = 0;
    assert.equal(applyWall(g, 0, d, r, c).ok, true, `${d}(${r},${c}) 不应被拒绝`);
  }
  assert.equal(goalHasExit(g), true, '还差右边没封，中央应该仍有开口');

  // 补上右边 v(3,5) 会把中央彻底围死
  g.turn = 0;
  const last = applyWall(g, 0, 'v', 3, 5);
  assert.equal(last.ok, false);
  assert.ok(['seal-goal', 'seal-player'].includes(last.reason), `实际原因：${last.reason}`);
  assert.equal(goalHasExit(g), true);
  assert.equal(hasPathToGoal(g, 8, 8), true);
  assert.equal(hasPathToGoal(g, 0, 0), true);
});

test('抵达中央即获胜', () => {
  const g = newGame({ size: 9 }, 2);
  applyMove(g, 0, 7, 4);
  applyMove(g, 1, 1, 4);
  applyMove(g, 0, 6, 4);
  applyMove(g, 1, 2, 4);
  applyMove(g, 0, 5, 4);
  applyMove(g, 1, 3, 4);
  assert.equal(g.phase, 'playing');
  const res = applyMove(g, 0, 4, 4); // 踩上中央格
  assert.equal(res.ok, true);
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, 0);
  // 结束后不能再走
  assert.equal(applyMove(g, 1, 4, 4).ok, false);
});

test('四人局：轮转顺序 0→1→2→3', () => {
  const g = newGame({ size: 9 }, 4);
  const order = [g.turn];
  for (let i = 0; i < 3; i++) {
    const seat = g.turn;
    const mv = legalMoves(g, seat)[0];
    applyMove(g, seat, mv.r, mv.c);
    order.push(g.turn);
  }
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('每人路障数有限', () => {
  const g = newGame({ size: 9, walls: 1 }, 2);
  g.turn = 0;
  assert.equal(applyWall(g, 0, 'h', 1, 0).ok, true);
  g.turn = 0;
  const res = applyWall(g, 0, 'h', 3, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-walls-left');
});

test('墙的坐标会被吸附回合法范围', () => {
  const g = newGame({ size: 9 }, 2);
  const res = canPlaceWall(g, 0, 'h', 0, 0);
  assert.equal(res.ok, true);
  assert.equal(res.r, 1, 'r=0 是最外圈，应吸附到 r=1');
  const res2 = canPlaceWall(g, 0, 'v', 0, 0);
  assert.equal(res2.ok, true);
  assert.equal(res2.c, 1);
});

test('wallBetween 对相邻格判定一致', () => {
  const g = newGame({ size: 9 }, 2);
  g.turn = 0;
  applyWall(g, 0, 'v', 4, 4);
  assert.equal(wallBetween(g, { r: 4, c: 3 }, { r: 4, c: 4 }), true);
  assert.equal(wallBetween(g, { r: 4, c: 4 }, { r: 4, c: 5 }), false);
  assert.equal(wallBetween(g, { r: 3, c: 3 }, { r: 3, c: 4 }), false);
  assert.equal(wallBetween(g, { r: 5, c: 3 }, { r: 5, c: 4 }), true);
});

/* ------------------------------------------------------------------ */
/* 宝箱与道具                                                          */
/* ------------------------------------------------------------------ */

test('宝箱设置：数量、存续模式与产出道具池', () => {
  const s = normalizeSettings({ chests: 3, chestOnce: false, itemSlots: 2 });
  assert.equal(s.chests, 3);
  assert.equal(s.chestOnce, false);
  assert.equal(s.itemSlots, 2);
  assert.deepEqual(s.chestItems, ['teleport', 'break', 'trap']);
  // 数量与道具栏都会被夹到合法范围
  assert.equal(normalizeSettings({ chests: 99 }).chests, 10);
  assert.equal(normalizeSettings({ itemSlots: 0 }).itemSlots, 1);
  assert.equal(normalizeSettings({ itemSlots: 99 }).itemSlots, 5);
});

test('宝箱产出道具池支持数组 / 开关对象 / 空池回落', () => {
  assert.deepEqual(normalizeChestItems(['trap']), ['trap']);
  assert.deepEqual(normalizeChestItems([ITEM_KIND.BREAK]), ['break']);
  assert.deepEqual(normalizeChestItems({ teleport: true, break: false, trap: true }), [
    'teleport',
    'trap',
  ]);
  // 一个都不勾 = 宝箱永远开不出东西，回落成全开
  assert.deepEqual(normalizeChestItems([]), ['teleport', 'break', 'trap']);
  assert.deepEqual(normalizeChestItems({}), ['teleport', 'break', 'trap']);
});

test('宝箱随机落在非目标格上，且不会重复落点', () => {
  const g = createGame({ size: 9, chests: 6 }, seats(2));
  assert.equal(g.chests.length, 6);
  const goals = new Set(goalCells(9, 1).map((p) => `${p.r},${p.c}`));
  const seen = new Set();
  for (const ch of g.chests) {
    const key = `${ch.r},${ch.c}`;
    assert.ok(!goals.has(key), `宝箱不该落在中央格 ${key}`);
    assert.ok(!seen.has(key), `宝箱落点重复：${key}`);
    seen.add(key);
  }
  assert.deepEqual(g.chests[0].openedBy, []);
  // 数量为 0 时干脆没有宝箱
  assert.equal(createGame({ size: 9, chests: 0 }, seats(2)).chests.length, 0);
});

test('一次性宝箱：谁开过就没了，第二个人开不出来', () => {
  const g = createGame({ size: 9, chests: 0, chestOnce: true }, seats(2));
  g.chests = [{ id: 0, r: 6, c: 6, openedBy: [] }];
  g.pawns[0] = { r: 6, c: 5 };
  g.turn = 0;
  const res = applyMove(g, 0, 6, 6);
  assert.equal(res.ok, true);
  assert.ok(res.opened, '走到宝箱格应该开出宝箱');
  assert.equal(res.opened.chestId, 0);
  assert.deepEqual(g.chests[0].openedBy, [0]);

  // 对手踩上来也不能再拿到（先把开过箱的人挪走，否则格子被占着走不进去）
  g.pawns[0] = { r: 7, c: 7 };
  g.pawns[1] = { r: 6, c: 7 };
  g.turn = 1;
  applyMove(g, 1, 6, 6);
  assert.equal(chestAt(g, 6, 6).openedBy.length, 1, '一次性宝箱被开过就不再产出');
  assert.ok(!g.chests[0].openedBy.includes(1));
});

test('常驻宝箱：每个玩家各能开一次', () => {
  const g = createGame({ size: 9, chests: 0, chestOnce: false }, seats(2));
  g.chests = [{ id: 0, r: 6, c: 6, openedBy: [] }];
  g.pawns[0] = { r: 6, c: 5 };
  g.pawns[1] = { r: 5, c: 6 };
  g.turn = 0;

  const r1 = applyMove(g, 0, 6, 6);
  assert.ok(r1.opened, '玩家 0 第一次开箱成功');
  g.turn = 1;
  // 玩家 0 还站在宝箱上，先把玩家 1 挪到宝箱旁边再走上去
  g.pawns[0] = { r: 7, c: 7 };
  const r2 = applyMove(g, 1, 6, 6);
  assert.ok(r2.opened, '玩家 1 也能开同一个常驻宝箱');
  g.turn = 0;
  // 玩家 0 再踩一次：已经拿过了
  g.pawns[1] = { r: 7, c: 7 };
  g.pawns[0] = { r: 6, c: 5 };
  const r3 = applyMove(g, 0, 6, 6);
  assert.equal(r3.opened, null, '常驻宝箱对同一玩家只产出一次');
  assert.deepEqual(g.chests[0].openedBy, [0, 1]);
});

test('宝箱不会卡住回合：开箱后照常轮到下一个人', () => {
  const g = createGame({ size: 9, chests: 0 }, seats(2));
  g.chests = [{ id: 0, r: 6, c: 6, openedBy: [] }];
  g.pawns[0] = { r: 6, c: 5 };
  g.turn = 0;
  applyMove(g, 0, 6, 6);
  assert.equal(g.turn, 1);
});

/* ------------------------------------------------------------------ */
/* 道具：随机传送 / 破墙 / 陷阱                                        */
/* ------------------------------------------------------------------ */

test('随机传送不会落到中央目标格', () => {
  const g = createGame({ size: 9, goalSize: 1 }, seats(2));
  const goals = new Set(goalCells(9, 1).map((p) => `${p.r},${p.c}`));
  for (let i = 0; i < 200; i++) {
    const cell = randomTeleportCell(g, 0);
    assert.ok(cell, '棋盘上应该有可传送的格子');
    assert.ok(!goals.has(`${cell.r},${cell.c}`), `传送到终点是不允许的：${cell.r},${cell.c}`);
    assert.notDeepEqual(cell, g.pawns[0]);
  }
});

test('随机传送从剔除终点后的池子里取（确定性 rng）', () => {
  const g = createGame({ size: 5, goalSize: 1 }, seats(2));
  // 座位 0 起点 (4,2)，(2,2) 是中央格，都不该出现在候选池里
  const first = randomTeleportCell(g, 0, () => 0);
  assert.deepEqual(first, { r: 0, c: 0 });
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const cell = randomTeleportCell(g, 0);
    seen.add(`${cell.r},${cell.c}`);
  }
  assert.ok(!seen.has('2,2'), '终点必须被排除');
  assert.ok(!seen.has('4,2'), '自己脚下那格会被排除');
});

test('破墙：只能砸对手的路障', () => {
  const g = createGame({ size: 9, walls: 10 }, seats(2));
  g.turn = 0;
  applyWall(g, 0, 'h', 4, 3);      // 自己（座位 0）的墙
  g.turn = 1;
  applyWall(g, 1, 'h', 6, 3);      // 对手（座位 1）的墙
  assert.equal(g.walls.length, 2);

  // 座位 1 不能砸自己的墙
  g.turn = 1;
  assert.equal(removeWall(g, 1, 1).reason, 'own-wall');
  // 但可以砸座位 0 的墙（下标 0）
  const res = removeWall(g, 1, 0);
  assert.equal(res.ok, true);
  assert.equal(g.walls.length, 1);
  assert.equal(g.walls[0].seat, 1, '剩下的应该是自己的那面墙');
  // 砸掉之后墙的通行判定要恢复
  assert.equal(wallBetween(g, { r: 3, c: 3 }, { r: 4, c: 3 }), false);
});

test('破墙：不存在的下标会被拒绝', () => {
  const g = createGame({ size: 9 }, seats(2));
  g.turn = 0;
  assert.equal(removeWall(g, 0, 5).reason, 'no-wall');
});

test('陷阱：不能放在中央方块上，也不能叠放', () => {
  const g = createGame({ size: 9, goalSize: 1 }, seats(2));
  g.turn = 0;
  assert.equal(canPlaceTrap(g, 0, 4, 4).reason, 'trap-on-goal', '中央格不允许埋雷');
  assert.equal(canPlaceTrap(g, 0, 20, 20).reason, 'out-of-board');
  assert.equal(applyPlaceTrap(g, 0, 2, 2).ok, true);
  assert.equal(applyPlaceTrap(g, 0, 2, 2).reason, 'trap-occupied');
  assert.equal(g.traps.length, 1);
  assert.deepEqual(g.traps[0], { r: 2, c: 2, seat: 0 });
});

test('踩中陷阱：棋子被跳过下一回合', () => {
  const g = createGame({ size: 9 }, seats(2));
  g.traps = [{ r: 6, c: 6, seat: 1 }];   // 对手埋的雷
  g.pawns[0] = { r: 6, c: 5 };
  g.turn = 0;

  const res = applyMove(g, 0, 6, 6);
  assert.equal(res.ok, true);
  assert.ok(res.trapped, '应该报告踩中陷阱');
  assert.equal(res.skipped, true);
  assert.equal(g.traps.length, 0, '陷阱触发后就被消耗掉');
  assert.equal(isSkipped(g, 0), true);

  // 回合已经交给对手
  assert.equal(g.turn, 1);

  // 对手走完，轮回座位 0：此时它应该不能行动
  applyMove(g, 1, 1, 4);
  assert.equal(g.turn, 0);
  assert.equal(applyMove(g, 0, 5, 6).reason, 'skipped');
  assert.equal(canPlaceWall(g, 0, 'h', 3, 3).reason, 'skipped');

  // 跳过结算后一切恢复正常
  assert.equal(skipTurn(g, 0).ok, true);
  assert.equal(g.turn, 1);
  assert.equal(isSkipped(g, 0), false, '跳过标记用完即清');
});

test('自己的陷阱不会炸到自己', () => {
  const g = createGame({ size: 9 }, seats(2));
  g.traps = [{ r: 6, c: 6, seat: 0 }];   // 自己埋的
  g.pawns[0] = { r: 6, c: 5 };
  g.turn = 0;
  const res = applyMove(g, 0, 6, 6);
  assert.equal(res.trapped, false);
  assert.equal(isSkipped(g, 0), false);
  assert.equal(g.traps.length, 1, '自己的陷阱不会被自己触发');
});

test('踩到陷阱格同时又是宝箱格：两件事都会发生', () => {
  const g = createGame({ size: 9, chests: 0 }, seats(2));
  g.chests = [{ id: 0, r: 6, c: 6, openedBy: [] }];
  g.traps = [{ r: 6, c: 6, seat: 1 }];
  g.pawns[0] = { r: 6, c: 5 };
  g.turn = 0;
  const res = applyMove(g, 0, 6, 6);
  assert.ok(res.opened, '宝箱照开');
  assert.ok(res.trapped, '陷阱照炸');
  assert.equal(isSkipped(g, 0), true);
});

test('超时托管：被跳过时返回 skip 而不是走子', () => {
  const g = createGame({ size: 9 }, seats(2));
  assert.equal(pickAutoAction(g, 0).type, 'move');
  g.seatState[0].skipTurns = 1;
  assert.deepEqual(pickAutoAction(g, 0), { type: 'skip' });
});

test('正常走子不会误触发跳过（seatState 长度与座位对齐）', () => {
  const g = createGame({ size: 9 }, seats(4));
  assert.equal(g.seatState.length, 4);
  for (const st of g.seatState) assert.equal(st.skipTurns, 0);
  applyMove(g, 0, 7, 4);
  assert.equal(isSkipped(g, 0), false);
  assert.equal(g.turn, 1);
});