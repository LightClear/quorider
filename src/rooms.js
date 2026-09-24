/**
 * 房间与对局管理：邀请码、座位、房主控制、回合限时、断线重连。
 * 只依赖 engine.js 的纯函数，便于测试。
 */
import {
  createGame,
  applyMove,
  applyWall,
  applyPlaceTrap,
  removeWall,
  randomTeleportCell,
  settleAfterArrival,
  skipTurn,
  pickAutoAction,
  normalizeSettings,
  normalizeChestItems,
  reasonText,
  goalCells,
  ITEM_KIND,
  ITEM_KIND_BY_KEY,
  ITEM_META,
} from './engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_LOG = 40;
const MAX_DANMAKU = 30;      // 房间保留的弹幕条数
const DANMAKU_COOLDOWN = 1000;
const DANMAKU_MAX_LEN = 40;
const REACTION_COOLDOWN = 1500;
const REACTION_KINDS = ['poop', 'bomb', 'heart', 'rose', 'coffee'];

export const ROOM_TTL_EMPTY = 30 * 60 * 1000; // 全员掉线后保留 30 分钟，方便回连
export { REACTION_KINDS };

export function randomCode(taken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!taken.has(code)) return code;
  }
}

export function sanitizeName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return s.slice(0, 12) || '玩家';
}

const now = () => Date.now();

/** 弹幕单条最长字数。 */
export function sanitizeDanmaku(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, DANMAKU_MAX_LEN);
}

export class Room {
  constructor(code, settings, host) {
    this.code = code;
    this.settings = normalizeSettings(settings);
    this.createdAt = now();
    this.updatedAt = now();
    this.emptySince = null;
    this.hostPid = host.pid;
    this.game = null;
    this.deadline = null;
    this.winnerPid = null;
    this.log = [];
    this.danmaku = [];
    /** 弹幕序号计数器：每条弹幕带一个单调递增的 seq，客户端据此去重/跳过历史。 */
    this.danmakuSeq = 0;
    // pid -> { pid, name, conn, spectator, joinedAt }
    this.players = new Map();
    /**
     * 私有状态：pid -> { items:[kind], lastDanmakuAt, lastReactionAt,
     *                   reactionSent: {targetPid: at} }
     * 道具背包只发给本人，其它玩家在广播里永远看不到（见 publicStateFor）。
     */
    this.private = new Map();
    this.players.set(host.pid, host);
    this._pushLog(`${host.name} 创建了房间`);
  }

  get phase() {
    return this.game ? this.game.phase : 'lobby';
  }

  /** 取（必要时创建）某个玩家的私有状态。 */
  priv(pid) {
    let p = this.private.get(pid);
    if (!p) {
      p = { items: [], lastDanmakuAt: 0, lastReactionAt: 0, reactionSent: {} };
      this.private.set(pid, p);
    }
    return p;
  }

  /** 结算时给玩家发一件道具；道具栏满了返回 null。 */
  grantItem(pid, kind) {
    const p = this.priv(pid);
    const slots = this.game?.itemSlots ?? this.settings.itemSlots;
    if (p.items.length >= slots) return null;
    p.items.push(kind);
    return p.items.length;
  }

  /** 找出某个座位对应的私有状态。 */
  privOfSeat(seat) {
    const id = this.game?.seats?.[seat]?.id;
    return id ? this.priv(id) : null;
  }

