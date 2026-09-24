/**
 * 房间管理层单测（不起服务器，直接调 RoomManager）。
 *
 * 这里放的是「协议层测试很难确定性触发」的路径：
 *   - 不限时房间里被陷阱困住的人怎么被跳过（否则整局卡死）
 *   - 逐人状态里的隐私过滤（道具背包 / 陷阱位置）
 *   - 宝箱开箱发道具与道具栏上限
 *   - 观众 / 玩家席的准入规则（含一局结束后）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms.js';
import { ITEM_KIND, openChestAt } from '../src/engine.js';

/** 建一个已经开局的房间：房主 h + 访客 g。 */
function makeRoom(settings = {}) {
  const m = new RoomManager();
  const room = m.createRoom({
    pid: 'h',
    name: '房主',
    settings: { size: 9, chests: 0, turnTimer: 0, ...settings },
  });
  m.joinRoom({ code: room.code, pid: 'g', name: '访客' });
  m.startGame(room, 'h');
  return { m, room };
}

const seatOf = (room, pid) => room.game.seats.findIndex((s) => s.id === pid);

test('不限时房间：被陷阱困住的人会被自动跳过（防卡死）', () => {
  const { m, room } = makeRoom({ turnTimer: 0 });
  const seat = seatOf(room, 'h');
  assert.equal(room.game.turn, seat);

  // 手动给他挂上「跳过一回合」
  room.game.seatState[seat].skipTurns = 1;
  assert.equal(room.deadline, null, '不限时房间本来就没有倒计时');

  // tick 应该把这一回合跳过并把行动权交给下一个人
  const changed = m.tick(room);
  assert.equal(changed, true, 'tick 应该报告状态有变化');
  assert.equal(room.game.seatState[seat].skipTurns, 0, '跳过标记被消耗');
  assert.equal(room.game.turn, seatOf(room, 'g'), '回合交给下一个人');
});

/**
 * 回归：**限时房间**里踩中陷阱的人，轮到他时必须立刻被跳过，
 * 而不是干等自己那一回合的倒计时走完。
 *
 * 老实现只在 `!room.deadline`（不限时）分支里兜底跳过，
 * 限时房间要等 turnTimer 秒耗尽才跳，看起来就像「根本不会自动跳过」。
 */
test('限时房间：轮到被陷阱困住的人时立刻跳过，不等倒计时', () => {
  const { m, room } = makeRoom({ turnTimer: 60 });
  const victim = seatOf(room, 'h');
  const other = seatOf(room, 'g');

  room.game.seatState[victim].skipTurns = 1;
  // 倒计时是「刚刚续上」的，远没到点
  assert.ok(room.deadline > Date.now() + 50000, '前置条件：倒计时还早');

  const changed = m.tick(room);

  assert.equal(changed, true, 'tick 应该报告状态有变化');
  assert.equal(room.game.seatState[victim].skipTurns, 0, '跳过标记应被消耗');
  assert.equal(room.game.turn, other, '回合应立刻交给下一个人');
  assert.equal(room.game.lastMove?.type, 'skip', '这一手应该记成 skip');
});

test('限时房间：换手动作一结束就结算跳过（不用等 tick）', () => {
  const { m, room } = makeRoom({ turnTimer: 60 });
  const victim = seatOf(room, 'h');
  const other = seatOf(room, 'g');

  // 对手走一步，把回合交给「踩过陷阱」的座位
  room.game.turn = other;
  room.game.seatState[victim].skipTurns = 1;
  m.move(room, 'g', { r: 1, c: 4 });

  assert.equal(room.game.seatState[victim].skipTurns, 0, '跳过标记应被消耗');
  assert.equal(room.game.turn, other, '跳过之后应回到对手，而不是停在受害者身上');
});

