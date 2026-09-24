/**
 * 房间与对局管理：邀请码、座位、房主控制、回合限时、断线重连。
 * 只依赖 engine.js 的纯函数，便于测试。
 */
import {
  createGame,
  applyMove,
  applyWall,
  pickAutoMove,
  normalizeSettings,
  reasonText,
} from './engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_LOG = 40;

export const ROOM_TTL_EMPTY = 30 * 60 * 1000; // 全员掉线后保留 30 分钟，方便回连

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
    // pid -> { pid, name, conn, spectator, joinedAt }
    this.players = new Map();
    this.players.set(host.pid, host);
    this._pushLog(`${host.name} 创建了房间`);
  }

  get phase() {
    return this.game ? this.game.phase : 'lobby';
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
      if (!existing.conn) room._pushLog(`${existing.name} 回到了房间`);
      return { room, player: existing, reconnected: true };
    }

    const inLobby = !room.game;
    const seatsUsed = room.contenders().length;
    const canPlay = inLobby && seatsUsed < room.settings.maxPlayers;

    const player = { pid, name, conn: null, spectator: !canPlay };
    room.players.set(pid, player);
    room._pushLog(
      canPlay
        ? `${player.name} 加入了房间`
        : `${player.name} 以观众身份进入（对局进行中）`,
    );
    return { room, player };
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
    room._pushLog('对局开始，率先抵达中央方块者获胜');
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
    room._pushLog('房主重开了对局');
    this._armTimer(room);
    return { ok: true };
  }

  move(room, pid, to) {
    const seat = this._seatOf(room, pid);
    if (seat < 0) return { error: '你不在对局中' };
    const res = applyMove(room.game, seat, Number(to?.r), Number(to?.c));
    if (!res.ok) return { error: reasonOf(res.reason) };
    const name = room.game.seats[seat].name;
    room._pushLog(`${name} 移动到 (${to.r}, ${to.c})`);
    if (room.game.phase === 'finished') {
      room.winnerPid = room.game.seats[room.game.winner].id;
      room._pushLog(`${name} 触碰到中央方块，获得胜利！`);
    } else {
      this._armTimer(room);
    }
    return { ok: true };
  }

  placeWall(room, pid, wall) {
    const seat = this._seatOf(room, pid);
    if (seat < 0) return { error: '你不在对局中' };
    const d = wall?.d === 'v' ? 'v' : 'h';
    const res = applyWall(room.game, seat, d, Number(wall?.r), Number(wall?.c));
    if (!res.ok) return { error: reasonOf(res.reason) };
    const name = room.game.seats[seat].name;
    room._pushLog(`${name} 放置了一面路障`);
    this._armTimer(room);
    return { ok: true };
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

  /** 每秒调用：处理超时托管。返回 true 表示状态有变化需要广播。 */
  tick(room) {
    if (!room.game || room.game.phase !== 'playing' || !room.deadline) return false;
    const g = room.game;
    const seatInfo = g.seats[g.turn];
    const seatPlayer = seatInfo ? room.players.get(seatInfo.id) : null;
    // 当前玩家掉线时暂停倒计时，等他回来
    if (!seatPlayer?.conn?.ready) {
      room.deadline = now() + 1000;
      return false;
    }
    if (now() < room.deadline) return false;

    const auto = pickAutoMove(g, g.turn);
    if (!auto) {
      this._armTimer(room);
      return true;
    }
    const name = seatInfo.name;
    applyMove(g, g.turn, auto.r, auto.c);
    room._pushLog(`${name} 超时，托管代走一步`);
    if (g.phase === 'finished') {
      room.winnerPid = g.seats[g.winner].id;
      room._pushLog(`${name} 触碰到中央方块，获得胜利！`);
    } else {
      this._armTimer(room);
    }
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

  /** 广播给房间里的所有人。 */
  broadcast(room, extra = {}) {
    const state = this.publicState(room);
    const payload = { t: 'state', ...state, ...extra };
    for (const p of room.players.values()) {
      if (p.conn?.ready) {
        try {
          p.conn.send(payload);
        } catch {
          p.conn.destroy();
        }
      }
    }
  }

  /** 单独发给一个玩家。 */
  sendTo(room, pid, extra = {}) {
    const p = room.players.get(pid);
    if (!p?.conn?.ready) return;
    try {
      p.conn.send({ t: 'state', ...this.publicState(room), ...extra });
    } catch {
      p.conn.destroy();
    }
  }

  /** 传给前端的状态。game 内部已全是可序列化的纯数据。 */
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
    return {
      code: room.code,
      hostPid: room.hostPid,
      phase: room.phase,
      settings: room.settings,
      players,
      seatByPid,
      game: room.game,
      winnerPid: room.winnerPid,
      deadline: room.deadline,
      serverNow: now(),
      log: room.log.slice(-12),
    };
  }
}

function reasonOf(code) {
  return reasonText(code);
}