  _pushLog(text) {
    this.log.push({ at: now(), text });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /** 按加入顺序排列的参赛者。 */
  contenders() {
    return [...this.players.values()].filter((p) => !p.spectator);
  }

  connectedCount() {
    return [...this.players.values()].filter((p) => p.conn?.ready).length;
  }

  touch() {
    this.updatedAt = now();
    if (this.connectedCount() > 0) this.emptySince = null;
    else if (!this.emptySince) this.emptySince = now();
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom({ pid, name, settings }) {
    const code = randomCode(this.rooms);
    const room = new Room(code, settings, { pid, name, conn: null });
    this.rooms.set(code, room);
    return room;
  }

  findRoom(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim()) || null;
  }

  /**
   * 加入 / 重连。返回 { room, player, error }。
   * - 已在房间里 → 重连（保留座位）
   * - 房间在大厅且有空位 → 直接入座
   * - 其余情况 → 以观众身份进入
   */
  joinRoom({ code, pid, name }) {
    const room = this.findRoom(code);
    if (!room) return { error: '房间不存在或已被解散' };

    const existing = room.players.get(pid);
    if (existing) {
      existing.name = name || existing.name;
      // 之前因为「对局进行中」被放到观众席的人，如果现在本局已经结束、
      // 而且座位还坐得下，就顺手放回玩家席——否则他会一直卡在观众席上，
      // 房主重开时又被漏掉（和 6.4 是同一类问题，只是走的重连路径）。
      if (existing.spectator && this._canSit(room)) {
        existing.spectator = false;
        room._pushLog(`${existing.name} 回到了玩家席`);
      }
      if (!existing.conn) room._pushLog(`${existing.name} 回到了房间`);
      return { room, player: existing, reconnected: true };
    }

    const canPlay = this._canSit(room);
    const player = { pid, name, conn: null, spectator: !canPlay };
    room.players.set(pid, player);
    room._pushLog(
      canPlay
        ? `${player.name} 加入了房间`
        : room.game && room.game.phase === 'playing'
          ? `${player.name} 以观众身份进入（对局进行中）`
          : `${player.name} 以观众身份进入（房间已满）`,
    );
    return { room, player };
  }

  /**
   * 新来的人能不能直接坐进玩家席。
   *
   * 关键点：**只要「本局还没开始」就可以入座**——不只是大厅（game === null），
   * 也包括「上一局已经打完、房主还没开下一局」这个状态（game.phase === 'finished'）。
   * 否则一局结束后进房间的朋友会被判成观众，而房主快速重开时用的是
   * contenders()（只算非观众），他就会被静默排除在下一局之外。
   */
  _canSit(room) {
    const playing = room.game && room.game.phase === 'playing';
    if (playing) return false;
    return room.contenders().length < room.settings.maxPlayers;
  }

  leaveRoom(room, pid, { deliberate }) {
    const player = room.players.get(pid);
    if (!player) return;
    room.players.delete(pid);
    if (deliberate) {
      room._pushLog(`${player.name} 离开了房间`);
      if (room.hostPid === pid) {
        const next = room.contenders().find((p) => p.conn?.ready) || room.contenders()[0];
        if (next) {
          room.hostPid = next.pid;
          room._pushLog(`${next.name} 成为新房主`);
        }
      }
    } else if (room.game) {
      // 对局中掉线：保留座位等待重连
      room.players.set(pid, { ...player, conn: null });
      const seat = room.game.seats.findIndex((s) => s.id === pid);
      if (seat >= 0) {
        room.game.seats[seat].connected = false;
        room._pushLog(`${player.name} 掉线了`);
      }
    }
    if (room.players.size === 0) this.rooms.delete(room.code);
  }

  updateSettings(room, pid, settings) {
    if (pid !== room.hostPid) return { error: '只有房主可以修改设置' };
    if (room.game && room.game.phase === 'playing') {
      return { error: '对局进行中，结束后再改设置' };
    }
    const next = normalizeSettings(settings);
    if (room.game) {
      // 结束后的修改会在重开时生效
      room.settings = next;
      return { ok: true };
    }
    // 大厅里改棋盘大小会重排预览；座位超出新人数上限时观众化
    const contenders = room.contenders();
    if (contenders.length > next.maxPlayers) {
      for (const p of contenders.slice(next.maxPlayers)) {
        p.spectator = true;
        room._pushLog(`${p.name} 被移到观众席（房间人数上限调整）`);
      }
    }
    room.settings = next;
    return { ok: true };
  }

  startGame(room, pid) {
    if (pid !== room.hostPid) return { error: '只有房主可以开始游戏' };
    if (room.game && room.game.phase === 'playing') return { error: '对局已经在进行中' };
    const contenders = room.contenders();
    if (contenders.length < 2) return { error: '至少需要 2 名玩家才能开始' };
    if (contenders.length > room.settings.maxPlayers) {
      return { error: `房间人数上限为 ${room.settings.maxPlayers}` };
    }
    room.game = createGame(
      room.settings,
      contenders.map((p) => ({ id: p.pid, name: p.name })),
    );
    room.winnerPid = null;
    room.danmaku = [];
    this._resetItems(room);
    room._pushLog('对局开始，率先抵达中央方块者获胜');
    if (room.game.chests.length) {
      room._pushLog(`场上出现了 ${room.game.chests.length} 个宝箱`);
    }
    this._armTimer(room);
    return { ok: true };
  }

  /** 房主快速重开：同一批人、当前设置，直接开新局。 */
  restart(room, pid) {
    if (pid !== room.hostPid) return { error: '只有房主可以重开对局' };
    if (!room.game) return { error: '还没有开始过对局' };
    const contenders = room.contenders();
    if (contenders.length < 2) return { error: '至少需要 2 名玩家才能开始' };
    room.game = createGame(
      room.settings,
      contenders.map((p) => ({ id: p.pid, name: p.name })),
    );
    room.winnerPid = null;
    room.danmaku = [];
    this._resetItems(room);
    room._pushLog('房主重开了对局');
    this._armTimer(room);
    return { ok: true };
  }

  /** 开新局时清空所有人的道具背包。 */
  _resetItems(room) {
    for (const p of room.players.values()) {
      const priv = room.priv(p.pid);
      priv.items = [];
      priv.reactionSent = {};
    }
  }

  move(room, pid, to) {
    const seat = this._seatOf(room, pid);
    if (seat < 0) return { error: '你不在对局中' };
    const g = room.game;
    if (g.phase !== 'playing') return { error: reasonOf('not-playing') };
    if (g.turn !== seat) return { error: reasonOf('not-turn') };
    const res = applyMove(g, seat, Number(to?.r), Number(to?.c));
    if (!res.ok) return { error: reasonOf(res.reason) };
    const name = g.seats[seat].name;
    room._pushLog(`${name} 移动到 (${to.r}, ${to.c})`);
    this._afterAction(room, seat, res);
    return { ok: true };
  }

  placeWall(room, pid, wall) {
    const seat = this._seatOf(room, pid);
    if (seat < 0) return { error: '你不在对局中' };
    const res = applyWall(room.game, seat, wall?.d === 'v' ? 'v' : 'h', Number(wall?.r), Number(wall?.c));
    if (!res.ok) return { error: reasonOf(res.reason) };
    const name = room.game.seats[seat].name;
    room._pushLog(`${name} 放置了一面路障`);
    this._armTimer(room);
    return { ok: true };
  }

  /**
   * 使用一件道具。三种道具都会消耗本回合（用完后换手）。
   * data 里的坐标语义：
   *   break  → { index }  要破坏的路障在 game.walls 中的下标
   *   trap   → { r, c }   陷阱落点
   *   teleport 无参数     落点由服务器随机决定
   */
  useItem(room, pid, kindRaw, data = {}) {
    const seat = this._seatOf(room, pid);
    if (seat < 0) return { error: '你不在对局中' };
    const g = room.game;
    if (g.phase !== 'playing') return { error: reasonOf('not-playing') };
    if (g.turn !== seat) return { error: reasonOf('not-turn') };

    const kind = Number(kindRaw);
    const meta = ITEM_META.find((m) => m.kind === kind);
    if (!meta) return { error: reasonOf('bad-item') };

    const priv = room.priv(pid);
    const slot = priv.items.indexOf(kind);
    if (slot < 0) return { error: reasonOf('no-item') };

    const name = g.seats[seat].name;
    let extra = null;

    if (kind === ITEM_KIND.BREAK) {
      const res = removeWall(g, seat, Math.round(Number(data.index)));
      if (!res.ok) return { error: reasonOf(res.reason) };
      room._pushLog(`${name} 用破墙锤砸掉了对手的一面路障`);
      extra = { effect: 'break', wall: res.removed, by: seat };
    } else if (kind === ITEM_KIND.TRAP) {
      const res = applyPlaceTrap(g, seat, data.r, data.c);
      if (!res.ok) return { error: reasonOf(res.reason) };
      // 陷阱位置不写进文字日志（日志是公开的），避免暴露埋在哪儿
      room._pushLog(`${name} 悄悄埋下了一个陷阱`);
      extra = { effect: 'trap-placed', by: seat };
    } else {
      const cell = randomTeleportCell(g, seat);
      if (!cell) return { error: reasonOf('out-of-board') };
      const pawn = g.pawns[seat];
      const from = { r: pawn.r, c: pawn.c };
      pawn.r = cell.r;
      pawn.c = cell.c;
      g.lastMove = { type: 'item', seat, from, to: { r: cell.r, c: cell.c } };
      room._pushLog(`${name} 被随机传送走了`);
      // 传送同样可能落在宝箱/陷阱格上，走和走子一样的结算流程
      const settle = settleAfterArrival(g, seat, cell.r, cell.c, 'teleport');
      extra = {
        effect: 'teleport',
        by: seat,
        from,
        to: { r: cell.r, c: cell.c },
        opened: settle.opened,
        trapped: settle.trapped,
      };
    }

    priv.items.splice(slot, 1);
    if (extra && extra.opened) this._grantChestItem(room, seat, extra.opened);
    if (extra?.trapped) this._announceTrap(room, seat, extra.trapped);

    if (extra?.effect !== 'teleport') {
      // 破墙/陷阱：本回合到此为止，直接换手
      g.turnCount++;
      advanceTurnOf(g);
      this._armTimer(room);
    } else {
      this._afterAction(room, seat, { opened: extra.opened, trapped: extra.trapped });
    }
    return { ok: true, extra };
  }

  /** 结算一次走子/传送之后的公共部分：开箱、陷阱、胜负、倒计时。 */
  _afterAction(room, seat, res) {
    const g = room.game;
    const name = g.seats[seat].name;
    if (res?.opened) this._grantChestItem(room, seat, res.opened);
    if (res?.trapped) this._announceTrap(room, seat, res.trapped);

    if (g.phase === 'finished') {
      room.winnerPid = g.seats[g.winner].id;
      room._pushLog(`${name} 触碰到中央方块，获得胜利！`);
      room.deadline = null;
      // 一局结束、还没开下一局：把等在观众席上的人放回玩家席，
      // 这样房主「快速重开」时他们才会被算进 contenders()。
      this._promoteWaitingSpectators(room);
    } else {
      this._armTimer(room);
    }
  }

  /**
   * 本局结束后，把观众席上还坐得下的人提升为玩家。
   * 对局中进来的人当时只能当观众（这是对的），但一局结束后房间就回到
   * 「可以入座」的状态，这时再让他们干等着看下一局就说不过去了。
   */
  _promoteWaitingSpectators(room) {
    for (const p of room.players.values()) {
      if (!p.spectator) continue;
      if (room.contenders().length >= room.settings.maxPlayers) break;
      p.spectator = false;
      room._pushLog(`${p.name} 回到了玩家席，可以参加下一局`);
    }
  }

  /**
   * 开箱发道具。注意：别人只会看到「某某打开了宝箱」，
   * 具体开出什么只发给本人（这就是「玩家之间无法看到彼此持有的道具」）。
   */
  _grantChestItem(room, seat, opened) {
    const g = room.game;
    const pid = g.seats[seat].id;
    const pool = g.chestPool?.length ? g.chestPool : ['teleport', 'break', 'trap'];
    const key = pool[Math.floor(Math.random() * pool.length)];
    const kind = ITEM_KIND_BY_KEY[key];
    const name = g.seats[seat].name;
    const nth = room.grantItem(pid, kind);

    if (nth === null) {
      room._pushLog(`${name} 打开了宝箱，但道具已满`);
      this.sendTo(room, pid, { toast: '你的道具已满，先使用一件再来开箱', toastKind: 'err' });
      return;
    }
    const meta = ITEM_META.find((m) => m.kind === kind);
    room._pushLog(`${name} 打开了一个宝箱`);
    // 只有本人知道开出了什么
    this.sendTo(room, pid, {
      toast: `获得道具：${meta.icon} ${meta.name}`,
      toastKind: 'ok',
      itemGained: { kind, chestId: opened.chestId },
    });
  }

  /** 踩中陷阱：全场播报，被炸的人下一回合直接跳过。 */
  _announceTrap(room, seat, trap) {
    const g = room.game;
    const victim = g.seats[seat]?.name || '玩家';
    const owner = g.seats[trap.owner]?.name;
    room._pushLog(`💥 ${victim} 踩中了陷阱${owner ? `（${owner} 埋的）` : ''}，下一回合无法行动！`);
    room.danmaku.push({
      seq: ++room.danmakuSeq,
      at: now(),
      pid: null,
      name: '系统',
      text: `💥 ${victim} 踩中了陷阱，下一回合被跳过！`,
      color: '#ff3d6e',
      system: true,
    });
    this._trimDanmaku(room);
    room.pendingToast = { text: `💥 ${victim} 踩中陷阱，下一回合被跳过！`, kind: 'warn' };
  }

  _trimDanmaku(room) {
    if (room.danmaku.length > MAX_DANMAKU) {
      room.danmaku.splice(0, room.danmaku.length - MAX_DANMAKU);
    }
  }

  /** 弹幕：每 1 秒最多 1 条，最长 40 字，颜色取发送者的座位色。 */
  danmaku(room, pid, text) {
    const player = room.players.get(pid);
    if (!player) return { error: '你不在房间里' };
    const body = sanitizeDanmaku(text);
    if (!body) return { error: '弹幕内容不能为空' };

    const priv = room.priv(pid);
    const t = now();
    if (t - priv.lastDanmakuAt < DANMAKU_COOLDOWN) {
      const wait = Math.ceil((DANMAKU_COOLDOWN - (t - priv.lastDanmakuAt)) / 1000);
      return { error: `发得太快了，请等 ${wait} 秒` };
    }
    priv.lastDanmakuAt = t;

    const seat = this._seatOf(room, pid);
    const color = colorOfSeat(room, seat);
    // seq 是房间内单调递增的序号：客户端靠它区分「历史记录」和「刚发的新弹幕」，
    // 既不会刷新页面时把旧弹幕重放一遍，也不会把同一条播两次
    // （实时帧 t:'danmaku' 和后续 state 里的历史都带着同一条）。
    room.danmaku.push({ seq: ++room.danmakuSeq, at: t, pid, name: player.name, text: body, color });
    this._trimDanmaku(room);
    return { ok: true, entry: room.danmaku[room.danmaku.length - 1] };
  }

  /**
   * 头像互动。有 CD（全局 1.5s + 对同一人 2s），
   * 发送方与被发送方都会收到一次特效事件。
   */
  react(room, pid, targetPid, kind) {
    const from = room.players.get(pid);
    const to = room.players.get(targetPid);
    if (!from) return { error: '你不在房间里' };
    if (!to) return { error: '对方不在房间里' };
    if (!REACTION_KINDS.includes(kind)) return { error: '不支持这种互动' };
    if (pid === targetPid) return { error: '不能对自己做这个' };

    const priv = room.priv(pid);
    const t = now();
    if (t - priv.lastReactionAt < REACTION_COOLDOWN) {
      return { error: '互动冷却中，稍等一下' };
    }
    const lastTo = priv.reactionSent[targetPid] || 0;
    if (t - lastTo < REACTION_COOLDOWN) {
      return { error: `对 ${to.name} 的互动还在冷却` };
    }
    priv.lastReactionAt = t;
    priv.reactionSent[targetPid] = t;

    const event = {
      from: pid,
      fromName: from.name,
      to: targetPid,
      toName: to.name,
      kind,
    };
    this.sendTo(room, targetPid, { reaction: { ...event, mine: false } });
    this.sendTo(room, pid, { reaction: { ...event, mine: true } });
    return { ok: true, event };
  }

  kick(room, hostPid, targetPid) {
    if (hostPid !== room.hostPid) return { error: '只有房主可以移出玩家' };
    if (room.game) return { error: '对局中无法移出玩家' };
    if (targetPid === hostPid) return { error: '不能移出自己' };
    const target = room.players.get(targetPid);
    if (!target) return { error: '玩家不在房间里' };
    this.leaveRoom(room, targetPid, { deliberate: true });
    return { ok: true, kicked: target };
  }

  /** 被移出的玩家会收到一条提示再断开。 */
  _seatOf(room, pid) {
    if (!room.game) return -1;
    return room.game.seats.findIndex((s) => s.id === pid);
  }

  _armTimer(room) {
    room.deadline =
      room.settings.turnTimer > 0 ? now() + room.settings.turnTimer * 1000 : null;
  }

  /** 每秒调用：处理超时托管与「陷阱跳过回合」。返回 true 表示状态有变化需要广播。 */
  tick(room) {
    if (!room.game || room.game.phase !== 'playing' || !room.deadline) {
      return this._maybeAutoResolveTrap(room);
    }
    const g = room.game;
    const seatInfo = g.seats[g.turn];
    const seatPlayer = seatInfo ? room.players.get(seatInfo.id) : null;
    // 当前玩家掉线时暂停倒计时，等他回来
    if (!seatPlayer?.conn?.ready) {
      room.deadline = now() + 1000;
      return false;
    }
    if (now() < room.deadline) return false;

    const auto = pickAutoAction(g, g.turn);
    if (!auto) {
      this._armTimer(room);
      return true;
    }
    const name = seatInfo.name;
    const seat = g.turn;
    if (auto.type === 'skip') {
      // 踩了陷阱：托管也救不了，直接跳过这一回合
      skipTurn(g, seat);
      room._pushLog(`${name} 被陷阱困住，本回合跳过`);
      this._armTimer(room);
      return true;
    }
    const res = applyMove(g, seat, auto.r, auto.c);
    room._pushLog(`${name} 超时，托管代走一步`);
    if (g.phase === 'finished') {
      room.winnerPid = g.seats[g.winner].id;
      room._pushLog(`${name} 触碰到中央方块，获得胜利！`);
      room.deadline = null;
      this._promoteWaitingSpectators(room);
    } else {
      if (res.opened) this._grantChestItem(room, seat, res.opened);
      if (res.trapped) this._announceTrap(room, seat, res.trapped);
      this._armTimer(room);
    }
    return true;
  }

  /**
   * 没有倒计时（不限时）时，被陷阱困住的玩家没人替他跳过，会一直卡住。
   * 这里兜底：只要当前玩家处于跳过状态且没有倒计时，就直接替他跳过。
   */
  _maybeAutoResolveTrap(room) {
    const g = room.game;
    if (!g || g.phase !== 'playing' || room.deadline) return false;
    const st = g.seatState?.[g.turn];
    if (!st || !(st.skipTurns > 0)) return false;
    const name = g.seats[g.turn]?.name || '玩家';
    skipTurn(g, g.turn);
    room._pushLog(`${name} 被陷阱困住，本回合跳过`);
    this._armTimer(room);
    return true;
  }

  /** 回收空房间。 */
  sweep() {
    for (const [code, room] of this.rooms) {
      room.touch();
      if (room.connectedCount() === 0 && (room.emptySince ?? Infinity) + ROOM_TTL_EMPTY < now()) {
        this.rooms.delete(code);
      }
    }
  }

  /**
   * 广播给房间里的所有人。
   * 因为「道具」与「陷阱位置」是私密信息，这里必须逐人构造状态——
   * 每个人的 payload 里只包含他自己能看到的那一份。
   */
  broadcast(room, extra = {}) {
    for (const p of room.players.values()) {
      if (!p.conn?.ready) continue;
      try {
        p.conn.send({ t: 'state', ...this.publicStateFor(room, p.pid), ...extra });
      } catch {
        p.conn.destroy();
      }
    }
  }

  /** 单独发给一个玩家。 */
  sendTo(room, pid, extra = {}) {
    const p = room.players.get(pid);
    if (!p?.conn?.ready) return;
    try {
      p.conn.send({ t: 'state', ...this.publicStateFor(room, pid), ...extra });
    } catch {
      p.conn.destroy();
    }
  }

  /**
   * 传给某个玩家的状态。
   *
   * 隐私口径（需求原文：玩家之间无法看到其他玩家所获得或持有的道具）：
   *   - `me.items`    只包含自己的道具背包
   *   - `game.traps`  只包含「自己埋的」陷阱，别人的陷阱在 payload 里根本不存在
   *   - 座位上的 `items` 字段被整体剥掉，别人连数量都看不到
   */
  publicStateFor(room, pid) {
    const base = this.publicState(room);
    const seat = this._seatOf(room, pid);
    const priv = room.priv(pid);

    let game = base.game;
    if (game) {
      game = {
        ...game,
        // 别人的陷阱直接不出现——不是标记为隐藏，而是根本不发
        traps: (game.traps || []).filter((t) => t.seat === seat),
        // 宝箱上「谁开过」对非一次性模式属于公开信息，保留；
        // 一次性模式下箱子一旦被开过就消失（见前端渲染）
        chests: game.chests || [],
      };
    }

    return {
      ...base,
      game,
      mySeat: seat,
      me: {
        items: seat >= 0 ? [...priv.items] : [],
        itemSlots: room.game?.itemSlots ?? room.settings.itemSlots,
        skipped: seat >= 0 ? (room.game?.seatState?.[seat]?.skipTurns || 0) > 0 : false,
      },
    };
  }

  /** 传给前端的状态（与玩家无关的公共部分）。game 内部已全是可序列化的纯数据。 */
  publicState(room) {
    const players = [...room.players.values()].map((p) => ({
      pid: p.pid,
      name: p.name,
      spectator: !!p.spectator,
      connected: !!p.conn?.ready,
      host: p.pid === room.hostPid,
    }));
    // 座位信息在 game.seats 里，这里给出 pid -> seat 的映射，方便前端高亮自己
    const seatByPid = {};
    if (room.game) {
      room.game.seats.forEach((s, i) => {
        seatByPid[s.id] = i;
      });
    }
    // 座位上的道具数量也是隐私：先剥掉，再由 publicStateFor 只补回自己的
    let game = room.game;
    if (game) {
      game = {
        ...game,
        seats: game.seats.map((s) => ({ ...s })),
      };
    }
    return {
      code: room.code,
      hostPid: room.hostPid,
      phase: room.phase,
      settings: room.settings,
      players,
      seatByPid,
      game,
      winnerPid: room.winnerPid,
      deadline: room.deadline,
      serverNow: now(),
      danmaku: room.danmaku.slice(-MAX_DANMAKU),
      log: room.log.slice(-12),
    };
  }
}

/** 座位对应的颜色，用于弹幕着色。 */
function colorOfSeat(room, seat) {
  if (seat >= 0 && room.game?.seats?.[seat]) return room.game.seats[seat].color;
  return '#8a8a97';
}

/** 换手（与 engine 内部同一套「跳过空座位」规则）。 */
function advanceTurnOf(g) {
  const n = g.seats.length;
  for (let i = 1; i <= n; i++) {
    const next = (g.turn + i) % n;
    if (g.pawns[next]) {
      g.turn = next;
      return;
    }
  }
}

function reasonOf(code) {
  return reasonText(code);
}