test('限时房间：放墙换手后同样立刻结算跳过', () => {
  const { m, room } = makeRoom({ turnTimer: 60, walls: 5 });
  const victim = seatOf(room, 'h');
  const other = seatOf(room, 'g');

  room.game.turn = other;
  room.game.seatState[victim].skipTurns = 1;
  const res = m.placeWall(room, 'g', { d: 'h', r: 4, c: 3 });
  assert.ok(!res.error, `放墙不该失败：${res.error}`);

  assert.equal(room.game.seatState[victim].skipTurns, 0);
  assert.equal(room.game.turn, other, '跳过之后回合回到对手');
});

test('连续两个人被困住时会一路跳过，直到轮到能行动的人', () => {
  const m = new RoomManager();
  const room = m.createRoom({ pid: 'h', name: '房主', settings: { size: 9, maxPlayers: 4, turnTimer: 60 } });
  m.joinRoom({ code: room.code, pid: 'b', name: '乙' });
  m.joinRoom({ code: room.code, pid: 'c', name: '丙' });
  m.startGame(room, 'h');
  assert.equal(room.game.seats.length, 3);

  // 座位 0 和 1 都被困住，当前正好轮到座位 0
  room.game.turn = 0;
  room.game.seatState[0].skipTurns = 1;
  room.game.seatState[1].skipTurns = 1;

  const changed = m.tick(room);
  assert.equal(changed, true);
  assert.equal(room.game.seatState[0].skipTurns, 0);
  assert.equal(room.game.seatState[1].skipTurns, 0);
  assert.equal(room.game.turn, 2, '一路跳到第一个能行动的人');
});

test('跳过不会死循环：全员都被困住时也只是各跳一次', () => {
  const { m, room } = makeRoom({ turnTimer: 60 });
  room.game.turn = 0;
  room.game.seatState[0].skipTurns = 1;
  room.game.seatState[1].skipTurns = 1;

  const changed = m.tick(room);
  assert.equal(changed, true);
  assert.equal(room.game.seatState[0].skipTurns, 0);
  assert.equal(room.game.seatState[1].skipTurns, 0);
  // 两个人都跳完，回到座位 0，且不再有任何跳过标记
  assert.equal(room.game.turn, 0);
  assert.equal(m.tick(room), false, '第二次 tick 不该再有事发生');
});

test('踩中陷阱会私聊受害者一条提示（全场播报之外）', () => {
  const { m, room } = makeRoom();
  const sent = [];
  room.players.get('h').conn = { ready: true, send: (o) => sent.push(o), destroy() {} };

  m._announceTrap(room, seatOf(room, 'h'), { owner: seatOf(room, 'g') });

  const toast = sent.find((o) => o.toast);
  assert.ok(toast, '受害者应收到一条私聊提示');
  assert.match(toast.toast, /陷阱/);
  assert.equal(toast.toastKind, 'warn');
  // 同时全场日志 + 系统弹幕都要有（「全场播报」）
  assert.ok(room.log.some((l) => l.text.includes('陷阱')));
  assert.ok(room.danmaku.some((d) => d.system && d.text.includes('陷阱')));
});

test('不限时房间：没被困住时 tick 不会乱动回合', () => {
  const { m, room } = makeRoom({ turnTimer: 0 });
  assert.equal(m.tick(room), false);
  assert.equal(room.game.turn, 0);
});

test('限时房间：被陷阱困住时超时托管走的是「跳过」而不是走子', () => {
  const { m, room } = makeRoom({ turnTimer: 1 });
  const seat = seatOf(room, 'h');
  room.game.seatState[seat].skipTurns = 1;
  // 把倒计时拨到过去，模拟超时
  room.deadline = Date.now() - 1;
  // tick 需要当前玩家在线；没有 conn 会被当成掉线而暂停倒计时，
  // 所以这里塞一个假的 ready 连接。
  room.players.get('h').conn = { ready: true, send() {}, destroy() {} };

  const changed = m.tick(room);
  assert.equal(changed, true);
  assert.equal(room.game.seatState[seat].skipTurns, 0);
  assert.equal(room.game.turn, seatOf(room, 'g'));
  // 被跳过不该被记成走子
  assert.equal(room.game.lastMove?.type, 'skip');
});

