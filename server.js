#!/usr/bin/env node
/**
 * 路障棋 (Quorider) 服务器 —— 零依赖，node server.js 即可运行。
 *
 *   PORT   监听端口，默认 3000
 *   HOST   监听地址，默认 0.0.0.0
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './src/ws.js';
import { RoomManager, sanitizeName } from './src/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'src');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveFile(res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size, uptime: process.uptime() }));
    return;
  }

  let filePath;
  if (pathname === '/') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (pathname === '/favicon.ico') {
    // 只提供 SVG 图标；把浏览器对 /favicon.ico 的自动请求也指过去，消掉无谓的 404
    filePath = path.join(PUBLIC_DIR, 'favicon.svg');
  } else if (pathname.startsWith('/shared/')) {
    // 浏览器与 Node 共用的引擎代码
    filePath = path.join(SHARED_DIR, path.normalize(pathname.slice('/shared/'.length)));
  } else {
    filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  }

  // 防目录穿越：解析后必须仍在对应根目录内
  const base = pathname.startsWith('/shared/') ? SHARED_DIR : PUBLIC_DIR;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }
  serveFile(res, filePath);
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const manager = new RoomManager();
const PING_INTERVAL_MS = 1000;

function makePid(raw) {
  const s = String(raw ?? '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function reply(conn, obj) {
  try {
    conn.send(obj);
  } catch {
    conn.destroy();
  }
}

function bindRoom(room, player, conn) {
  // 一个玩家同时只保留一条连接（旧连接会被顶掉）
  if (player.conn && player.conn !== conn) {
    const old = player.conn;
    old.kicked = true;
    // destroy() 会同步触发 onClose，而此时 player.conn 还指着旧连接，
    // 若不先打标记，onClose 会把玩家当成「掉线/主动离开」从房间里摘掉——
    // 于是新连接既收不到 state，房间也少一个人（换设备/手机接管必现）。
    old.replaced = true;
    try {
      old.send({ t: 'replaced' });
    } catch { /* 忽略 */ }
    old.destroy();
  }
  player.conn = conn;
  conn.data = { roomCode: room.code, pid: player.pid };
}

const handlers = {
  onOpen(conn) {
    conn.ready = true;
  },

  onClose(conn) {
    conn.ready = false;
    // 被同账号的新连接顶掉的旧连接：座位已经交给新连接，这里什么都不做
    if (conn.replaced) return;
    const { roomCode, pid } = conn.data || {};
    if (!roomCode) return;
    const room = manager.findRoom(roomCode);
    if (!room) return;
    const player = room.players.get(pid);
    if (player && player.conn === conn) {
      player.conn = null;
      // 大厅里断开视为退房；对局中掉线则保留座位等待重连（见 rooms.js）
      manager.leaveRoom(room, pid, { deliberate: false });
    }
    manager.broadcast(room);
  },

  onError(conn, err) {
    console.error('[ws] 处理消息出错:', err?.message || err);
    reply(conn, { t: 'error', msg: '服务器处理消息时出错' });
  },

  onMessage(conn, text) {
    // 简单限流：每秒最多 20 条
    const ts = Date.now();
    conn.rate = conn.rate || { count: 0, window: ts };
    if (ts - conn.rate.window > 1000) {
      conn.rate = { count: 0, window: ts };
    }
    if (++conn.rate.count > 20) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return reply(conn, { t: 'error', msg: '消息格式错误' });
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'ping':
        return reply(conn, { t: 'pong' });

      case 'create': {
        const pid = makePid(msg.pid);
        if (!pid) return reply(conn, { t: 'error', msg: '身份无效，请刷新页面' });
        const name = sanitizeName(msg.name);
        const room = manager.createRoom({ pid, name, settings: msg.settings });
        const player = room.players.get(pid);
        bindRoom(room, player, conn);
        manager.broadcast(room);
        return;
      }

      case 'join': {
        const pid = makePid(msg.pid);
        if (!pid) return reply(conn, { t: 'error', msg: '身份无效，请刷新页面' });
        const name = sanitizeName(msg.name);
        const { room, player, error } = manager.joinRoom({
          code: msg.code,
          pid,
          name,
        });
        if (error) return reply(conn, { t: 'error', msg: error });
        bindRoom(room, player, conn);
        manager.broadcast(room);
        return;
      }

      case 'leave': {
        const { roomCode, pid } = conn.data || {};
        const room = manager.findRoom(roomCode);
        if (!room || !pid) return;
        conn.data = {};
        manager.leaveRoom(room, pid, { deliberate: true });
        conn.close(1000, 'left');
        manager.broadcast(room);
        return;
      }

      default: {
        // 以下操作都要求已在房间里
        const { roomCode, pid } = conn.data || {};
        const room = manager.findRoom(roomCode);
        if (!room || !pid || !room.players.has(pid)) {
          return reply(conn, { t: 'error', msg: '你不在房间里，请先加入' });
        }
        handleRoomMessage(conn, room, pid, msg);
        return;
      }
    }
  },
};

function handleRoomMessage(conn, room, pid, msg) {
  switch (msg.t) {
    case 'settings': {
      const res = manager.updateSettings(room, pid, msg.settings);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'start': {
      const res = manager.startGame(room, pid);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'restart': {
      const res = manager.restart(room, pid);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'move': {
      const res = manager.move(room, pid, msg.to);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'wall': {
      const res = manager.placeWall(room, pid, msg.wall);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'item': {
      // 使用道具：kind=3 随机传送 / 1 破墙 / 2 陷阱
      const res = manager.useItem(room, pid, msg.kind, msg.data || {});
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      manager.broadcast(room);
      return;
    }
    case 'danmaku': {
      const res = manager.danmaku(room, pid, msg.text);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      // 弹幕是广播性内容，直接推给所有人（不需要重发整份 state）
      const payload = { t: 'danmaku', entry: res.entry };
      for (const p of room.players.values()) {
        if (p.conn?.ready) reply(p.conn, payload);
      }
      return;
    }
    case 'react': {
      // 头像互动：由 manager.react 精确下发两份不同视角的特效事件
      const res = manager.react(room, pid, makePid(msg.target), msg.kind);
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      return;
    }
    case 'kick': {
      const res = manager.kick(room, pid, makePid(msg.pid));
      if (res.error) return reply(conn, { t: 'error', msg: res.error });
      const kicked = res.kicked;
      if (kicked?.conn) {
        try {
          kicked.conn.send({ t: 'kicked' });
        } catch { /* 忽略 */ }
        kicked.conn.data = {};
        kicked.conn.close(1000, 'kicked');
      }
      manager.broadcast(room);
      return;
    }
    default:
      reply(conn, { t: 'error', msg: `未知指令: ${msg.t}` });
  }
}

attachWebSocket(server, handlers);

/* ------------------------------------------------------------------ */
/* 定时器：回合超时托管 + 空房间回收                                     */
/* ------------------------------------------------------------------ */

setInterval(() => {
  for (const room of manager.rooms.values()) {
    try {
      const changed = manager.tick(room);
      room.touch();
      if (changed) manager.broadcast(room);
    } catch (err) {
      console.error('[tick] 房间处理出错:', err);
    }
  }
  manager.sweep();
}, PING_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   路障棋 Quorider · 多人路障棋服务器   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  监听地址:   ${HOST}:${PORT}  (改端口: PORT=8080 node server.js)`);
  console.log('');
  console.log('  零依赖运行，无需 npm install。Ctrl+C 停止。');
  console.log('');
});

process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
});
