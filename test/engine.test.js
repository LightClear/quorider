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