test('隐私：道具背包只出现在自己的状态里', () => {
  const { m, room } = makeRoom();
  room.priv('h').items = [ITEM_KIND.TELEPORT, ITEM_KIND.TRAP];

  const mine = m.publicStateFor(room, 'h');
  const other = m.publicStateFor(room, 'g');

  assert.deepEqual(mine.me.items, [ITEM_KIND.TELEPORT, ITEM_KIND.TRAP]);
  assert.deepEqual(other.me.items, [], '别人的背包是空的（他自己的）');
  // 座位信息里根本不该有道具字段
  for (const s of mine.game.seats) {
    assert.equal(s.items, undefined, '座位对象不能带道具字段');
  }
  // 公共状态（不含视角的那份）里也不能有任何人手上的道具
  // 注意 chestPool 是「房间设置」，本来就应该公开，不算泄漏。
  const pub = m.publicState(room);
  assert.equal(JSON.stringify(pub).includes('"items"'), false, '公共状态里不该出现 items 字段');
  for (const s of pub.game.seats) {
    assert.equal(s.items, undefined);
  }
});

test('隐私：陷阱只发给埋雷的人', () => {
  const { m, room } = makeRoom();
  room.game.traps = [
    { r: 1, c: 1, seat: 0 },
    { r: 3, c: 3, seat: 1 },
  ];
  const a = m.publicStateFor(room, 'h'); // 座位 0
  const b = m.publicStateFor(room, 'g'); // 座位 1
  assert.deepEqual(a.game.traps, [{ r: 1, c: 1, seat: 0 }], '只看到自己埋的');
  assert.deepEqual(b.game.traps, [{ r: 3, c: 3, seat: 1 }]);
  // 公共状态（不含视角）里也是过滤前的原样，注意别直接拿它广播
  assert.equal(m.publicState(room).game.traps.length, 2);
});

test('隐私：广播给每个人的 payload 各不相同', () => {
  const { m, room } = makeRoom();
  room.priv('h').items = [ITEM_KIND.BREAK];
  room.game.traps = [{ r: 2, c: 2, seat: 0 }];

  const sent = new Map();
  const fakeConn = (pid) => ({ ready: true, send: (o) => sent.set(pid, o), destroy() {} });
  room.players.get('h').conn = fakeConn('h');
  room.players.get('g').conn = fakeConn('g');
  m.broadcast(room);

  assert.deepEqual(sent.get('h').me.items, [ITEM_KIND.BREAK]);
  assert.deepEqual(sent.get('g').me.items, []);
  assert.equal(sent.get('h').game.traps.length, 1);
  assert.equal(sent.get('g').game.traps.length, 0, '对手看不到我埋的陷阱');
});

test('开箱发道具：道具栏满了就不再产出，也不消耗宝箱', () => {
  const { m, room } = makeRoom({ itemSlots: 1 });
  const seat = seatOf(room, 'h');
  room.game.chestMode = 'forever';
  room.game.chests = [{ id: 0, r: 5, c: 5, openedBy: [] }];

  // 走上去 → 开箱 → 发道具
  const res = openChestAt(room.game, seat, 5, 5);
  assert.ok(res, '第一次能开');
  m._grantChestItem(room, seat, res);
  assert.equal(room.priv('h').items.length, 1, '拿到一件');

  // 道具栏满了：再拿就被拒绝（grantItem 会返回 null）
  assert.equal(room.grantItem('h', ITEM_KIND.TRAP), null, '满了就发不出去');
  assert.equal(room.priv('h').items.length, 1, '背包不会被撑爆');
});

test('开箱发道具：宝箱是常驻时，每个人各能开一次', () => {
  const { m, room } = makeRoom({ itemSlots: 3 });
  room.game.chestMode = 'forever';
  room.game.chests = [{ id: 0, r: 5, c: 5, openedBy: [] }];

  const a = openChestAt(room.game, seatOf(room, 'h'), 5, 5);
  const b = openChestAt(room.game, seatOf(room, 'g'), 5, 5);
  assert.ok(a && b, '两个人都能开同一个常驻宝箱');
  m._grantChestItem(room, seatOf(room, 'h'), a);
  m._grantChestItem(room, seatOf(room, 'g'), b);

  // 同一个座位再开：不再产出
  assert.equal(openChestAt(room.game, seatOf(room, 'h'), 5, 5), null);
  assert.equal(room.priv('h').items.length, 1);
  assert.equal(room.priv('g').items.length, 1);
});

