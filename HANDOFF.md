# 路障棋 Quorider — 交接文档

> 更新时间：2026-09-23（第二次交接）
> 状态：**功能、协议、浏览器实机、部署材料全部就绪**。
> 剩余工作只有一项：**人眼看截图做风格微调**（工具没有视觉能力，做不到这一步）。

---

## 1. 项目目标（对应需求逐条）

| # | 需求 | 状态 | 实现位置 |
|---|------|------|----------|
| 1 | 网页端游戏，方便在服务器上快速部署 | ✅ | 零 npm 依赖，`node server.js` 即起；systemd / nginx / Docker / compose 模板见 `deploy/` |
| 2 | 最多 4 人对战；创建房间生成邀请码，他人凭码加入 | ✅ | `src/rooms.js` 邀请码机制（5 位去混淆字符）；`test/ws-flow.test.js` 已验证 |
| 3 | 房主可设置房间信息（棋盘大小等） | ✅ | 大厅/结束后可改：棋盘 7/9/11/13、人数上限、每人路障数、回合限时、中央方块尺寸 |
| 4 | 基础 Quoridor 规则 + 多人改为“最先触碰中央方块者获胜” | ✅ | `src/engine.js`：走子/跳跃/斜走/放墙；目标为中央格，踩上即胜 |
| 5 | 放墙不能封死玩家、不能封死中央方块 | ✅ | `canPlaceWall` 每次放墙做 BFS 连通性校验（`seal-player` / `seal-goal`） |
| 6 | 房主快速重开对局 | ✅ | `t:'restart'`，保留玩家与设置直接开新局 |
| 7 | 前端风格参照参考图（深夜底、发光墙、发光棋子、黄色中央块） | ✅ 已实现 Canvas 霓虹风格，**像素抽样已验证**（中央黄块 / 发光元素确实画出来了）；**主观风格对照仍需人眼** | `public/board.js` |
| 8 | 响应式布局，支持手机与电脑 | ✅ 桌面 1440×900 与手机 375×812 均已实机验证（单栏、无横向溢出、触摸目标 ≥36px、触摸走子、横屏） | `public/style.css` |

## 2. 当前进度

```
✅ 规则引擎（16 项单测全绿）
✅ 零依赖 WebSocket 服务层 + 房间管理（17 项测试全绿，含端到端协议 + 连接接管回归）
✅ 静态文件服务 + 健康检查 /healthz
✅ 前端页面骨架 / 样式 / 棋盘渲染 / 交互逻辑
✅ 浏览器实机验收 53 项全绿（桌面完整对局 + 手机响应式/触摸）
✅ 部署材料：README、systemd unit、nginx 反代、Dockerfile、docker-compose、env 示例
⬜ 人眼对照参考图微调视觉（发光强度、配色饱和度）—— 截图已备好，见第 6 节
```

测试结论（实测）：

- `npm test` → **17/17 通过**（约 0.4s）
- `npm run test:browser` → **53/53 通过**（真实 Chromium，约 40s）

两套测试的覆盖范围见第 7 节。

## 3. 快速上手

```bash
# 开发机 / 服务器（Node ≥ 18，零依赖，无需 npm install）
node server.js          # 默认监听 0.0.0.0:3000
PORT=8080 node server.js   # 换端口
HOST=127.0.0.1 node server.js  # 只监听本机（配反向代理时）

npm test                # 规则单测 + 端到端协议测试
npm run test:browser    # 浏览器实机验收（需另开终端先跑 node server.js）
npm run dev             # 开发模式（文件变更自动重启）
```

直接浏览器打开 `http://服务器IP:3000`。地址栏参数：

- `?r=ABCDE` 预填邀请码
- `?r=ABCDE&pid=<身份>` 用指定身份回座（换设备/手机接管，见 5.5）

## 4. 目录结构

