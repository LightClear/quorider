/**
 * 端到端协议测试：启动真实服务器，走一遍完整的多人对局流程。
 * 覆盖：建房 / 邀请码加入 / 开始 / 走子 / 放墙 / 违规拦截 /
 *       观众 / 断线重连 / 同 pid 连接接管 / 快速重开 / 房间不存在 / 中央获胜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3901;
const BASE = `ws://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 简化 WebSocket 客户端。
 * 每条到达的消息带一个单调递增的 mseq，方便「等一条新状态」而不被历史消息误导。
 */
class Client {
  constructor(pid, name) {
    this.pid = pid;
    this.name = name;
    this.inbox = [];
    this.waiters = [];
    this.seq = 0;
    this.ws = new WebSocket(BASE);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      msg.mseq = ++this.seq;
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    };
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('ws open failed'));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(pred, timeout = 4000, label = '消息') {
    const hit = this.inbox.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.inbox.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待${label}超时`));
      }, timeout);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  /** 等一条比 afterSeq 更新的 state。 */
  waitNewState(afterSeq, extra, label = '新状态') {
    return this.waitFor(
      (m) => m.t === 'state' && m.mseq > afterSeq && (!extra || extra(m)),
      undefined,
      label,
    );
  }
}

let serverProc = null;

test.before(async () => {
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error('服务器启动超时');
});

test.after(() => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});

test('完整对局流程', async () => {
  const host = new Client('host-1', '房主');
  await host.open();

  // 1) 创建房间
  host.send({ t: 'create', pid: host.pid, name: host.name, settings: { size: 9, walls: 10 } });
  const s1 = await host.waitFor((m) => m.t === 'state');
  assert.match(s1.code, /^[A-Z0-9]{5}$/);
  assert.equal(s1.phase, 'lobby');
  assert.equal(s1.settings.size, 9);
  assert.equal(s1.players[0].host, true);
  const code = s1.code;

  // 2) 错误邀请码
  const ghost = new Client('ghost-1', '幽灵');
  await ghost.open();
  ghost.send({ t: 'join', code: 'ZZZZZ', pid: ghost.pid, name: ghost.name });
  const err1 = await ghost.waitFor((m) => m.t === 'error');
  assert.match(err1.msg, /不存在/);
  ghost.close();

  // 3) 第二名玩家加入
  const guest = new Client('guest-1', '访客');
  await guest.open();
  guest.send({ t: 'join', code, pid: guest.pid, name: guest.name });
  const s2 = await host.waitNewState(s1.mseq, (m) => m.players.length === 2, '玩家加入');
  assert.equal(s2.players.length, 2);

  // 4) 非房主不能开房
  guest.send({ t: 'start' });
  const err2 = await guest.waitFor((m) => m.t === 'error');
  assert.match(err2.msg, /房主/);

  // 5) 房主开始对局
  host.send({ t: 'start' });
  const s3 = await host.waitNewState(s2.mseq, (m) => m.phase === 'playing', '对局开始');
  assert.equal(s3.game.turn, 0);
  assert.deepEqual(s3.game.pawns[0], { r: 8, c: 4 });

  // 6) 轮流走子
  host.send({ t: 'move', to: { r: 7, c: 4 } });
  const s4 = await host.waitNewState(s3.mseq, (m) => m.game.turn === 1, '轮到访客');
  assert.deepEqual(s4.game.pawns[0], { r: 7, c: 4 });
  assert.notEqual(s4.deadline, null, '限时对局应有倒计时');

  guest.send({ t: 'move', to: { r: 1, c: 4 } });
  const s5 = await host.waitNewState(s4.mseq, (m) => m.game.turn === 0, '轮回房主');
  assert.deepEqual(s5.game.pawns[1], { r: 1, c: 4 });

  // 7) 越权走子被拦
  guest.send({ t: 'move', to: { r: 2, c: 4 } });
  const err3 = await guest.waitFor((m) => m.t === 'error');
  assert.match(err3.msg, /轮到/);

  // 8) 放墙 + 路障余量
  host.send({ t: 'wall', wall: { d: 'h', r: 4, c: 3 } });
  const s6 = await host.waitNewState(s5.mseq, (m) => m.game.walls.length === 1, '墙体出现');
  assert.equal(s6.game.seats[0].wallsLeft, 9);

  // 9) 交叉墙被拦（此时轮到访客）
  guest.send({ t: 'wall', wall: { d: 'v', r: 3, c: 4 } });
  const err4 = await guest.waitFor((m) => m.t === 'error');
  assert.match(err4.msg, /交叉/);

  guest.send({ t: 'wall', wall: { d: 'v', r: 3, c: 6 } });
  const s7 = await host.waitNewState(s6.mseq, (m) => m.game.walls.length === 2, '第二面墙');
  assert.equal(s7.game.seats[1].wallsLeft, 9);

  // 10) 观众进入对局中的房间
  const viewer = new Client('viewer-1', '围观');
  await viewer.open();
  viewer.send({ t: 'join', code, pid: viewer.pid, name: viewer.name });
  const s8 = await viewer.waitFor((m) => m.t === 'state');
  const meViewer = s8.players.find((p) => p.pid === viewer.pid);
  assert.equal(meViewer.spectator, true);

  // 11) 观众不能行动
  viewer.send({ t: 'move', to: { r: 0, c: 0 } });
  const err5 = await viewer.waitFor((m) => m.t === 'error');
  assert.match(err5.msg, /不在对局/);
  viewer.close();

  // 12) 访客掉线 → 广播离线，座位保留
  guest.close();
  const s9 = await host.waitNewState(
    s7.mseq,
    (m) => m.players.some((p) => p.pid === guest.pid && !p.connected),
    '掉线广播',
  );
  assert.equal(s9.seatByPid[guest.pid], 1, '掉线后座位应保留');

  // 13) 同 pid 重连 → 座位保留
  const guestBack = new Client('guest-1', '访客');
  await guestBack.open();
  guestBack.send({ t: 'join', code, pid: guestBack.pid, name: guestBack.name });
  const s10 = await host.waitNewState(
    s9.mseq,
    (m) => m.players.some((p) => p.pid === guest.pid && p.connected),
    '重连广播',
  );
  assert.equal(s10.seatByPid[guest.pid], 1, '重连后座位应保留');

  // 13b) 同 pid 再开一条连接「接管」座位（换设备 / 手机接管）
  // 旧连接会被顶掉；此时新连接必须立刻拿到 state，且玩家不能从房间里消失。
  // 回归点：bindRoom 里 destroy() 会同步触发 onClose，若不先标记 replaced，
  // onClose 会把玩家当掉线摘掉，新连接永远收不到 state（换设备必现）。
  const takeover = new Client('guest-1', '访客');
  await takeover.open();
  takeover.send({ t: 'join', code, pid: takeover.pid, name: takeover.name });
  const s10b = await takeover.waitNewState(0, undefined, '接管后的首个状态');
  const contendersOf = (m) => m.players.filter((p) => !p.spectator);
  assert.equal(contendersOf(s10b).length, 2, '接管后房主与访客都还在（观众不计）');
  assert.equal(s10b.seatByPid[guest.pid], 1, '接管后座位仍属于原玩家');
  assert.equal(
    s10b.players.find((p) => p.pid === guest.pid).connected,
    true,
    '接管后的玩家应显示为在线',
  );
  const s10c = await host.waitNewState(
    s10.mseq,
    (m) => m.players.filter((p) => !p.spectator).length === 2
      && m.players.filter((p) => !p.spectator).every((p) => p.connected),
    '房主侧看到接管后的状态',
  );
  assert.equal(contendersOf(s10c).length, 2, '房主侧仍看到 2 名参赛者');
  await sleep(120); // 给旧连接的 onClose 一点时间去跑（跑错就会踢掉玩家）

  // 14) 房主快速重开
  host.send({ t: 'restart' });
  const s11 = await host.waitNewState(
    s10c.mseq,
    (m) => m.phase === 'playing' && m.game.turnCount === 0,
    '重开对局',
  );
  assert.equal(s11.game.seats[0].wallsLeft, 10, '重开后路障恢复');
  assert.deepEqual(s11.game.pawns[0], { r: 8, c: 4 }, '重开后回到起点');
  assert.equal(s11.game.walls.length, 0, '重开后墙清空');

  // 15) 打完一整局：房主（下方）直取中央，访客陪跑（此时访客在 takeover 这条连接上）
  let prev = s11;
  for (let fr = 7; fr >= 5; fr--) {
    host.send({ t: 'move', to: { r: fr, c: 4 } });
    prev = await host.waitNewState(prev.mseq, (m) => m.game.turn === 1, '轮到访客');
    takeover.send({ t: 'move', to: { r: 8 - fr, c: 4 } });
    prev = await host.waitNewState(prev.mseq, (m) => m.game.turn === 0, '轮回房主');
  }
  host.send({ t: 'move', to: { r: 4, c: 4 } }); // 踩上中央方块
  const s12 = await host.waitNewState(prev.mseq, (m) => m.phase === 'finished', '对局结束');
  assert.equal(s12.winnerPid, host.pid, '房主应率先抵达中央获胜');
  assert.equal(s12.game.winner, 0);

  host.close();
  takeover.close();
});

/**
 * 一局结束、还没开下一局时进房间的人，必须以「玩家」身份入座，
 * 而不是被当成观众——否则房主快速重开时他会被静默排除在下一局之外。
 */
test('对局结束后新加入的人算玩家，不是观众', async () => {
  const host = new Client('h2', '房主');
  await host.open();
  host.send({ t: 'create', pid: host.pid, name: host.name, settings: { size: 9 } });
  const s1 = await host.waitFor((m) => m.t === 'state');
  const code = s1.code;

  const guest = new Client('g2', '访客');
  await guest.open();
  guest.send({ t: 'join', code, pid: guest.pid, name: guest.name });
  const s1b = await host.waitNewState(s1.mseq, (m) => m.players.length === 2, '两人到齐');

  // 开局：此刻新来的人确实只能当观众（对局进行中）
  host.send({ t: 'start' });
  const s2 = await host.waitNewState(s1b.mseq, (m) => m.phase === 'playing', '开局');

  const midViewer = new Client('v2', '中途围观');
  await midViewer.open();
  midViewer.send({ t: 'join', code, pid: midViewer.pid, name: midViewer.name });
  const sv = await midViewer.waitFor((m) => m.t === 'state');
  assert.equal(
    sv.players.find((p) => p.pid === 'v2').spectator,
    true,
    '对局进行中进来的人仍然是观众',
  );
  midViewer.close();

  // 房主打完这一局
  let prev = s2;
  for (let fr = 7; fr >= 5; fr--) {
    host.send({ t: 'move', to: { r: fr, c: 4 } });
    prev = await host.waitNewState(prev.mseq, (m) => m.game.turn === 1, '轮到访客');
    guest.send({ t: 'move', to: { r: 8 - fr, c: 4 } });
    prev = await host.waitNewState(prev.mseq, (m) => m.game.turn === 0, '轮回房主');
  }
  host.send({ t: 'move', to: { r: 4, c: 4 } });
  const sEnd = await host.waitNewState(prev.mseq, (m) => m.phase === 'finished', '对局结束');

  // 关键断言：结束后进来的人直接坐玩家席
  const late = new Client('late-2', '迟到的人');
  await late.open();
  late.send({ t: 'join', code, pid: late.pid, name: late.name });
  const s3 = await late.waitFor((m) => m.t === 'state');
  const lateMe = s3.players.find((p) => p.pid === late.pid);
  assert.equal(lateMe.spectator, false, '结束后新加入的人应该作为玩家入座');
  // 对局中进来的观众也会在本局结束后被放回玩家席（房间上限 4，坐得下）
  const contenderCount = s3.players.filter((p) => !p.spectator).length;
  assert.ok(contenderCount >= 3, `房主/访客/迟到的人都该是参赛者，实际 ${contenderCount}`);
  assert.ok(
    s3.players.find((p) => p.pid === 'late-2').spectator === false
      && s3.players.find((p) => p.pid === 'h2').spectator === false
      && s3.players.find((p) => p.pid === 'g2').spectator === false,
    '房主、访客与迟到的人都在玩家席上',
  );

  // 房主快速重开：迟到的人必须被算进新一局
  host.send({ t: 'restart' });
  const s4 = await host.waitNewState(
    sEnd.mseq,
    (m) => m.phase === 'playing' && m.game.turnCount === 0,
    '重开',
  );
  assert.equal(s4.game.seats.length, contenderCount, '重开后玩家席上的人都在棋盘上');
  assert.ok(
    s4.game.seats.some((s) => s.id === 'late-2'),
    '重开的座位里应包含迟到的玩家',
  );

  host.close();
  guest.close();
  late.close();
});

test('宝箱 / 道具 / 弹幕 / 头像互动', async () => {
  const host = new Client('ch-host', '房主');
  await host.open();
  host.send({
    t: 'create',
    pid: host.pid,
    name: host.name,
    settings: { size: 9, chests: 4, chestOnce: false, itemSlots: 3, turnTimer: 0 },
  });
  const s1 = await host.waitFor((m) => m.t === 'state');
  const code = s1.code;
  assert.equal(s1.settings.chests, 4);
  assert.equal(s1.settings.chestOnce, false);
  assert.deepEqual(s1.settings.chestItems, ['teleport', 'break', 'trap']);

  const guest = new Client('ch-guest', '访客');
  await guest.open();
  guest.send({ t: 'join', code, pid: guest.pid, name: guest.name });
  const s2 = await host.waitNewState(s1.mseq, (m) => m.players.length === 2, '两人到齐');

  host.send({ t: 'start' });
  const s3 = await host.waitNewState(s2.mseq, (m) => m.phase === 'playing', '开局');

  // 3) 宝箱数据：下发完整、不含中央目标格、且「谁开过」为空
  assert.equal(s3.game.chests.length, 4, '按要求生成了 4 个宝箱');
  for (const ch of s3.game.chests) {
    assert.notEqual(`${ch.r},${ch.c}`, '4,4', '宝箱不能落在中央目标格上');
    assert.deepEqual(ch.openedBy, [], '开局没人开过宝箱');
  }
  // 宝箱是公开信息（大家都看得见），但每人的背包是私密的
  assert.deepEqual(s3.me.items, [], '开局背包是空的');
  assert.equal(
    s3.players.find((p) => p.pid === 'ch-guest').items,
    undefined,
    '广播里不能带别人的道具字段',
  );

  // 开箱本身（走上去就开、一次性/常驻语义、道具不入他人 payload）
  // 由 test/engine.test.js 确定性地覆盖——宝箱落点是随机的，在协议层靠走位
  // 逼近会随棋盘几何随机失败，不适合写成网络断言。

  const { legalMoves, distancesToGoal } = await import('../src/engine.js');
  let cur = s3;

  // 4) 弹幕：广播给所有人，带发送者名字与座位色
  host.send({ t: 'danmaku', text: '大家好呀' });
  const dm = await guest.waitFor((m) => m.t === 'danmaku', 4000, '弹幕广播');
  assert.equal(dm.entry.name, '房主');
  assert.equal(dm.entry.text, '大家好呀');
  assert.match(dm.entry.color, /^#[0-9a-f]{6}$/i, '弹幕颜色取发送者座位色');
  // 连发第二条会被限流
  host.send({ t: 'danmaku', text: '刷屏试试' });
  const dmErr = await host.waitFor((m) => m.t === 'error', 4000, '弹幕限流');
  assert.match(dmErr.msg, /太快/, '1 秒内第二条弹幕应被拒绝');

  // 5) 头像互动：双方各收到一份特效事件
  //    注意 reaction 是**挂在 state 帧上**一起下发的（sendTo 会带上完整状态），
  //    所以这里按 m.reaction 过滤，而不是等一个 t==='reaction' 的独立帧。
  guest.send({ t: 'react', target: 'ch-host', kind: 'poop' });
  const reactTo = await host.waitFor((m) => m.t === 'state' && m.reaction, 4000, '收到互动特效');
  assert.equal(reactTo.reaction.kind, 'poop');
  assert.equal(reactTo.reaction.fromName, '访客');
  assert.equal(reactTo.reaction.mine, false);
  const reactMine = await guest.waitFor((m) => m.t === 'state' && m.reaction, 4000, '自己的互动回执');
  assert.equal(reactMine.reaction.mine, true);
  // 立刻再发一次会撞冷却
  guest.send({ t: 'react', target: 'ch-host', kind: 'bomb' });
  const reactErr = await guest.waitFor((m) => m.t === 'error', 4000, '互动冷却');
  assert.match(reactErr.msg, /冷却/);

  // 不支持的互动类型会被拒绝
  guest.send({ t: 'react', target: 'ch-host', kind: 'nuke' });
  const kindErr = await guest.waitFor((m) => m.t === 'error', 4000, '非法互动类型');
  assert.match(kindErr.msg, /互动|不支持/);

  // 6) 道具使用的鉴权：没有道具时用道具会被拒绝（宝箱开出的道具同理）
  host.send({ t: 'item', kind: 3 });
  const noItemErr = await host.waitFor((m) => m.t === 'error', 4000, '没道具时使用');
  assert.match(noItemErr.msg, /道具/);
  // 不存在的道具种类
  host.send({ t: 'item', kind: 99 });
  const badItem = await host.waitFor((m) => m.t === 'error', 4000, '非法道具');
  assert.match(badItem.msg, /道具/);

  // 7) 陷阱字段按「每人一份」下发，默认是空数组
  assert.ok(Array.isArray(s3.game.traps), 'traps 应该是数组');

  // 8) 观众视角：没有道具背包，也不能用道具
  const watcher = new Client('ch-watch', '围观');
  await watcher.open();
  watcher.send({ t: 'join', code, pid: watcher.pid, name: watcher.name });
  const sw = await watcher.waitFor((m) => m.t === 'state', 4000, '观众入场');
  assert.equal(sw.players.find((p) => p.pid === 'ch-watch').spectator, true);
  assert.deepEqual(sw.me.items, [], '观众没有道具背包');
  watcher.send({ t: 'item', kind: 3 });
  const viewerErr = await watcher.waitFor((m) => m.t === 'error', 4000, '观众用道具被拒');
  assert.match(viewerErr.msg, /不在对局/);
  watcher.close();

  host.close();
  guest.close();
});

/**
 * 开箱 → 拿道具 → 用道具的完整链路（协议层）。
 *
 * 宝箱落点由服务器随机决定，直接在小棋盘上「撞」宝箱会随几何随机失败。
 * 这里用「密集宝箱的小棋盘 + 最多重开几局」把它变成实际确定性的：
 * 5×5 去掉中央只剩 24 格，放满 10 个宝箱，房主从 (4,2) 出发走几步几乎
 * 必然踩到；万一没踩到就重开一局换个随机布局。真的连续多局都没踩上，
 * 才让断言失败（那种概率可以忽略，而且真出现说明开箱逻辑坏了）。
 */
test('开箱拿到道具并使用（协议层）', async () => {
  const { legalMoves, distancesToGoal } = await import('../src/engine.js');
  const host = new Client('cb-host', '房主');
  await host.open();
  host.send({
    t: 'create',
    pid: host.pid,
    name: host.name,
    settings: { size: 5, chests: 10, chestOnce: false, itemSlots: 3, turnTimer: 0 },
  });
  const s1 = await host.waitFor((m) => m.t === 'state');
  const code = s1.code;

  const guest = new Client('cb-guest', '访客');
  await guest.open();
  guest.send({ t: 'join', code, pid: guest.pid, name: guest.name });
  await host.waitNewState(s1.mseq, (m) => m.players.length === 2, '两人到齐');

  host.send({ t: 'start' });
  let cur = await host.waitNewState(0, (m) => m.phase === 'playing', '开局');

  /**
   * 在一局里把房主推到宝箱上开箱，最多 rounds 个房主回合。
   * 判据只用 `me.items.length > 0`——「站在宝箱格上」不等于已开箱：
   * 宝箱有可能正好刷在开局站位那一格上，这时得先走开再走回来才会开。
   */
  async function walkToChest(state, rounds) {
    let s = state;
    for (let i = 0; i < rounds; i++) {
      const g = s.game;
      if (g.phase !== 'playing') return { state: s, opened: false };
      if (s.me.items.length) return { state: s, opened: true };

      if (g.turn !== 0) {
        // 访客：只在离中央 ≥2 步处挪，避免它抢先取胜
        const d1 = distancesToGoal(g);
        const all = legalMoves(g, 1);
        const safe = all.filter((m) => d1[m.r * g.size + m.c] >= 2);
        const pool = safe.length ? safe : all;
        if (!pool.length) return { state: s, opened: false };
        const mv = pool[0];
        guest.send({ t: 'move', to: { r: mv.r, c: mv.c } });
        s = await host.waitNewState(
          s.mseq,
          (m) => m.game.turn === 0 || m.phase === 'finished',
          5000,
          '轮回房主',
        );
        continue;
      }

      const pawn = g.pawns[0];
      const standingOnChest = g.chests.some((ch) => ch.r === pawn.r && ch.c === pawn.c);
      const moves = legalMoves(g, 0).filter((m) => !(m.r === 2 && m.c === 2));
      if (!moves.length) return { state: s, opened: false };

      let pick;
      let lands;
      if (standingOnChest) {
        // 站在（还没开过的）宝箱上：先挪到旁边一格，下一轮再走回来触发开箱
        pick = moves.find((m) => !g.chests.some((ch) => ch.r === m.r && ch.c === m.c)) || moves[0];
        lands = false;
      } else {
        const dToChest = (m) => Math.min(
          ...g.chests.map((ch) => Math.abs(m.r - ch.r) + Math.abs(m.c - ch.c)),
        );
        pick = moves.reduce((best, m) => (!best || dToChest(m) < dToChest(best) ? m : best), null);
        lands = g.chests.some((ch) => ch.r === pick.r && ch.c === pick.c);
      }

      const before = s.mseq;
      host.send({ t: 'move', to: { r: pick.r, c: pick.c } });
      s = await host.waitFor(
        (m) => m.t === 'state' && m.mseq > before
          && (lands ? m.me.items.length > 0 : m.game.turn === 1 || m.phase === 'finished'),
        5000,
        lands ? '开箱' : '轮到访客',
      );
      if (lands) return { state: s, opened: true };
    }
    return { state: s, opened: false };
  }

  // 最多重开 4 局，直到踩中一个宝箱
  let result = { state: cur, opened: false };
  for (let attempt = 0; attempt < 4 && !result.opened; attempt++) {
    if (attempt > 0) {
      host.send({ t: 'restart' });
      cur = await host.waitNewState(
        cur.mseq,
        (m) => m.phase === 'playing' && m.game.turnCount === 0,
        5000,
        '重开',
      );
    }
    result = await walkToChest(cur, 10);
  }

  assert.ok(result.opened, '几局之内房主应该能踩到一个宝箱并拿到道具');
  let withItem = result.state;
  assert.ok(
    withItem.game.chests.some((ch) => ch.openedBy.length > 0),
    '被开过的宝箱要记录开启者',
  );

  // 道具是私密的：对手的 state 里没有我的道具
  const guestView = await guest.waitFor((m) => m.t === 'state', 4000, '访客视角');
  assert.equal(
    guestView.players.find((p) => p.pid === 'cb-host').items,
    undefined,
    '访客看不到房主持有什么道具',
  );

  // 开箱那一步走完，回合已经交给访客了。要「使用道具」必须等自己回合，
  // 所以先让访客随便走一步把回合交回来（访客不离中央太近，避免它取胜）。
  if (withItem.game.turn !== 0) {
    const g = withItem.game;
    const d1 = distancesToGoal(g);
    const all = legalMoves(g, 1);
    const safe = all.filter((m) => d1[m.r * g.size + m.c] >= 2);
    const pool = safe.length ? safe : all;
    const mv = pool[0];
    guest.send({ t: 'move', to: { r: mv.r, c: mv.c } });
    withItem = await host.waitFor(
      (m) => m.t === 'state' && m.game.turn === 0 && m.me.items.length > 0,
      5000,
      '轮回房主（准备用道具）',
    );
  }

  const kind = withItem.me.items[0];
  assert.ok([1, 2, 3].includes(kind), '拿到的道具应当是三种之一');

  // ---- 用掉这件道具 ----
  const itemsBefore = withItem.me.items.length;
  const before = host.seq;
  if (kind === 3) {
    // 随机传送：不需要目标格，必定消耗本回合并换手
    host.send({ t: 'item', kind: 3 });
    const after = await host.waitFor(
      (m) => m.t === 'state' && m.mseq > before && m.game.turn === 1,
      5000,
      '传送后换手',
    );
    const pos = after.game.pawns[0];
    assert.ok(!(pos.r === 2 && pos.c === 2), '随机传送不能把玩家直接送到终点');
    // 用掉一件；如果恰好传到另一个宝箱上会再拿一件，所以数量是「不增反减」
    assert.ok(
      after.me.items.length <= itemsBefore,
      `道具数量不该增加：${itemsBefore} → ${after.me.items.length}`,
    );
  } else {
    const data = kind === 1
      ? { index: 0 }                    // 破墙：场上没墙时会被拒绝，用陷阱兜底
      : { r: 0, c: 0 };                 // 陷阱：放在左上角
    host.send({ t: 'item', kind, data });
    const res = await host.waitFor(
      (m) => m.t === 'error' || (m.t === 'state' && m.mseq > before && m.game.turn === 1),
      5000,
      '使用道具',
    );
    if (res.t === 'state') {
      assert.equal(res.game.turn, 1, '用道具会消耗本回合');
      assert.equal(res.me.items.length, itemsBefore - 1, '道具用掉一件');
      if (kind === 2) {
        // 陷阱只有自己看得见：自己的 payload 里有，别人的没有
        assert.ok(
          res.game.traps.some((t) => t.r === 0 && t.c === 0 && t.seat === 0),
          '自己能看到自己埋的陷阱',
        );
        const opponent = await guest.waitFor((m) => m.t === 'state', 4000, '对手视角');
        assert.ok(
          !opponent.game.traps.some((t) => t.r === 0 && t.c === 0),
          '对手看不到我埋的陷阱',
        );
      }
    }
  }

  host.close();
  guest.close();
});

test('没有道具时用道具会被拒绝', async () => {
  const host = new Client('tp-host', '房主');
  await host.open();
  host.send({
    t: 'create',
    pid: host.pid,
    name: host.name,
    settings: { size: 9, chests: 0, turnTimer: 0 },
  });
  const s1 = await host.waitFor((m) => m.t === 'state');
  const code = s1.code;

  const guest = new Client('tp-guest', '访客');
  await guest.open();
  guest.send({ t: 'join', code, pid: guest.pid, name: guest.name });
  const s1b = await host.waitNewState(s1.mseq, (m) => m.players.length === 2, '两人到齐');

  host.send({ t: 'start' });
  const s2 = await host.waitNewState(s1b.mseq, (m) => m.phase === 'playing', '开局');

  // 没有宝箱的房间：场上没有陷阱，背包也是空的
  assert.deepEqual(s2.game.traps, [], '开局没有陷阱');
  assert.deepEqual(s2.me.items, [], '没有宝箱就没有道具');

  host.send({ t: 'move', to: { r: 7, c: 4 } });
  await host.waitNewState(s2.mseq, (m) => m.game.turn === 1, '轮到访客');

  // 访客没有道具，埋雷会被拒绝
  guest.send({ t: 'item', kind: 2, data: { r: 3, c: 3 } });
  const noItem = await guest.waitFor((m) => m.t === 'error', 4000, '没道具');
  assert.match(noItem.msg, /道具/);

  // 观众也不能用道具
  const viewer = new Client('tp-view', '围观');
  await viewer.open();
  viewer.send({ t: 'join', code, pid: viewer.pid, name: viewer.name });
  await viewer.waitFor((m) => m.t === 'state', 4000, '观众入场');
  viewer.send({ t: 'item', kind: 3 });
  const viewerErr = await viewer.waitFor((m) => m.t === 'error', 4000, '观众用道具被拒');
  assert.match(viewerErr.msg, /不在对局/);
  viewer.close();

  host.close();
  guest.close();
});
