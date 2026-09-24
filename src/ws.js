/**
 * 极简 WebSocket 服务端 (RFC 6455)，零依赖。
 * 只实现游戏需要的部分：文本帧、分片、ping/pong、关闭握手。
 */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1MB
const HEARTBEAT_MS = 30000;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class Connection {
  constructor(socket, handlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.closed = false;
    this.fragOp = null;
    this.frags = [];
    /** 上层可挂载任意数据（例如玩家 id、房间号）。 */
    this.data = {};

    socket.on('data', (chunk) => this._read(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._finish());

    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.destroy();
        return;
      }
      this.alive = false;
      this._frame(OP_PING, Buffer.alloc(0));
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  _read(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009, 'too large');
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009, 'too large');

      // 客户端发来的帧必须带掩码
      if (!masked) return this.close(1002, 'unmasked');
      if (buf.length < off + 4) return;
      const mask = buf.subarray(off, off + 4);
      off += 4;

      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(off + len);

      this._handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this._frame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      this.alive = true;
      return;
    }
    if (opcode === OP_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP_BIN) return this.close(1003, 'binary unsupported');

    if (opcode === OP_CONT) {
      if (!this.fragOp) return this.close(1002, 'unexpected continuation');
      this.frags.push(payload);
    } else if (opcode === OP_TEXT) {
      if (this.fragOp) return this.close(1002, 'nested fragment');
      this.fragOp = OP_TEXT;
      this.frags = [payload];
    } else {
      return this.close(1002, 'bad opcode');
    }

    if (!fin) return;
    const full = Buffer.concat(this.frags);
    this.fragOp = null;
    this.frags = [];
    this.alive = true;

    let text;
    try {
      text = full.toString('utf8');
    } catch {
      return this.close(1007, 'bad utf8');
    }
    try {
      this.handlers.onMessage?.(this, text);
    } catch (err) {
      this.handlers.onError?.(this, err);
    }
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.destroy();
    }
  }

  send(obj) {
    this._frame(OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._frame(OP_CLOSE, body);
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref?.();
    this._finish();
  }

  destroy() {
    clearInterval(this.heartbeat);
    this.socket.destroy();
    this._finish();
  }

  _finish() {
    clearInterval(this.heartbeat);
    if (this.done) return;
    this.done = true;
    this.closed = true;
    this.handlers.onClose?.(this);
  }
}

/** 把 WebSocket 挂到已有的 http.Server 上。 */
export function attachWebSocket(server, handlers) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();

    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const conn = new Connection(socket, handlers);
    if (head && head.length) conn._read(head);
    handlers.onOpen?.(conn, req);
  });
}