```
quorider/
├── server.js              # HTTP 静态服务 + WS 挂载 + 消息分发 + 定时器
├── package.json           # type: module，零依赖
├── README.md              # 面向使用者的说明（玩法/部署/排障）
├── Dockerfile             # node:22-alpine，构建期不装依赖，非 root 运行
├── docker-compose.yml     # 一键起（含可选 nginx 段）
├── .dockerignore / .gitignore
├── deploy/
│   ├── quorider.service   # systemd unit（DynamicUser + 严格沙箱）
│   ├── nginx.conf         # nginx 反代（含 WS 升级头、长连接超时）
│   └── env.example        # PORT / HOST 等环境变量示例
├── src/
│   ├── engine.js          # ★ 规则引擎（浏览器与 Node 共用，纯数据纯函数）
│   ├── ws.js              # RFC6455 最小实现（帧解析、心跳、分片）
│   └── rooms.js           # 房间/座位/邀请码/限时托管/广播
├── public/
│   ├── index.html         # 首页 + 房间页两屏
│   ├── style.css          # 深色霓虹主题 + 响应式
│   ├── board.js           # Canvas 棋盘渲染（发光格/墙/棋子/中央黄块）
│   ├── app.js             # 前端状态机、WS 客户端、交互
│   └── favicon.svg        # 站点图标
├── test/
│   ├── engine.test.js     # 规则单测（16 项）
│   ├── ws-flow.test.js    # 端到端协议测试（17 项，真起服务器进程）
│   └── browser-e2e.mjs    # 浏览器实机验收（53 项，真实 Chromium）
└── gui-test-screenshots/  # 实机截图（不入库，人眼验收用）
```

浏览器里的 `/shared/engine.js` 由服务器把 `src/engine.js` 直出，保证两端同一份规则。

## 5. 关键设计（接手者必读）

### 5.1 坐标系统（engine.js 头部有完整注释）
- 格位 `(r, c)`，0..size-1，size 强制奇数（保证中央格唯一）。
- 横墙 `h[r][c]`：第 r 条水平线上半格，挡住 (r-1,c)↔(r,c)；一面横墙同时点亮 `h[r][c]` 与 `h[r][c+1]`。
- 竖墙 `v[r][c]`：第 c 条竖线上半格，挡住 (r,c-1)↔(r,c)；一面竖墙点亮 `v[r][c]` 与 `v[r+1][c]`。
- 另有 `hs`/`vs` 两个「墙根」矩阵记录每面墙的起始槽——**交叉判定必须用墙根而非半格**（半格 v[r][c] 可能来自起点 r 或 r-1 的墙，后者只是端点接触=合法 T 形，参考图里大量 T 形墙）。这是踩过的坑，勿改回。
- 合法范围：横墙 r∈[1,size-1],c∈[0,size-2]；竖墙 r∈[0,size-2],c∈[1,size-1]。

### 5.2 核心规则
- 走子：直走 1 格 / 正前方有对手可跳 2 格 / 跳位被挡可斜走（有转角墙判定）。
- 放墙：占用/交叉/封死三重校验；`canPlaceWall` 试放→BFS→回滚，返回中文原因码 `seal-player`/`seal-goal` 等。
- 胜利：踏上中央格即胜（`goalSize=1` 单格；`=2` 时 2×2）。
- 超时托管：`turnTimer` 秒内未行动自动走最接近中央的合法步；当前玩家掉线时倒计时暂停。

### 5.3 通信协议（JSON over WS，`t` 字段路由）
- C→S：`create`(pid,name,settings) / `join`(code,pid,name) / `leave` / `settings` / `start` / `restart` / `move`(to:{r,c}) / `wall`(wall:{d,r,c}) / `kick`(pid) / `ping`
- S→C：`state`（全量状态广播：房间码、玩家、settings、game、deadline、serverNow、log）/ `error`(msg) / `kicked` / `replaced`（同账号别处登录）
- ⚠️ **帧形状容易看错**：广播帧是 `{ t:'state', game:{...}, phase, players, ... }`，
  这里 `t` 是**消息类型字符串**；而 `game` 内部的 `t` 才是**回合序号（数字）**。
  写测试/工具时按 `v.t === 'state' && v.game` 判定，别按 `typeof t === 'number'`。
- 玩家身份：浏览器 localStorage 存 `pid`（uuid，注意 app.js 用 JSON 存，读出来带引号）。
- 观众：对局中房间用新 pid 加入自动成为观众（只读）。

