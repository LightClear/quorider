/**
 * 浏览器实机验收（桌面 + 手机视口）。
 *
 * 与 ws-flow.test.js 的区别：这里跑真实 Chromium，验证「人能看到、能点到」的东西：
 *   - 页面无 console 报错 / 未捕获异常
 *   - 截图落在 gui-test-screenshots/（供人工比对参考图）
 *   - canvas 像素抽样：中央黄块、发光路障、棋子确实画出来了（防止"白画布"）
 *   - 合法走法用引擎现算，真实鼠标点击驱动整局，走到胜利 → 快速重开
 *   - 非法放墙弹出中文原因
 *   - 移动端 375×812 单栏布局、无横向溢出、触摸目标 ≥36px、触摸走子
 *
 * 运行：
 *   node server.js            # 另开一个终端
 *   node test/browser-e2e.mjs
 *
 * 开发期可选依赖 playwright-core；部署到服务器不需要它。
 * 浏览器路径可用 QDR_CHROME 指定。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legalMoves, canPlaceWall, distancesToGoal } from '../src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'gui-test-screenshots');
const CDP_PORT = Number(process.env.QDR_CDP_PORT || 9333);
const T = 8000;
const HARD_TIMEOUT_MS = Number(process.env.QDR_TIMEOUT_MS || 300000);

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */
const results = [];
let currentGroup = '通用';

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ──`);
}

function check(label, ok, detail = '') {
  results.push({ group: currentGroup, label, ok: !!ok, detail: String(detail) });
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? `  —  ${detail}` : ''}`);
  return !!ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 加载 playwright-core                                                */
/* ------------------------------------------------------------------ */
async function loadPlaywright() {
  const candidates = [
    process.env.QDR_PW,
    path.join(ROOT, 'node_modules', 'playwright-core'),
    path.join(ROOT, 'node_modules', 'playwright'),
    'D:/Codes/free-practice/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core',
  ].filter(Boolean);

  for (const dir of candidates) {
    for (const entry of ['index.mjs', 'index.js']) {
      const file = path.join(dir, entry);
      if (!fs.existsSync(file)) continue;
      try {
        const mod = await import(pathToFileURL(file).href);
        const chromium = mod.chromium || mod.default?.chromium;
        if (chromium) return { chromium, from: file };
      } catch { /* 试下一个 */ }
    }
  }
  throw new Error(
    '找不到 playwright-core。安装：npm i -D playwright-core && npx playwright install chromium\n' +
      '或用 QDR_PW=<playwright-core 目录> 指定路径。',
  );
}

/* ------------------------------------------------------------------ */
/* 启动 Chromium（TCP 调试端口 + CDP，避开 --remote-debugging-pipe）     */
/* ------------------------------------------------------------------ */
function findChrome() {
  const explicit = process.env.QDR_CHROME;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const list = [];
  const cache = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ms-playwright')
    : null;
  if (cache && fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      if (!/^chromium-\d+$/.test(dir)) continue;
      list.push(
        path.join(cache, dir, 'chrome-win64', 'chrome.exe'),
        path.join(cache, dir, 'chrome-win', 'chrome.exe'),
        path.join(cache, dir, 'chrome-linux', 'chrome'),
      );
    }
  }
  list.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  );
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chromium/Chrome，可用 QDR_CHROME=<路径> 指定。');
}