test('观众与玩家席：大厅可入座、对局中只能当观众、结束后又能入座', () => {
  const m = new RoomManager();
  const room = m.createRoom({ pid: 'h', name: '房主', settings: { size: 9, maxPlayers: 4 } });

  // 大厅：进来就是玩家
  const l = m.joinRoom({ code: room.code, pid: 'p1', name: '甲' });
  assert.equal(l.player.spectator, false, '大厅里进来是玩家');

  m.startGame(room, 'h');
  // 对局中：只能当观众
  const v = m.joinRoom({ code: room.code, pid: 'p2', name: '乙' });
  assert.equal(v.player.spectator, true, '对局进行中进来是观众');

  // 一局结束、还没开下一局：新来的又算玩家
  room.game.phase = 'finished';
  const late = m.joinRoom({ code: room.code, pid: 'p3', name: '丙' });
  assert.equal(late.player.spectator, false, '结束后进来算玩家');

  // 对局中进来的观众，也会在本局结束后被放回玩家席（上限 4，坐得下）
  m._promoteWaitingSpectators(room);
  assert.equal(room.players.get('p2').spectator, false, '观众被放回玩家席');
  assert.deepEqual(
    room.contenders().map((p) => p.pid).sort(),
    ['h', 'p1', 'p2', 'p3'],
    '四个人都在玩家席上',
  );
});

test('观众回到玩家席时会尊重人数上限，不会超员', () => {
  const m = new RoomManager();
  const room = m.createRoom({ pid: 'h', name: '房主', settings: { size: 9, maxPlayers: 2 } });
  m.joinRoom({ code: room.code, pid: 'p1', name: '甲' });
  m.startGame(room, 'h');
  // 对局中挤进来两个观众
  m.joinRoom({ code: room.code, pid: 'v1', name: '观众1' });
  m.joinRoom({ code: room.code, pid: 'v2', name: '观众2' });
  assert.equal(room.contenders().length, 2, '对局中参赛者仍是 2 人');

  room.game.phase = 'finished';
  m._promoteWaitingSpectators(room);
  assert.equal(room.contenders().length, 2, '上限是 2，不能因为提升观众而超员');
  assert.equal(room.players.get('v1').spectator, true, '坐不下就继续当观众');
  assert.equal(room.players.get('v2').spectator, true);
});

test('人数满时进来自动当观众，且不会超过人数上限', () => {
  const m = new RoomManager();
  const room = m.createRoom({ pid: 'h', name: '房主', settings: { size: 9, maxPlayers: 2 } });
  const second = m.joinRoom({ code: room.code, pid: 'p1', name: '甲' });
  assert.equal(second.player.spectator, false, '第 2 人坐满');
  const third = m.joinRoom({ code: room.code, pid: 'p2', name: '乙' });
  assert.equal(third.player.spectator, true, '超员就是观众');
  assert.equal(room.contenders().length, 2);
});