### 5.4 前端结构
- `app.js` 持全部 UI 状态机；`board.js` 只画不响应（事件由 app.js 绑定后在画布命中测试）。
- 交互：走子模式点高亮格；放墙模式（操作条切换）悬停出幽灵墙，非法显示红色 + 原因 toast。
- 倒计时：客户端用 `serverNow` 与本地时钟做偏差校准，250ms 刷新。
- 断线重连：指数退避自动重连 + 自动回房（localStorage 存 roomCode）。
- 显隐统一用 `classList.toggle('hidden')`，CSS 里必须保留全局 `.hidden { display:none !important }`
  （只写 `.overlay.hidden` 会导致其它元素的 hidden 完全不生效 —— 这是修过的真实 bug，见 6.1）。

### 5.5 座位接管（`?pid=`）
`init()` 里读 `?pid=`：若与本地身份不同则改写 localStorage；只要 URL 同时带了 pid 和房间码，
就在 WebSocket 打开时用这个身份立刻 `join`。用途：同一局从电脑换到手机接着下。
服务端对应逻辑在 `server.js` 的 `bindRoom`（见 6.2 的坑）。

## 6. 本次修掉的问题（避免复发）

### 6.1 前端：`.hidden` 没有全局样式（**功能性 bug**）
`app.js` 一直在用 `classList.add('hidden')` 隐藏「开始游戏 / 快速重开 / 设置表单 / 只读提示」，
但 CSS 里只有 `.overlay.hidden { display:none }`，其它元素加了 class 也照样显示。
后果：**访客也能看到并点到「开始游戏」**（服务端会拒绝，但 UI 是错的）。
修复：`public/style.css` 增加全局 `.hidden { display: none !important; }`。
浏览器测试里 `访客看不到「开始游戏」` 这条断言就是为此加的。

### 6.2 服务端：同账号新连接接管座位会把人踢出房间（**功能性 bug**）
`bindRoom` 里 `player.conn.destroy()` 会**同步**触发 `onClose`，而此时 `player.conn` 还指着旧连接，
于是 `onClose` 把玩家当成掉线/退房从 `room.players` 里摘掉：
新连接**永远收不到 state**，房间还少一个人（大厅里直接变成「至少需要 2 名玩家才能开始」）。
这条路径就是「刷新/换设备/手机接管」，属于必踩。
修复：顶掉旧连接前先打 `old.replaced = true`，`onClose` 遇到 `conn.replaced` 直接 return。
回归测试：`test/ws-flow.test.js` 步骤 13b（同 pid 再开一条连接，断言新连接立刻拿到 state、
两人都还在、房主侧仍看到 2 名参赛者）。

### 6.3 手机端触摸目标偏小 + 缺 favicon
邀请码按钮高度只有 36px，抬到 `min-height: 40px`；
补 `public/favicon.svg` 并让 `/favicon.ico` 也返回它（消掉浏览器自动请求的 404）。

## 7. 测试说明

### 7.1 `npm test`（必跑，17 项）
- `test/engine.test.js`（16 项）：走子/跳跃/斜走、墙的占用与交叉、封死判定、中央获胜、
  四人轮转、路障数量、坐标吸附。
- `test/ws-flow.test.js`（1 个大用例，内部 20+ 条断言）：真起服务器进程走完整流程——
  建房 → 邀请码加入 → 非法邀请码 → 非房主开局被拒 → 开始 → 走子 → 放墙 → 交叉墙被拒 →
  观众进入与只读 → 掉线 → 同身份重连 → **同 pid 连接接管** → 快速重开 → 踩中央获胜。

### 7.2 `npm run test:browser`（可选，53 项）
`test/browser-e2e.mjs`，真实 Chromium，自己起一个随机端口的测试服务器。覆盖：

- 首页两栏布局、无横向溢出
- 建房 → 深链加入 → 开局 → **真实鼠标点击**走完整局 → 胜利层 → 快速重开
- 合法放墙成功、交叉墙被引擎判定非法并弹中文原因、非法走子不生效
- **canvas 像素抽样**：确认中央黄块、发光棋子/路障真的画出来了（防止"白画布"）
- 桌面 1440×900；手机 375×812（单栏、无溢出、控件 ≥36px、**触摸走子**）；手机横屏
- 全程收集 console 报错 / 未捕获异常 / 4xx 资源（发现 favicon 404 就是这么来的）

