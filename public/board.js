/**
 * 棋盘渲染器：Canvas 2D，霓虹霓虹霓虹。
 * 参考风格：深色圆角格、发光胶囊路障、发光棋子、高亮中央方块。
 */
import { goalCells, colorOf } from '/shared/engine.js';

const CELL_BG_TOP = '#2a2a30';
const CELL_BG_BOT = '#202026';
const BOARD_BG = '#0e0e11';

function hexToRgba(hex, a = 1) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function mix(hex, hex2, t) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(hex2.slice(1), 16);
  const ch = (sh) => Math.round((((a >> sh) & 255) * (1 - t)) + (((b >> sh) & 255) * t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.pad = 0;
    this.cell = 0;

    this.state = null; // 服务器下发的 game 状态
    this.phase = 'lobby';
    this.mySeat = -1;
    this.mode = 'move';
    this.legal = [];        // [{r,c,kind}]
    this.hoverCell = null;  // {r,c}
    this.hoverWall = null;  // {d,r,c} | null
    this.wallPreview = null;// {d,r,c,ok,reason}
    this.winnerSeat = -1;

    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    }
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== w * this.dpr || this.canvas.height !== h * this.dpr) {
      this.canvas.width = w * this.dpr;
      this.canvas.height = h * this.dpr;
    }
    this.w = w;
    this.h = h;
    const n = this.state?.size || 9;
    this.cell = Math.min(w, h) / (n + 0.64);
    this.pad = this.cell * 0.32;
  }

  setGame(game, phase) {
    this.state = game;
    this.phase = phase;
    this._resize();
  }

  /** 像素 -> 格坐标（浮点） */
  toGrid(px, py) {
    return { x: (px - this.pad) / this.cell, y: (py - this.pad) / this.cell };
  }
  px(u) { return this.pad + u * this.cell; }

  /** 命中格位 */
  hitCell(px, py) {
    const n = this.state?.size;
    if (!n) return null;
    const g = this.toGrid(px, py);
    const c = Math.floor(g.x);
    const r = Math.floor(g.y);
    if (r < 0 || c < 0 || r >= n || c >= n) return null;
    return { r, c };
  }

  /** 命中墙槽：返回最近的合法墙位与距离（格单位）。 */
  hitWall(px, py) {
    const n = this.state?.size;
    if (!n) return null;
    const g = this.toGrid(px, py);

    const hRow = Math.min(n - 1, Math.max(1, Math.round(g.y)));
    const vCol = Math.min(n - 1, Math.max(1, Math.round(g.x)));

    const hCandidates = [Math.floor(g.x) - 1, Math.floor(g.x)];
    const vCandidates = [Math.floor(g.y) - 1, Math.floor(g.y)];

    let best = null;

    // 横墙 (r, c)：占据 y=r，x∈[c, c+2]
    for (let c of hCandidates) {
      c = Math.min(n - 2, Math.max(0, c));
      const dx = g.x < c ? c - g.x : g.x > c + 2 ? g.x - (c + 2) : 0;
      const score = Math.hypot(dx, Math.abs(g.y - hRow));
      if (!best || score < best.score) best = { d: 'h', r: hRow, c, score };
    }
    // 竖墙 (r, c)：占据 x=c，y∈[r, r+2]
    for (let r of vCandidates) {
      r = Math.min(n - 2, Math.max(0, r));
      const dy = g.y < r ? r - g.y : g.y > r + 2 ? g.y - (r + 2) : 0;
      const score = Math.hypot(dy, Math.abs(g.x - vCol));
      if (!best || score < best.score) best = { d: 'v', r, c: vCol, score };
    }
    return best;
  }

  /* ---------------- 绘制 ---------------- */

  draw(time) {
    const ctx = this.ctx;
    const { w, h, cell, pad } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = this.state?.size;
    if (!n) return;

    // 底板
    this._roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 18);
    ctx.fillStyle = BOARD_BG;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 格子
    const inset = cell * 0.05;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = this.px(c) + inset;
        const y = this.px(r) + inset;
        const s = cell - inset * 2;
        const grad = ctx.createLinearGradient(x, y, x, y + s);
        grad.addColorStop(0, CELL_BG_TOP);
        grad.addColorStop(1, CELL_BG_BOT);
        this._roundRect(ctx, x, y, s, s, cell * 0.18);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.045)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 中央目标
    const goals = goalCells(n, this.state.goalSize);
    const pulse = 0.5 + 0.5 * Math.sin(time / 600);
    for (const g of goals) {
      const inset2 = cell * 0.12;
      const x = this.px(g.c) + inset2;
      const y = this.px(g.r) + inset2;
      const s = cell - inset2 * 2;
      ctx.save();
      ctx.shadowColor = 'rgba(255,210,31,.75)';
      ctx.shadowBlur = cell * (0.45 + pulse * 0.25);
      this._roundRect(ctx, x, y, s, s, cell * 0.2);
      ctx.fillStyle = '#ffd21f';
      ctx.fill();
      ctx.restore();
      // 内芯高光
      this._roundRect(ctx, x + s * 0.18, y + s * 0.18, s * 0.64, s * 0.64, cell * 0.14);
      ctx.fillStyle = 'rgba(255,244,180,.85)';
      ctx.fill();
    }

    // 合法走法提示
    if (this.legal.length) {
      for (const m of this.legal) {
        const cx = this.px(m.c + 0.5);
        const cy = this.px(m.r + 0.5);
        const col = colorOf(this.mySeat);
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = cell * 0.3;
        if (m.kind === 'step') {
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.1, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(col, 0.85);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.14, 0, Math.PI * 2);
          ctx.strokeStyle = hexToRgba(col, 0.9);
          ctx.lineWidth = cell * 0.055;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 悬停格高亮
    if (this.hoverCell && this.mode === 'move') {
      const x = this.px(this.hoverCell.c) + inset;
      const y = this.px(this.hoverCell.r) + inset;
      this._roundRect(ctx, x, y, cell - inset * 2, cell - inset * 2, cell * 0.18);
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fill();
    }

    // 路障
    for (const wl of this.state.walls || []) {
      this._drawWall(wl.d, wl.r, wl.c, colorOf(wl.seat), 1);
    }

    // 放墙预览
    if (this.wallPreview) {
      const wp = this.wallPreview;
      const col = wp.ok ? colorOf(this.mySeat) : '#ff5470';
      this._drawWall(wp.d, wp.r, wp.c, col, 0.55);
    }

    // 棋子
    if (this.state.pawns) {
      this.state.pawns.forEach((p, seat) => {
        if (!p) return;
        this._drawPawn(p, seat, time);
      });
    }

    // 胜者强调
    if (this.winnerSeat >= 0 && this.state.pawns[this.winnerSeat]) {
      const p = this.state.pawns[this.winnerSeat];
      const cx = this.px(p.c + 0.5);
      const cy = this.px(p.r + 0.5);
      const t = (time % 1400) / 1400;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, cell * (0.35 + t * 0.5), 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(colorOf(this.winnerSeat), (1 - t) * 0.8);
      ctx.lineWidth = cell * 0.06;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawPawn(p, seat, time) {
    const ctx = this.ctx;
    const cell = this.cell;
    const cx = this.px(p.c + 0.5);
    const cy = this.px(p.r + 0.5);
    const col = colorOf(seat);
    const active = seat === this.mySeat && this.phase === 'playing' && this.state.turn === seat;

    // 当前玩家旋转光环
    if (this.state.turn === seat && this.phase === 'playing') {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(time / 900);
      ctx.beginPath();
      ctx.setLineDash([cell * 0.22, cell * 0.16]);
      ctx.arc(0, 0, cell * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(col, 0.9);
      ctx.lineWidth = cell * 0.05;
      ctx.shadowColor = col;
      ctx.shadowBlur = cell * 0.25;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = cell * (active ? 0.5 : 0.35);
    const grad = ctx.createRadialGradient(cx - cell * 0.12, cy - cell * 0.14, cell * 0.05, cx, cy, cell * 0.32);
    grad.addColorStop(0, mix(col, '#ffffff', 0.45));
    grad.addColorStop(1, col);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // 暗色描边，增强立体感
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** 三层霓虹：外发光 -> 主体 -> 亮芯 */
  _drawWall(d, r, c, color, alpha) {
    const ctx = this.ctx;
    const cell = this.cell;
    const w = cell * 0.24;
    let x1, y1, x2, y2;
    if (d === 'h') {
      x1 = this.px(c); y1 = this.px(r);
      x2 = this.px(c + 2); y2 = this.px(r);
    } else {
      x1 = this.px(c); y1 = this.px(r);
      x2 = this.px(c); y2 = this.px(r + 2);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';

    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 0.55;
    ctx.strokeStyle = hexToRgba(color, 0.6);
    ctx.lineWidth = w * 1.1;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    ctx.shadowBlur = cell * 0.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = mix(color, '#ffffff', 0.5);
    ctx.lineWidth = w * 0.34;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