test('弹幕：限流与长度裁剪', () => {
  const { m, room } = makeRoom();
  const first = m.danmaku(room, 'h', '  你好   世界  ');
  assert.equal(first.ok, true);
  assert.equal(first.entry.text, '你好 世界', '空白被规整');
  assert.equal(first.entry.name, '房主');
  assert.match(first.entry.color, /^#[0-9a-f]{6}$/i);

  const second = m.danmaku(room, 'h', '再来一条');
  assert.ok(second.error, '1 秒内第二条被拒');
  assert.match(second.error, /太快/);

  // 另一个人不受影响（限流是按人的）
  const other = m.danmaku(room, 'g', '我可以发');
  assert.equal(other.ok, true);

  // 超长内容被裁到 40 字
  room.priv('h').lastDanmakuAt = 0;
  const long = m.danmaku(room, 'h', 'あ'.repeat(200));
  assert.equal(long.entry.text.length, 40);
});

test('头像互动：冷却与非法目标', () => {
  const { m, room } = makeRoom();
  const ok = m.react(room, 'h', 'g', 'poop');
  assert.equal(ok.ok, true);

  const again = m.react(room, 'h', 'g', 'bomb');
  assert.ok(again.error, '立刻再发会撞冷却');
  assert.match(again.error, /冷却/);

  const self = m.react(room, 'g', 'g', 'heart');
  assert.ok(self.error, '不能对自己互动');

  const bad = m.react(room, 'g', 'h', 'nuke');
  assert.ok(bad.error, '不支持的互动类型被拒');

  const ghost = m.react(room, 'h', 'nobody', 'rose');
  assert.ok(ghost.error, '目标不在房间里');
});

test('弹幕：每条带单调递增的 seq（客户端据此跳过历史、避免重播）', () => {
  const { m, room } = makeRoom();

  const a = m.danmaku(room, 'h', '第一条');
  assert.equal(a.entry.seq, 1, '第一条序号是 1');
  const b = m.danmaku(room, 'g', '第二条');
  assert.equal(b.entry.seq, 2, '序号跨玩家也是单调递增的');

  // 陷阱播报也算一条（同样带 seq，否则客户端去重会漏）
  room.traps = [];
  m._announceTrap(room, 0, { owner: 1 });
  const sys = room.danmaku[room.danmaku.length - 1];
  assert.equal(sys.system, true);
  assert.equal(sys.seq, 3, '系统播报也要有 seq');

  // 序号不能重复，否则客户端会把新弹幕当成旧的丢掉
  const seqs = room.danmaku.map((d) => d.seq);
  assert.deepEqual(seqs, [...new Set(seqs)], 'seq 不能重复');
  assert.deepEqual(seqs, [1, 2, 3]);

  // state 里带出去的也是同一批（客户端靠它对齐）
  const pub = m.publicState(room);
  assert.deepEqual(pub.danmaku.map((d) => d.seq), [1, 2, 3]);
});

test('弹幕：历史被裁掉后，新弹幕的 seq 仍然继续增长', () => {
  const { m, room } = makeRoom();
  // 灌满并超过上限，逼出裁剪
  for (let i = 0; i < 40; i++) {
    room.priv('h').lastDanmakuAt = 0; // 绕过冷却
    m.danmaku(room, 'h', `第 ${i} 条`);
  }
  assert.ok(room.danmaku.length <= 30, `历史上限应生效，实际 ${room.danmaku.length}`);
  const last = room.danmaku[room.danmaku.length - 1];
  assert.equal(last.seq, 40, '裁剪不影响序号继续增长');
  // 被裁掉的是最老的，最新的必须还在
  assert.equal(room.danmaku[0].seq, 11);
});

test('观众身份的重连：本局结束后重新进来会被放回玩家席', () => {
  const m = new RoomManager();
  const room = m.createRoom({ pid: 'h', name: '房主', settings: { size: 9, maxPlayers: 4 } });
  m.joinRoom({ code: room.code, pid: 'p1', name: '甲' });
  m.startGame(room, 'h');

  // 对局中进来只能当观众
  const v = m.joinRoom({ code: room.code, pid: 'v1', name: '观众' });
  assert.equal(v.player.spectator, true);

  // 本局结束后他（掉线状态）重新 join：应该被放回玩家席，
  // 否则会一直卡在观众席、房主重开时又被漏掉。
  room.game.phase = 'finished';
  const back = m.joinRoom({ code: room.code, pid: 'v1', name: '观众' });
  assert.equal(back.reconnected, true);
  assert.equal(back.player.spectator, false, '结束后重连应回到玩家席');
});

test('关掉宝箱后场上没有宝箱，也没有道具可发', () => {
  const { room } = makeRoom({ chests: 0 });
  assert.deepEqual(room.game.chests, []);
  assert.deepEqual(room.game.chestPool, ['teleport', 'break', 'trap'], '产出池仍是默认全开');
  assert.equal(room.game.itemSlots, 3);
});
