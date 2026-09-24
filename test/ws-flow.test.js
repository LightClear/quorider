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