截图落在 `gui-test-screenshots/`（`b01..b12`）。
可用环境变量：`QDR_CHROME` 指定浏览器路径、`QDR_PW` 指定 playwright-core 目录、
`QDR_CDP_PORT` / `QDR_PW_PORT` / `QDR_TIMEOUT_MS`。加 `DEBUG_PAGE=1` 会打印每个 WS 帧、
页面 console 和失败时的 DOM 快照，排障很好用。

`test:browser` 需要 `playwright-core`（开发期可选依赖，服务器部署不需要）：
```bash
npm i -D playwright-core && npx playwright install chromium
```
脚本会依次从 `QDR_PW` → 仓库 `node_modules` → 常见相邻检出里找 playwright-core。

## 8. 开发环境注意点（踩过的坑）

1. **浏览器测试用 CDP over TCP，不要用 `--remote-debugging-pipe`**。
   脚本自己 `spawn` 一个 Chrome（`--remote-debugging-port`）再用
   `chromium.connectOverCDP()` 接管。原因见下条。
2. **在受限沙箱里 Chrome 根本起不来**：它的 IPC 走命名管道，
   受限模式会以 `OpenProcess: 拒绝访问 (0x5)` 直接崩掉。
   同理 `node --test` 和任何 `spawn(..., {stdio:'pipe'})` 也可能 EPERM。
   跑测试/浏览器验收时请给足权限。
3. **触摸必须用「建上下文时就声明 `hasTouch: true`」的页面**。
   事后用 CDP `Emulation.setTouchEmulationEnabled` 打开触摸模拟，
   注入的触摸事件**到不了页面**（实测画布收不到任何 pointerdown/click，
   而 `navigator.maxTouchPoints` 却是 1）。
4. **`connectOverCDP` 拿到的页面是「默认上下文」**，
   同一个上下文里的多个页面**共享 localStorage** → 会共用同一个 `pid`，
   第 2 个页面 join 时会顶掉第 1 个，整个流程崩掉。
   多个"玩家"必须各自 `browser.newContext()`。
5. **别去包装 `window.WebSocket` 做状态嗅探**：真实 WebSocket 的 `prototype` 是
   non-writable，`Object.assign(wrapper, OrigWS)` 会抛 TypeError，
   直接把页面搞坏（表现为 `WebSocket is not a constructor`）。
   测试里改成 hook `JSON.parse`（见 `installStateTap`），页面行为零改动。
6. 开发期排障命令：
   ```bash
   curl http://localhost:3000/healthz
   taskkill //F //IM chrome.exe     # 强杀残留的无头 Chrome（慎用）
   ```
7. 3000 端口可能有一个常驻服务器进程（日志 `server.log`）。**改完代码必须重启它**，
   否则页面拿到的是旧 JS。可用下面命令确认服务器发的就是当前文件：
   ```bash
   curl -s http://localhost:3000/app.js | sha256sum   # 和本地 public/app.js 对比
   ```
8. **部署材料已写好，但 Docker 没有本机验证过**（这台机器没有 docker）。
   首次上服务器时请先在旁边跑一遍 `docker compose up -d --build` 确认。

## 9. 剩余工作 / 建议排期

1. **人眼对照参考图微调视觉**（唯一剩下的正事）：打开 `gui-test-screenshots/` 里的
   `b05_wall_placed.png`、`b07_winner_overlay.png`、`b09_room_mobile.png` 等，
   与参考图比发光强度、配色饱和度、圆角大小。调参集中在：
   - 颜色：`src/engine.js` 的 `COLORS`
   - 棋盘/墙体/棋子绘制：`public/board.js`（`_drawWall` 三层霓虹、`_drawPawn` 光晕半径）
   - 主题变量：`public/style.css` 顶部的 `--*` 变量
   像素级"有没有画出来"已经有自动化断言兜底，这一步纯粹是审美。
2. 服务器上实跑一次 Docker / systemd。
3. 如有余力：房间内聊天、掉线玩家由简单 AI 托管走子（`pickAutoMove` 已有，
   接上"离线即托管"即可）。