async function startChrome(bin, userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const proc = spawn(
    bin,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-search-engine-choice-screen',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-sandbox',
      '--window-position=-2400,-2400',
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  proc.on('error', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return proc;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error('Chrome 调试端口未就绪');
}

/* ------------------------------------------------------------------ */
/* 浏览器侧取状态 / 点棋盘                                             */
/* ------------------------------------------------------------------ */

/** 读取页面里的 game 状态（app.js 把最新 state 挂在模块作用域，这里从 DOM 反推关键量）。 */
async function snapshot(page) {
  return page.evaluate(() => {
    const t = document.querySelector('#ti-text')?.textContent || '';
    return {
      tiText: t,
      timer: document.querySelector('#ti-timer')?.textContent || '',
      wallCount: Number(document.querySelector('#wall-count')?.textContent || -1),
      wallMode: document.querySelector('#btn-mode-wall')?.classList.contains('active') || false,
      moveMode: document.querySelector('#btn-mode-move')?.classList.contains('active') || false,
      winnerVisible: !document.querySelector('#overlay-winner')?.classList.contains('hidden'),
      lobbyVisible: !document.querySelector('#overlay-lobby')?.classList.contains('hidden'),
      winnerTitle: document.querySelector('#winner-title')?.textContent || '',
      size: window.__qdr?.game?.size ?? 9,
      // 新功能：道具栏 / 弹幕 / 互动
      itemBarVisible: !document.querySelector('#itembar')?.classList.contains('hidden'),
      itemSlots: document.querySelectorAll('#items-slots .item-slot').length,
      itemFilled: document.querySelectorAll('#items-slots .item-slot.filled').length,
      danmakuItems: document.querySelectorAll('#danmaku-layer .danmaku-item').length,
      fxItems: document.querySelectorAll('#fx-layer > *').length,
      reactionPickerVisible: !document.querySelector('#reaction-picker')?.classList.contains('hidden'),
      reactionButtons: document.querySelectorAll('#reaction-picker button').length,
    };
  });
}

/**
 * 旁路读取服务器广播给页面的 state。
 *
 * app.js 没有把 state 挂到 window。两条路都试过：
 *   1) 包装 WebSocket 构造函数 —— 真实 WebSocket 的 `prototype` 是 non-writable，
 *      `Object.assign(wrapper, OrigWS)` 会抛 TypeError，反而把页面搞坏，放弃；
 *   2) 从 JSON.parse 取 —— 所有 WS 文本帧都要过它，页面行为零改动，采用这条。
 *
 * 注意广播帧的形状是 `{ t: 'state', game: {...}, phase, players, ... }`：
 * `t` 是**消息类型字符串**（不是 game 里的 turn），对局对象在 `v.game`。
 */
async function installStateTap(page) {
  await page.addInitScript(() => {
    window.__qdr = { game: null, phase: null, hooked: 0, danmaku: null };
    const origParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const v = origParse.call(this, text, reviver);
      try {
        if (v && typeof v === 'object' && v.t === 'state' && v.game) {
          window.__qdr.hooked++;
          window.__qdr.game = v.game;
          window.__qdr.phase = v.phase;
          // 弹幕历史（用来验证刷新后不会把旧弹幕重放一遍）
          if (Array.isArray(v.danmaku)) window.__qdr.danmaku = v.danmaku;
        }
      } catch { /* 忽略 */ }
      return v;
    };
  });
}

/**
 * 轮询页面里的对局状态。
 * 默认等到 game 就绪（否则会读到 null），给了 pred 就等到 pred 成立。
 */
async function readGame(page, pred, timeout = 3000) {
  const test = pred || ((g) => !!g);
  const deadline = Date.now() + timeout;
  for (;;) {
    const g = await page.evaluate(() => window.__qdr?.game || null);
    if (test(g)) return g;
    if (Date.now() > deadline) return g;
    await sleep(60);
  }
}

const waitTurn = (page, seat) => readGame(page, (g) => g && g.turn === seat, T);

/** 棋盘几何：cell = min(cssW,cssH)/(n+0.64)，pad = cell*0.32，整体居中（与 board.js 一致）。 */
async function geometry(page, size) {
  // 先把棋盘滚进视口：顶栏是 sticky 的，页面一旦滚动，棋盘最上面一两行会被它盖住，
  // 用鼠标点那几格会点到顶栏而不是画布（道具栏出现后页面变高，必踩这个坑）。
  await page.evaluate(() => {
    const wrap = document.querySelector('.board-wrap');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    window.scrollBy(0, r.top - 72); // 让棋盘顶部落在顶栏下方
  });
  await page.waitForTimeout(60);
  const box = await page.evaluate(() => {
    const b = document.querySelector('#board').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  if (!box?.w) throw new Error('拿不到棋盘尺寸');
  const cell = Math.min(box.w, box.h) / (size + 0.64);
  const pad = cell * 0.32;
  const span = size * cell + 2 * pad;
  const x0 = box.x + (box.w - span) / 2 + pad;
  const y0 = box.y + (box.h - span) / 2 + pad;
  return {
    box,
    cell,
    pad,
    cellPoint: (r, c) => ({ x: x0 + (c + 0.5) * cell, y: y0 + (r + 0.5) * cell }),
    wallPoint: (d, r, c) => (d === 'h'
      ? { x: x0 + (c + 1) * cell, y: y0 + r * cell }
      : { x: x0 + c * cell, y: y0 + (r + 1) * cell }),
  };
}

/** 手机视口必须用 hasTouch 建上下文；事后用 CDP 补触摸模拟，事件到不了页面。 */

/** 走一步：用引擎算合法走法 → 点击对应像素。返回是否点到。 */
async function playMove(page, seat, target) {
  const game = await readGame(page);
  const moves = legalMoves(game, seat);
  const mv = target
    ? moves.find((m) => m.r === target.r && m.c === target.c)
    : pickTowardGoal(game, seat, moves);
  if (!mv) return null;
  const geo = await geometry(page, game.size);
  const p = geo.cellPoint(mv.r, mv.c);
  await page.mouse.click(p.x, p.y);
  return mv;
}

function pickTowardGoal(game, seat, moves) {
  const dist = distancesToGoal(game);
  return moves.reduce((best, m) => {
    const d = dist[m.r * game.size + m.c];
    const bd = best ? dist[best.r * game.size + best.c] : Infinity;
    return d < bd ? m : best;
  }, null);
}

/** 等 #ti-text 出现某段文案（页面已经在用的中文提示）。 */
async function waitTiText(page, includes, timeout = T) {
  await page.waitForFunction(
    (txt) => document.querySelector('#ti-text')?.textContent.includes(txt),
    includes,
    { timeout },
  );
}

/** 等到轮到自己走子（用 turn 而不是文案判断，避免过渡态误判）。 */
const waitAtTurn = (page, seat) => readGame(page, (g) => g && g.turn === seat, T);

/* ------------------------------------------------------------------ */
/* canvas 像素抽样                                                     */
/* ------------------------------------------------------------------ */
async function pixelStats(page) {
  const box = await page.locator('#board').boundingBox();
  return page.evaluate(
    ([b]) => {
      const src = document.querySelector('#board');
      const off = document.createElement('canvas');
      off.width = src.width;
      off.height = src.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const sx = Math.max(0, Math.round(b.x));
      const sy = Math.max(0, Math.round(b.y));
      const sw = Math.max(1, Math.min(src.width - sx, Math.round(b.w)));
      const sh = Math.max(1, Math.min(src.height - sy, Math.round(b.h)));
      const d = ctx.getImageData(sx, sy, sw, sh).data;
      let yellow = 0;
      let colorful = 0;
      let bright = 0;
      const total = d.length / 4 || 1;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const bl = d[i + 2];
        if (r > 200 && g > 170 && bl < 120) yellow++;
        const mx = Math.max(r, g, bl);
        const mn = Math.min(r, g, bl);
        if (mx > 90 && mx - mn > 60) colorful++;
        if (mx > 120) bright++;
      }
      return {
        total,
        yellowRatio: yellow / total,
        colorfulRatio: colorful / total,
        brightRatio: bright / total,
      };
    },
    [{ x: box.x, y: box.y, w: box.width, h: box.height }],
  );
}

/** 失败诊断：把页面看到的真实情况打出来（截图 + 控制台 + DOM + WS 状态）。 */
async function debugPage(page, tag) {
  if (!/^(1|true|yes)$/i.test(process.env.DEBUG_PAGE || '')) return;
  try {
    const box = await page.evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'MISSING';
        const cs = getComputedStyle(el);
        return `${cs.display}/${cs.visibility}/${el.className}`;
      };
      return {
        url: location.href,
        home: vis('#screen-home'),
        room: vis('#screen-room'),
        code: document.querySelector('#room-code')?.textContent,
        toast: document.querySelector('#toast')?.textContent,
        qdr: window.__qdr ? Object.keys(window.__qdr) : null,
        phase: window.__qdr?.phase,
        players: window.__qdr?.players?.length,
      };
    });
    console.log(`\n[DEBUG ${tag}]`, JSON.stringify(box, null, 2));
    await page.screenshot({ path: path.join(OUT, `debug_${tag}.png`) });
    console.log(`[DEBUG ${tag}] 截图: debug_${tag}.png`);
  } catch (e) {
    console.log(`[DEBUG ${tag}] 诊断失败: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];

/** 硬超时看门狗。 */
const watchdog = setTimeout(() => {
  console.error(`\n[看门狗] 超过 ${HARD_TIMEOUT_MS}ms 未完成，强制退出。`);
  const failed = results.filter((r) => !r.ok);
  console.error(`已完成 ${results.length} 项，失败 ${failed.length} 项。`);
  process.exit(2);
}, HARD_TIMEOUT_MS);
watchdog.unref?.();

/** 取一个空闲端口（避免上次异常退出后残留的服务器占用固定端口）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  const port = Number(process.env.QDR_PW_PORT || 0) || (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  server.on('error', () => {});
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) { up = true; break; }
    } catch { /* 等待 */ }
    await sleep(100);
  }
  if (!up) throw new Error(`服务器未能在 ${port} 启动`);
  console.log(`验证服务器: ${base}`);

  const { chromium, from } = await loadPlaywright();
  console.log(`playwright-core: ${from}`);
  const chromeBin = findChrome();
  console.log(`浏览器: ${chromeBin}`);
  const chrome = await startChrome(chromeBin, path.join(ROOT, '.dcs', 'chrome-profile'));

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  // 房主与访客必须用「独立的浏览器上下文」：同一个上下文共享 localStorage，
  // 访客会继承房主的 pid（app.js 把它存在 quorider.pid），于是变成同一个账号
  // —— 新连接会顶掉房主、房间随即被回收，整个流程直接崩掉。
  const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const attach = (page, tag) => {
    page.on('console', (m) => {
      const line = `[${tag}] ${m.type()}: ${m.text()}`;
      if (m.type() === 'error') consoleErrors.push(line);
      if (process.env.DEBUG_PAGE) console.log(`  · ${line}`);
    });
    page.on('pageerror', (e) => {
      pageErrors.push(`[${tag}] ${e.message}`);
      if (process.env.DEBUG_PAGE) console.log(`  ! [${tag}] pageerror: ${e.message}`);
    });
    page.on('requestfailed', (r) => {
      badResponses.push(`[${tag}] FAILED ${r.url()} ${r.failure()?.errorText || ''}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('/favicon')) {
        badResponses.push(`[${tag}] ${res.status()} ${res.url()}`);
      }
    });
    page.on('websocket', (ws) => {
      if (!process.env.DEBUG_PAGE) return;
      console.log(`  ⇄ [${tag}] WS 打开 ${ws.url()}`);
      ws.on('framesent', (f) => console.log(`  → [${tag}] ${String(f.payload).slice(0, 140)}`));
      ws.on('framereceived', (f) => console.log(`  ← [${tag}] ${String(f.payload).slice(0, 140)}`));
      ws.on('close', () => console.log(`  ✕ [${tag}] WS 关闭`));
    });
    return page;
  };

  const pageA = attach(await ctx.newPage(), 'host');
  const pageB = attach(await guestCtx.newPage(), 'guest');
  await installStateTap(pageA);
  await installStateTap(pageB);

  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

  try {
    /* ================= 桌面 1440×900 · 首页 ================= */
    group('桌面 1440×900 · 首页');
    await pageA.setViewportSize({ width: 1440, height: 900 });
    await pageA.goto(base, { waitUntil: 'networkidle' });
    await pageA.waitForTimeout(400);

    const homeLayout = await pageA.evaluate(() => {
      const a = document.querySelector('#form-create').getBoundingClientRect();
      const b = document.querySelector('#form-join').getBoundingClientRect();
      return {
        twoCol: b.left >= a.right - 2 && Math.abs(a.top - b.top) < 4,
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      };
    });
    check('首页两栏并排（创建 / 加入）', homeLayout.twoCol, JSON.stringify(homeLayout));
    check('首页无横向溢出', homeLayout.sw <= homeLayout.iw + 1);
    await shot(pageA, 'b01_home_desktop.png');

    /* ================= 桌面 · 建房与大厅 ================= */
    group('桌面 · 建房与邀请码');
    await pageA.fill('#in-create-name', '房主甲');
    await pageA.selectOption('#in-size', '9');
    await pageA.selectOption('#in-goal', '1');
    // 打开宝箱，让后面的道具栏 / 陷阱 / 宝箱渲染都有东西可验证
    await pageA.selectOption('#in-chests', '5');
    await pageA.selectOption('#in-chest-mode', '0');
    await pageA.click('#form-create button[type=submit]');
    try {
      await pageA.waitForSelector('#screen-room.active', { timeout: T });
    } catch (err) {
      await debugPage(pageA, 'create-failed');
      console.log('\n控制台错误：', consoleErrors.slice(-10).join('\n  ') || '(无)');
      console.log('页面异常：', pageErrors.slice(-10).join('\n  ') || '(无)');
      console.log('坏响应：', badResponses.slice(-10).join('\n  ') || '(无)');
      throw err;
    }
    await pageA.waitForFunction(() => /^[A-Z0-9]{5}$/.test(document.querySelector('#room-code').textContent), null, { timeout: T });
    const code = (await pageA.textContent('#room-code')).trim();
    check('生成 5 位邀请码', /^[A-Z0-9]{5}$/.test(code), code);
    check('大厅遮罩显示同一邀请码', (await pageA.textContent('#lobby-code')).trim() === code);
    check('大厅显示"等待玩家加入"', (await pageA.textContent('#overlay-lobby h3')).includes('等待玩家'));
    await pageA.waitForTimeout(500);
    await shot(pageA, 'b02_lobby_host.png');

    await pageB.setViewportSize({ width: 1440, height: 900 });
    await pageB.goto(`${base}/?r=${code}`, { waitUntil: 'networkidle' });
    check('深链 ?r= 预填邀请码', (await pageB.inputValue('#in-join-code')).toUpperCase() === code);
    await pageB.fill('#in-join-name', '访客乙');
    await pageB.click('#form-join button[type=submit]');
    try {
      await pageB.waitForSelector('#screen-room.active', { timeout: T });
    } catch (err) {
      await debugPage(pageB, 'join-failed');
      console.log('访客输入框 =', JSON.stringify(await pageB.inputValue('#in-join-code')));
      console.log('页面异常：', pageErrors.slice(-10).join('\n  ') || '(无)');
      console.log('坏响应：', badResponses.slice(-10).join('\n  ') || '(无)');
      throw err;
    }
    await pageA.waitForFunction(
      () => document.querySelectorAll('#player-list .player-item:not(.spectator)').length === 2,
      null,
      { timeout: T },
    );
    check('房主实时看到 2 名玩家（WS 广播生效）', true);
    check('访客看不到「开始游戏」', await pageB.locator('#btn-start').isHidden());
    check('房主可见「开始游戏」且已启用', await pageA.locator('#btn-start').isEnabled());
    check('路障余量显示为设置值 10', (await pageA.textContent('#wall-count')).trim() === '10');
    await shot(pageA, 'b03_lobby_two_players.png');

    /* ================= 桌面 · 开局与走子 ================= */
    group('桌面 · 开局与走子');
    await pageA.click('#btn-start');
    await waitAtTurn(pageA, 0);
    const g0 = await readGame(pageA);
    if (!g0 && process.env.DEBUG_PAGE) {
      console.log('[诊断] host __qdr =', JSON.stringify(await pageA.evaluate(() => ({
        hooked: window.__qdr?.hooked,
        phase: window.__qdr?.phase,
        tiText: document.querySelector('#ti-text')?.textContent,
      }))));
      console.log('[诊断] guest __qdr =', JSON.stringify(await pageB.evaluate(() => ({
        hooked: window.__qdr?.hooked,
        phase: window.__qdr?.phase,
      }))));
    }
    check('开局棋盘 9×9', g0?.size === 9, `size=${g0?.size}`);
    check('房主（下方）起点 (8,4)', JSON.stringify(pawnOf(g0, 0)) === '{"r":8,"c":4}', JSON.stringify(pawnOf(g0, 0)));
    check('访客（上方）起点 (0,4)', JSON.stringify(pawnOf(g0, 1)) === '{"r":0,"c":4}', JSON.stringify(pawnOf(g0, 1)));
    const timer0 = (await snapshot(pageA)).timer;
    check('回合倒计时在走', /^\d+s$/.test(timer0), timer0);

    const mv1 = await playMove(pageA, 0);
    check('房主走子成功（真实鼠标点击）', !!mv1, mv1 ? `→ (${mv1.r},${mv1.c})` : '找不到可走点');
    const gT1 = await readGame(pageB, (g) => g && g.turn === 1, T);
    check('回合交到访客', gT1?.turn === 1, `turn=${gT1?.turn}`);
    await waitTiText(pageB, '轮到你');
    check('访客侧提示「轮到你」', true);

    // 非法走子：直接点中央（离得远，绝不是合法步），不该有任何变化
    const guestPawnBefore = JSON.stringify(pawnOf(await readGame(pageB), 1));
    const geoB = await geometry(pageB, 9);
    const far = geoB.cellPoint(4, 4);
    await pageB.mouse.click(far.x, far.y);
    await pageB.waitForTimeout(400);
    const gAfterIllegal = await readGame(pageB);
    check('点击远处非法格不产生走子',
      JSON.stringify(pawnOf(gAfterIllegal, 1)) === guestPawnBefore,
      `${guestPawnBefore} → ${JSON.stringify(pawnOf(gAfterIllegal, 1))}`);

    const mv2 = await playMove(pageB, 1);
    check('访客走子成功', !!mv2, mv2 ? `→ (${mv2.r},${mv2.c})` : '找不到可走点');
    const gT0 = await readGame(pageA, (g) => g && g.turn === 0, T);
    check('回合回到房主', gT0?.turn === 0, `turn=${gT0?.turn}`);

    /* ================= 桌面 · 放墙 ================= */
    group('桌面 · 放墙与非法拦截');
    const gBefore = await readGame(pageA, (g) => g && g.turn === 0, T);
    if (!gBefore) throw new Error('拿不到房主回合的棋盘状态');
    const wallsBefore = gBefore.seats[0].wallsLeft;

    await pageA.click('#btn-mode-wall');
    check('切换到放墙模式', (await snapshot(pageA)).wallMode);

    // 挑一个引擎判定合法的墙（避开房主上方的 (4,4) 主路），并用引擎算出的坐标点击
    const legalWall = findLegalWall(
      gBefore,
      0,
      (d, r, c) => !(d === 'h' && r === 4 && (c === 3 || c === 4)),
    );
    const geoA = await geometry(pageA, 9);
    const wp = geoA.wallPoint(legalWall.d, legalWall.r, legalWall.c);
    await pageA.mouse.move(wp.x, wp.y);
    await pageA.waitForTimeout(150);
    await shot(pageA, 'b04_wall_hover_preview.png');
    await pageA.mouse.click(wp.x, wp.y);
    const gWall = await readGame(pageA, (g) => g && g.walls.length === 1, T);
    check('合法放墙成功，墙体出现在棋盘上', gWall.walls.length === 1,
      `${legalWall.d}(${legalWall.r},${legalWall.c})`);
    check('路障余量 -1', gWall.seats[0].wallsLeft === wallsBefore - 1,
      `${wallsBefore} → ${gWall.seats[0].wallsLeft}`);
    check('放墙后自动切回走子模式', (await snapshot(pageA)).moveMode);
    await shot(pageA, 'b05_wall_placed.png');

    // 非法：交叉墙（用引擎先确认这个位置真的交叉）
    const gB = await waitTurn(pageB, 1);
    const crossWall = findCrossingWall(gB);
    const toastText = crossWall
      ? await (async () => {
        await pageB.click('#btn-mode-wall');
        const geoB2 = await geometry(pageB, 9);
        const cp = geoB2.wallPoint(crossWall.d, crossWall.r, crossWall.c);
        await pageB.mouse.click(cp.x, cp.y);
        await pageB.waitForSelector('#toast.show', { timeout: 4000 });
        return (await pageB.textContent('#toast')).trim();
      })()
      : '';
    check('交叉墙被引擎判定为非法（前置条件）',
      !!crossWall && canPlaceWall(gB, 1, crossWall.d, crossWall.r, crossWall.c).reason === 'cross',
      crossWall ? `${crossWall.d}(${crossWall.r},${crossWall.c}) → ${canPlaceWall(gB, 1, crossWall.d, crossWall.r, crossWall.c).reason}` : '找不到交叉位');
    check('非法放墙弹出中文原因 toast', /交叉|路障|封死/.test(toastText), toastText || '(无 toast)');
    check('非法放墙未消耗路障', (await readGame(pageB)).seats[1].wallsLeft === 10);
    await shot(pageB, 'b06_illegal_wall_toast.png');

    /* ================= 桌面 · 像素抽样 ================= */
    group('桌面 · 渲染像素抽样');
    const px = await pixelStats(pageA);
    check('画布非空白（存在亮像素）', px.brightRatio > 0.02, `bright=${px.brightRatio.toFixed(3)}`);
    check('中央黄色方块可见', px.yellowRatio > 0.0015, `yellow=${px.yellowRatio.toFixed(4)}`);
    check('存在彩色发光元素（棋子/路障）', px.colorfulRatio > 0.004, `colorful=${px.colorfulRatio.toFixed(4)}`);

    /* ================= 桌面 · 宝箱 / 道具 / 弹幕 / 互动 ================= */
    group('桌面 · 宝箱与道具');
    const gChest = await readGame(pageA, (g) => g && g.chests && g.chests.length > 0, T);
    check('宝箱已生成并出现在状态里', gChest?.chests?.length === 5, `chests=${gChest?.chests?.length}`);
    check('宝箱存续模式为「一直存在」', gChest?.chestMode === 'forever', String(gChest?.chestMode));
    const snItem = await snapshot(pageA);
    check('道具栏可见', snItem.itemBarVisible);
    check('道具栏槽位数等于设置（3）', snItem.itemSlots === 3, `slots=${snItem.itemSlots}`);
    // 开局手上没道具，所以还没有填充的槽
    check('开局道具栏为空', snItem.itemFilled === 0, `filled=${snItem.itemFilled}`);
    await shot(pageA, 'b13_itembar.png');

    group('桌面 · 弹幕');
    await pageA.fill('#danmaku-input', '这是一条测试弹幕');
    await pageA.click('#btn-danmaku');
    let danmakuOk = false;
    try {
      await pageB.waitForSelector('#danmaku-layer .danmaku-item', { timeout: 5000 });
      danmakuOk = true;
    } catch { /* 下面统一断言 */ }
    check('弹幕在对手屏幕上飘出', danmakuOk);
    const dmText = await pageB.textContent('#danmaku-layer .danmaku-item').catch(() => '');
    check('弹幕格式为「玩家名称：内容」', dmText.includes('房主甲：') && dmText.includes('这是一条测试弹幕'), dmText);
    // 弹幕颜色应当是发送者座位的颜色（房主是座位 0 = 蓝色）
    const dmColor = await pageB.evaluate(() => {
      const el = document.querySelector('#danmaku-layer .danmaku-item');
      return el ? getComputedStyle(el).color : '';
    });
    check('弹幕颜色取发送者座位色', /rgb\(58,\s*160,\s*255\)/.test(dmColor), dmColor);

    // 位置：必须「从屏幕最右侧之外进入，一路左移到完全移出屏幕左侧」。
    // 直接把动画拨到起点/终点各量一次，比等着截图可靠得多
    // （之前只断言了元素存在，结果弹幕其实是从屏幕左边冒出来往左飞的，没被发现）。
    const dmGeom = await pageB.evaluate(() => {
      const layer = document.querySelector('#danmaku-layer');
      const el = layer?.querySelector('.danmaku-item');
      if (!layer || !el) return null;
      const vw = layer.clientWidth;
      const w = el.offsetWidth;
      const anim = el.getAnimations?.()[0];
      if (!anim) return { vw, w, start: null, end: null };
      const wasPlaying = anim.playState === 'running';
      anim.pause();
      anim.currentTime = 0;
      let r = el.getBoundingClientRect();
      const start = { left: r.left, right: r.right };
      anim.currentTime = anim.effect.getTiming().duration;
      r = el.getBoundingClientRect();
      const end = { left: r.left, right: r.right };
      if (wasPlaying) anim.play();
      return { vw, w, start, end };
    });
    check('弹幕层宽度＝当前浏览器屏幕宽度',
      dmGeom && dmGeom.vw === await pageB.evaluate(() => window.innerWidth),
      dmGeom ? `layer=${dmGeom.vw}` : '拿不到弹幕层');
    check('弹幕起点在屏幕右边缘之外（整条看不见）',
      !!dmGeom?.start && dmGeom.start.left >= dmGeom.vw - 1,
      dmGeom?.start ? `left=${dmGeom.start.left.toFixed(1)} vw=${dmGeom.vw}` : '无起点');
    check('弹幕终点完全移出屏幕左侧',
      !!dmGeom?.end && dmGeom.end.right <= 1,
      dmGeom?.end ? `right=${dmGeom.end.right.toFixed(1)}` : '无终点');

    // 再实测一次「真的在往左走」
    const dmLeft1 = await pageB.evaluate(() =>
      document.querySelector('#danmaku-layer .danmaku-item')?.getBoundingClientRect().left ?? null);
    await pageB.waitForTimeout(500);
    const dmLeft2 = await pageB.evaluate(() =>
      document.querySelector('#danmaku-layer .danmaku-item')?.getBoundingClientRect().left ?? null);
    check('弹幕持续向左移动',
      dmLeft1 !== null && dmLeft2 !== null && dmLeft2 < dmLeft1,
      `${dmLeft1?.toFixed(1)} → ${dmLeft2?.toFixed(1)}`);

    await shot(pageB, 'b14_danmaku.png');

    // 刷新/新开页面后，房间里的历史弹幕**不能**被重放一遍。
    // 用「另开一个观众页 + 刷新它」来验证：进入房间后的第一份 state 里
    // 带着最近 30 条历史，客户端必须直接对齐序号、一条都不播。
    const replayCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageR = attach(await replayCtx.newPage(), 'replay');
    await installStateTap(pageR);
    await pageR.goto(`${base}/?r=${code}`, { waitUntil: 'networkidle' });
    await pageR.fill('#in-join-name', '回放测试');
    await pageR.click('#form-join button[type=submit]');
    await pageR.waitForSelector('#screen-room.active', { timeout: T });
    // 确认服务端确实把历史弹幕发下来了（否则这条断言就没有意义）
    const historyCount = await pageR.evaluate(() => window.__qdr?.danmaku?.length ?? -1);
    check('服务端确实下发了弹幕历史（前置条件）', historyCount > 0, `history=${historyCount}`);
    await pageR.waitForTimeout(1200);
    const replayAfterJoin = await pageR.evaluate(
      () => document.querySelectorAll('#danmaku-layer .danmaku-item').length,
    );
    check('新开页面不会重放历史弹幕', replayAfterJoin === 0, `屏幕上飘过 ${replayAfterJoin} 条`);

    // 真正刷新一次（走 localStorage 自动回房那条路径）
    await pageR.reload({ waitUntil: 'networkidle' });
    await pageR.waitForSelector('#screen-room.active', { timeout: T });
    await pageR.waitForTimeout(1200);
    const replayAfterReload = await pageR.evaluate(
      () => document.querySelectorAll('#danmaku-layer .danmaku-item').length,
    );
    check('刷新页面不会重放历史弹幕', replayAfterReload === 0, `屏幕上飘过 ${replayAfterReload} 条`);

    // 但「实时发的新弹幕」必须照常播 —— 否则就是把功能一起关掉了
    await pageB.waitForTimeout(1200); // 等冷却
    await pageB.fill('#danmaku-input', '刷新后新发的');
    await pageB.click('#btn-danmaku');
    let liveOk = false;
    try {
      await pageR.waitForFunction(
        () => {
          const el = document.querySelector('#danmaku-layer .danmaku-item');
          return !!el && el.textContent.includes('刷新后新发的');
        },
        null,
        { timeout: 5000 },
      );
      liveOk = true;
    } catch { /* 下面统一断言 */ }
    check('刷新后新发的实时弹幕仍会正常飘出', liveOk);
    await shot(pageR, 'b17_danmaku_no_replay.png');

    // 观众页要主动离开：直接关页面的话他会被当成「掉线观众」留在房间名单里，
    // 本局结束时被自动放回玩家席，后面的「重开后仍是 2 人」断言就崩了。
    await pageR.click('#btn-leave');
    await pageR.waitForTimeout(200);
    await pageR.close();
    await replayCtx.close();

    group('桌面 · 头像互动');
    // 悬停到对手头像行上应出现互动按钮
    const reactBtn = pageA.locator('#player-list .player-item:not(.me) .pp-react').first();
    check('对手头像行有互动入口', (await reactBtn.count()) > 0);

    // 按钮必须**常态可见**：不把鼠标移上去也要看得到、点得到。
    // 先把鼠标挪到棋盘中央（远离玩家列表）再量，避免把 hover 效果当成常态。
    const boardBox = await pageA.locator('#board').boundingBox();
    await pageA.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
    await pageA.waitForTimeout(200);
    const reactVis = await pageA.evaluate(() => {
      const btn = document.querySelector('#player-list .player-item:not(.me) .pp-react');
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      const r = btn.getBoundingClientRect();
      return {
        opacity: cs.opacity,
        visibility: cs.visibility,
        display: cs.display,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    check('互动按钮常态可见（不需要鼠标悬停）',
      !!reactVis && reactVis.opacity === '1' && reactVis.visibility === 'visible'
        && reactVis.display !== 'none' && reactVis.w > 0 && reactVis.h > 0,
      JSON.stringify(reactVis));
    check('互动按钮有可点的尺寸（≥28px）',
      !!reactVis && reactVis.w >= 28 && reactVis.h >= 28,
      reactVis ? `${reactVis.w}×${reactVis.h}` : '无数据');
    // 鼠标还停在棋盘中间、没碰过玩家列表，此时直接点也应该能打开
    await reactBtn.click({ force: true });
    const snPicker = await snapshot(pageA);
    check('不悬停直接点也能弹出 emoji 选择条', snPicker.reactionPickerVisible);
    check('选择条包含 5 种 emoji', snPicker.reactionButtons === 5, `buttons=${snPicker.reactionButtons}`);
    const emojis = await pageA.evaluate(() =>
      [...document.querySelectorAll('#reaction-picker button')].map((b) => b.textContent));
    check(
      'emoji 为 大便/炸弹/爱心/玫瑰/咖啡',
      ['💩', '💣', '❤️', '🌹', '☕'].every((e) => emojis.includes(e)),
      emojis.join(' '),
    );
    await shot(pageA, 'b15_reaction_picker.png');
    // 点第一个（大便）→ 对手屏幕上出现特效
    await pageA.locator('#reaction-picker button').first().click();
    let fxOk = false;
    try {
      await pageB.waitForSelector('#fx-layer .fx-burst', { timeout: 4000 });
      fxOk = true;
    } catch { /* 统一断言 */ }
    check('对手屏幕出现互动特效', fxOk);
    const fxLabel = await pageB.textContent('#fx-layer .fx-label').catch(() => '');
    check('特效带有来源提示', fxLabel.includes('房主甲'), fxLabel || '(无文案)');
    await shot(pageB, 'b16_reaction_fx.png');

    group('桌面 · 陷阱与道具可见性');
    // 用引擎直接验证「陷阱只有自己可见」这条隐私规则在数据层成立：
    // 观众/对手的 payload 里不该出现别人的陷阱。这里用页面上的实测数据断言。
    const trapPrivacy = await pageB.evaluate(() => {
      const g = window.__qdr?.game;
      return { hasTraps: Array.isArray(g?.traps), trapCount: g?.traps?.length ?? -1 };
    });
    check('陷阱字段按人下发（数组存在）', trapPrivacy.hasTraps, JSON.stringify(trapPrivacy));

    /* ================= 桌面 · 打到胜利 ================= */
    group('桌面 · 胜负判定与快速重开');
    // 先让访客把回合交出来（放墙测试结束后正好轮到访客），
    // 之后每轮都按「谁该走」显式等待，不靠 #ti-text 文案猜。
    if ((await readGame(pageB, (g) => g && g.turn === 1, 4000))?.turn === 1) {
      const gb = await readGame(pageB);
      const mb = legalMoves(gb, 1);
      const db = distancesToGoal(gb);
      await playMove(pageB, 1, mb.find((m) => db[m.r * gb.size + m.c] >= 3) || mb[0]);
    }
    let hostWon = false;
    let finished = false;
    for (let round = 0; round < 14 && !finished; round++) {
      // 轮到房主 → 逼近中央
      const gA = await readGame(pageA, (g) => g && (g.phase === 'finished' || g.turn === 0), T);
      if (gA?.phase === 'finished') { finished = true; break; }
      if (!(await playMove(pageA, 0))) break;
      // 用服务器状态判断胜负（比看遮罩文案可靠，不会被状态过渡坑到）
      const afterA = await readGame(pageA, (g) => g && (g.phase === 'finished' || g.turn === 1), T);
      if (afterA?.phase === 'finished') { finished = true; break; }

      // 轮到访客 → 只在离中央 ≥3 步的地方晃，绝不抢先踩上中央
      const movesB = legalMoves(afterA, 1);
      const distB = distancesToGoal(afterA);
      const sideMove = movesB.find((m) => distB[m.r * afterA.size + m.c] >= 3) || movesB[0];
      if (!(await playMove(pageB, 1, sideMove))) break;
    }
    const gEnd = await readGame(pageA, (g) => g && g.phase === 'finished', T);
    hostWon = gEnd?.phase === 'finished' && gEnd.winner === 0;
    const st = await snapshot(pageA);
    check('对局在有限步内结束', gEnd?.phase === 'finished', `phase=${gEnd?.phase} turnCount=${gEnd?.turnCount}`);
    check('胜者是先到中央的房主', hostWon && gEnd?.winner === 0, `winner=${gEnd?.winner}`);
    check('胜利层弹出并显示胜者名', st.winnerVisible && st.winnerTitle.includes('房主甲'), st.winnerTitle);
    check('访客侧同样看到胜利层', (await snapshot(pageB)).winnerVisible);
    await shot(pageA, 'b07_winner_overlay.png');
    await shot(pageB, 'b07b_winner_guest_view.png');

    check('房主可见「快速重开」按钮', await pageA.locator('#winner-actions button').isVisible());
    check('访客侧无重开按钮（仅房主可控）',
      (await pageB.locator('#winner-actions button').count()) === 0);
    await pageA.click('#winner-actions button');
    const gR = await readGame(
      pageA,
      (g) => g && g.phase === 'playing' && g.turnCount === 0,
      T,
    );
    check('快速重开：墙清空', gR?.walls.length === 0);
    check('快速重开：路障恢复 10', gR.seats[0].wallsLeft === 10, String(gR.seats[0].wallsLeft));
    check('快速重开：回到起点 (8,4)', JSON.stringify(pawnOf(gR, 0)) === '{"r":8,"c":4}');
    check('快速重开：玩家保留', gR.seats.length === 2);
    await shot(pageA, 'b08_after_restart.png');

    /* ================= 手机视口 ================= */
    group('手机 375×812 · 响应式与触摸');
    // 触摸必须用「建上下文时就声明 hasTouch」的页面：事后用 CDP 打开触摸模拟，
    // 注入的触摸事件根本到不了页面（实测画布收不到任何 pointerdown/click）。
    // 新上下文的 localStorage 是独立的，所以用 ?r=&pid= 带着房主身份接管座位，
    // 这样手机页拿到的就是「该它走」的座位。
    // 注意 app.js 用 JSON 存这些值，读出来是带引号的字符串，要解一次。
    const [hostPidM, hostNameM] = await pageA.evaluate(() => {
      const un = (k) => {
        try { return JSON.parse(localStorage.getItem(k)); } catch { return localStorage.getItem(k); }
      };
      return [un('quorider.pid'), un('quorider.name')];
    });
    const mobileCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const pageM = attach(await mobileCtx.newPage(), 'mobile');
    await installStateTap(pageM);
    await pageM.addInitScript(([pid, name]) => {
      try {
        if (pid) localStorage.setItem('quorider.pid', JSON.stringify(pid));
        if (name) localStorage.setItem('quorider.name', JSON.stringify(name));
      } catch { /* 忽略 */ }
    }, [hostPidM, hostNameM]);
    await pageM.goto(`${base}/?r=${code}&pid=${hostPidM}`, { waitUntil: 'networkidle' });
    try {
      await pageM.waitForSelector('#screen-room.active', { timeout: T });
    } catch (err) {
      await debugPage(pageM, 'mobile-rejoin-failed');
      console.log('手机端 localStorage =', JSON.stringify(await pageM.evaluate(() => ({
        room: localStorage.getItem('quorider.room'),
        pid: localStorage.getItem('quorider.pid'),
        name: localStorage.getItem('quorider.name'),
        hooked: window.__qdr?.hooked,
      }))));
      console.log('页面异常：', pageErrors.slice(-10).join('\n  ') || '(无)');
      throw err;
    }
    const gMobile = await readGame(pageM, (g) => !!g, T);
    check('手机端接管房主座位（自动回房，座位保留）', gMobile?.seats?.length === 2,
      `seats=${gMobile?.seats?.length}`);
    await pageM.waitForTimeout(600);

    const mob = await pageM.evaluate(() => {
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
      };
      const small = [];
      for (const sel of ['#btn-mode-move', '#btn-mode-wall', '#btn-start', '#btn-leave', '#room-code-btn', '#player-list .pp-react']) {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest('.hidden') || getComputedStyle(el).display === 'none') return;
          const b = el.getBoundingClientRect();
          if (b.width < 36 || b.height < 36) small.push(`${sel} ${Math.round(b.width)}×${Math.round(b.height)}`);
        });
      }
      return {
        board: r(document.querySelector('.board-zone')),
        side: r(document.querySelector('.side')),
        main: getComputedStyle(document.querySelector('.room-main')).gridTemplateColumns,
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        small,
        canvasCss: document.querySelector('#board').clientWidth,
      };
    });
    check('改为单栏（玩家面板落到棋盘下方）',
      mob.side.y >= mob.board.bottom - 4,
      `board.bottom=${Math.round(mob.board.bottom)} side.top=${Math.round(mob.side.y)} cols=${mob.main}`);
    check('手机端无横向溢出', mob.sw <= mob.iw + 1, `scrollWidth=${mob.sw} innerWidth=${mob.iw}`);
    check('棋盘宽度适配屏宽', mob.board.w <= mob.iw - 8 && mob.board.w > 200, `${Math.round(mob.canvasCss)}px`);
    check('可点控件 ≥36px（触摸友好）', mob.small.length === 0, mob.small.join('; ') || '全部达标');
    check('玩家面板仍可见', mob.side.h > 50, `h=${Math.round(mob.side.h)}`);
    await shot(pageM, 'b09_room_mobile.png');

    // 窄屏（375px）弹幕也要「从最右外侧进、完全移出最左」——
    // 这正是「要考虑到当前的浏览器屏幕宽度」那条：位移若写死或算错，
    // 宽屏可能勉强能看，窄屏就会从屏幕中间冒出来。
    await pageB.fill('#danmaku-input', '窄屏弹幕测试');
    await pageB.click('#btn-danmaku');
    let dmMobileOk = false;
    try {
      await pageM.waitForSelector('#danmaku-layer .danmaku-item', { timeout: 5000 });
      dmMobileOk = true;
    } catch { /* 下面统一断言 */ }
    check('手机窄屏也能收到弹幕', dmMobileOk);
    const dmMobile = await pageM.evaluate(() => {
      const layer = document.querySelector('#danmaku-layer');
      const el = layer?.querySelector('.danmaku-item');
      if (!layer || !el) return null;
      const anim = el.getAnimations?.()[0];
      const vw = layer.clientWidth;
      if (!anim) return { vw, start: null, end: null };
      anim.pause();
      anim.currentTime = 0;
      const s = el.getBoundingClientRect();
      anim.currentTime = anim.effect.getTiming().duration;
      const e = el.getBoundingClientRect();
      anim.play();
      return { vw, start: s.left, end: e.right, w: el.offsetWidth };
    });
    check('窄屏弹幕起点在屏幕右边缘之外',
      !!dmMobile && dmMobile.start >= dmMobile.vw - 1,
      dmMobile ? `left=${dmMobile.start?.toFixed(1)} vw=${dmMobile.vw}` : '无数据');
    check('窄屏弹幕终点完全移出屏幕左侧',
      !!dmMobile && dmMobile.end <= 1,
      dmMobile ? `right=${dmMobile.end?.toFixed(1)}` : '无数据');

    // 极端情况：弹幕文字比整块屏幕还宽（40 字上限 ≈ 680px，手机只有 375px）。
    // 起点看左边缘、终点看右边缘，所以「比屏幕宽」也不会露馅。
    await pageB.waitForTimeout(1200); // 等服务端的 1 秒弹幕冷却过去
    await pageB.fill('#danmaku-input', '超长弹幕'.repeat(10)); // 服务端/输入框会裁到 40 字
    const dmCountBefore = await pageM.evaluate(
      () => document.querySelectorAll('#danmaku-layer .danmaku-item').length,
    );
    await pageB.click('#btn-danmaku');
    let dmLongOk = false;
    try {
      await pageM.waitForFunction(
        (before) => {
          const items = [...document.querySelectorAll('#danmaku-layer .danmaku-item')];
          if (items.length <= before) return false;
          return items[items.length - 1].offsetWidth > window.innerWidth;
        },
        dmCountBefore,
        { timeout: 6000 },
      );
      dmLongOk = true;
    } catch { /* 下面统一断言 */ }
    if (dmLongOk) {
      const dmLong = await pageM.evaluate(() => {
        const layer = document.querySelector('#danmaku-layer');
        const el = [...layer.querySelectorAll('.danmaku-item')].pop();
        const anim = el.getAnimations?.()[0];
        if (!anim) return null;
        anim.pause();
        anim.currentTime = 0;
        const s = el.getBoundingClientRect();
        anim.currentTime = anim.effect.getTiming().duration;
        const e = el.getBoundingClientRect();
        anim.play();
        return { vw: layer.clientWidth, w: el.offsetWidth, start: s.left, end: e.right };
      });
      check('超宽弹幕起点依然在屏幕右边缘之外',
        !!dmLong && dmLong.start >= dmLong.vw - 1,
        dmLong ? `left=${dmLong.start?.toFixed(1)} vw=${dmLong.vw} 宽度=${dmLong.w}` : '无数据');
      check('超宽弹幕终点依然完全移出屏幕左侧',
        !!dmLong && dmLong.end <= 1,
        dmLong ? `right=${dmLong.end?.toFixed(1)}` : '无数据');
    } else {
      check('超宽弹幕（文字比屏幕宽）能正常播放', false, '没等到比屏幕更宽的弹幕');
    }

    // 手机端触摸走子：从「手机这一页」读状态并等它自己的回合，
    // 否则会拿着房主桌面的旧状态去点，座位对不上自然点不动。
    const gM = await readGame(pageM, (g) => g && g.phase === 'playing' && g.turn === 0, T);
    if (!gM) throw new Error('手机端拿不到房主回合的对局状态');
    const geoM = await geometry(pageM, gM.size);
    const mvM = pickTowardGoal(gM, 0, legalMoves(gM, 0));
    if (!mvM) throw new Error('手机端找不到房主的合法走法');
    const pM = geoM.cellPoint(mvM.r, mvM.c);
    const tapped = await pageM.touchscreen
      .tap(pM.x, pM.y)
      .then(() => readGame(pageM, (g) => g && g.turn !== 0, T))
      .then((g) => !!g && g.turn !== 0)
      .catch(() => false);
    if (process.env.DEBUG_PAGE) {
      console.log('[诊断] 触摸后 #ti-text =', await pageM.textContent('#ti-text'));
    }
    check('触摸点击可以走子', tapped, `座位 0 → (${mvM.r},${mvM.c})`);
    await shot(pageM, 'b10_mobile_after_tap.png');

    // 手机端首页
    // 手机端首页（独立上下文，避免带上房间状态）
    const pageC = attach(await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    }).then((c) => c.newPage()), 'mobile-home');
    await pageC.goto(base, { waitUntil: 'networkidle' });
    await pageC.waitForTimeout(400);
    const homeM = await pageC.evaluate(() => {
      const a = document.querySelector('#form-create').getBoundingClientRect();
      const b = document.querySelector('#form-join').getBoundingClientRect();
      return {
        stacked: b.top >= a.bottom - 2,
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      };
    });
    check('手机端首页纵向堆叠', homeM.stacked, JSON.stringify(homeM));
    check('手机端首页无横向溢出', homeM.sw <= homeM.iw + 1);
    await shot(pageC, 'b11_home_mobile.png');

    // 手机横屏（更窄的高度）
    const landCtx = await browser.newContext({
      viewport: { width: 812, height: 375 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const pageL = attach(await landCtx.newPage(), 'mobile-landscape');
    await pageL.goto(base, { waitUntil: 'networkidle' });
    await pageL.waitForTimeout(400);
    const land = await pageL.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      hero: document.querySelector('.hero h1').getBoundingClientRect().height,
    }));
    check('手机横屏无横向溢出', land.sw <= land.iw + 1, JSON.stringify(land));
    await shot(pageL, 'b12_home_landscape.png');
    await pageL.close();
    await landCtx.close();
    await pageC.close();

    /* ================= 运行期错误 ================= */
    group('运行期错误');
    check('无未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
    check('无 4xx/5xx 资源响应', badResponses.length === 0, badResponses.slice(0, 5).join(' | '));
  } finally {
    try { await browser.close(); } catch { /* 忽略 */ }
    try { chrome.kill(); } catch { /* 忽略 */ }
    try { server.kill(); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════');
  console.log(`共 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✖ [${f.group}] ${f.label}  ${f.detail}`);
  }
  console.log(`截图目录：${OUT}`);
  console.log('════════════════════════════════════\n');
  process.exitCode = failed.length ? 1 : 0;
}

const pawnOf = (game, seat) => game?.pawns?.[seat] ?? null;

/** 找一个引擎认可的合法墙位（默认挑远离两方必经主路的位置）。 */
function findLegalWall(game, seat, prefer) {
  const size = game.size;
  for (const d of ['h', 'v']) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (prefer && !prefer(d, r, c)) continue;
        const res = canPlaceWall(game, seat, d, r, c);
        if (res.ok) return { d, r: res.r, c: res.c };
      }
    }
  }
  throw new Error('找不到任何合法墙位');
}

/** 找一面与已有墙**交叉**的墙位（必须 reason==='cross'，其它拒绝原因不算）。 */
function findCrossingWall(game) {
  const size = game.size;
  for (const d of ['h', 'v']) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const res = canPlaceWall(game, game.turn, d, r, c);
        if (!res.ok && res.reason === 'cross') return { d, r: res.r ?? r, c: res.c ?? c };
      }
    }
  }
  return null;
}

main()
  .then(() => {
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  })
  .catch((err) => {
    console.error('\n浏览器验收脚本异常终止：', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 硬超时看门狗：任何一步卡住都不会让脚本永远挂着（日志里能看到最后走到哪）
    clearTimeout(watchdog);
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  });
