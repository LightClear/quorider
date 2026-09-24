# 路障棋 Quorider — 交接文档

> 更新时间：2026-09-23（第三次交接）
> 状态：**功能、协议、浏览器实机、部署材料全部就绪**。
> 剩余工作只有一项：**人眼看截图做风格微调**（工具没有视觉能力，做不到这一步）。

---

## 1. 项目目标（对应需求逐条）

| # | 需求 | 状态 | 实现位置 |
|---|------|------|----------|
| 1 | 网页端游戏，方便在服务器上快速部署 | ✅ | 零 npm 依赖，`node server.js` 即起；systemd / nginx / Docker / compose 模板见 `deploy/` |
| 2 | 最多 4 人对战；创建房间生成邀请码，他人凭码加入 | ✅ | `src/rooms.js` 邀请码机制（5 位去混淆字符）；`test/ws-flow.test.js` 已验证 |
| 3 | 房主可设置房间信息（棋盘大小等） | ✅ | 大厅/结束后可改：棋盘 7/9/11/13、人数上限、每人路障数、回合限时、中央方块尺寸、宝箱数量/存续/产出道具、道具栏上限 |
| 4 | 基础 Quoridor 规则 + 多人改为“最先触碰中央方块者获胜” | ✅ | `src/engine.js`：走子/跳跃/斜走/放墙；目标为中央格，踩上即胜 |
| 5 | 放墙不能封死玩家、不能封死中央方块 | ✅ | `canPlaceWall` 每次放墙做 BFS 连通性校验（`seal-player` / `seal-goal`） |
| 6 | 房主快速重开对局 | ✅ | `t:'restart'`，保留玩家与设置直接开新局 |
| 7 | 前端风格参照参考图（深夜底、发光墙、发光棋子、黄色中央块） | ✅ 已实现 Canvas 霓虹风格，**像素抽样已验证**；**主观风格对照仍需人眼** | `public/board.js` |
| 8 | 响应式布局，支持手机与电脑 | ✅ 桌面 1440×900 与手机 375×812 均已实机验证（单栏、无横向溢出、触摸目标 ≥36px、触摸走子、横屏） | `public/style.css` |
| 9 | **修复：一局结束后新加入的人应作为玩家而不是观众** | ✅ | `src/rooms.js` `_canSit()` / `_promoteWaitingSpectators()`；`test/ws-flow.test.js` 有专门用例 |
| 10 | **宝箱功能**（随机格生成、随机道具、可配产出、一次性/常驻、每人每箱一次） | ✅ | `engine.js` `placeChests/openChestAt`；设置项见 `normalizeSettings` |
| 11 | **道具：随机传送 / 破墙 / 陷阱** | ✅ | `engine.js` `randomTeleportCell/removeWall/applyPlaceTrap`；`rooms.js` `useItem()` |
| 12 | **弹幕**（右侧飘入、`玩家名称：内容`、发送者颜色） | ✅ | `rooms.js` `danmaku()`；`app.js` `pushDanmaku()` |
| 13 | **头像互动**（💩💣❤️🌹☕、对方屏幕特效、有 CD） | ✅ | `rooms.js` `react()`；`app.js` `showReaction()/burstEmoji()` |

## 2. 当前进度

```
✅ 规则引擎（32 项单测全绿）
✅ 房间管理层（23 项确定性单测全绿）
✅ 零依赖 WebSocket 服务层 + 房间管理（5 项端到端测试全绿，含宝箱/道具/弹幕/互动/观众回归）
✅ 静态文件服务 + 健康检查 /healthz
✅ 前端页面骨架 / 样式 / 棋盘渲染 / 交互逻辑
✅ 浏览器实机验收 83 项全绿（桌面完整对局 + 宝箱/道具栏 + 弹幕几何 + 互动 + 手机响应式/触摸）
✅ 部署材料：README、systemd unit、nginx 反代、Dockerfile、docker-compose、env 示例
⬜ 人眼对照参考图微调视觉（发光强度、配色饱和度）—— 截图已备好，见第 6 节
```

测试结论（实测）：

- `npm test` → **60/60 通过**（约 0.5s）
- `npm run test:browser` → **83/83 通过**（真实 Chromium，约 40s）

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
│   │                      #   走子/放墙/宝箱/道具(传送·破墙·陷阱)/陷阱跳回合/超时托管
│   ├── ws.js              # RFC6455 最小实现（帧解析、心跳、分片）
│   └── rooms.js           # 房间/座位/邀请码/限时托管/私有背包/弹幕/互动/逐人广播
├── public/
│   ├── index.html         # 首页 + 房间页两屏（含道具栏/弹幕条/互动选择条/特效层）
│   ├── style.css          # 深色霓虹主题 + 响应式 + 弹幕与特效动画
│   ├── board.js           # Canvas 棋盘渲染（发光格/墙/棋子/中央黄块/宝箱/陷阱）
│   ├── app.js             # 前端状态机、WS 客户端、交互、道具/弹幕/互动
│   └── favicon.svg        # 站点图标
├── test/
│   ├── engine.test.js     # 规则单测（32 项）
│   ├── rooms.test.js      # 房间管理层单测（23 项）
│   ├── ws-flow.test.js    # 端到端协议测试（5 个用例，真起服务器进程）
│   └── browser-e2e.mjs    # 浏览器实机验收（83 项，真实 Chromium）
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
- C→S：`create`(pid,name,settings) / `join`(code,pid,name) / `leave` / `settings` / `start` / `restart`
  / `move`(to:{r,c}) / `wall`(wall:{d,r,c}) / `item`(kind,data) / `danmaku`(text)
  / `react`(target,kind) / `kick`(pid) / `ping`
- S→C：`state`（全量状态广播：房间码、玩家、settings、game、deadline、serverNow、log、danmaku）/
  `error`(msg) / `kicked` / `replaced`（同账号别处登录）/ `danmaku`(entry)
- ⚠️ **帧形状容易看错**：广播帧是 `{ t:'state', game:{...}, phase, players, ... }`，
  这里 `t` 是**消息类型字符串**；而 `game` 内部的 `t` 才是**回合序号（数字）**。
  写测试/工具时按 `v.t === 'state' && v.game` 判定，别按 `typeof t === 'number'`。
- ⚠️ **`reaction` / `toast` / `itemGained` 是挂在 `state` 帧上的**，不是独立帧。
  `manager.sendTo()` 会把完整状态一起发出去，所以客户端要在 `applyState` 里读
  `st.reaction`，别去 `case 'reaction'` 里等（这个坑真踩过：服务端发了，
  客户端 `handleMessage` 永远匹配不到 `t === 'reaction'`）。
  只有 `danmaku` 是真正的独立帧（广播性内容，没必要重发整份状态）。
- 玩家身份：浏览器 localStorage 存 `pid`（uuid，注意 app.js 用 JSON 存，读出来带引号）。
- 观众：**对局进行中**用新 pid 加入自动成为观众（只读）。

### 5.4 前端结构
- `app.js` 持全部 UI 状态机；`board.js` 只画不响应（事件由 app.js 绑定后在画布命中测试）。
- 交互：走子模式点高亮格；放墙模式（操作条切换）悬停出幽灵墙，非法显示红色 + 原因 toast。
- 道具模式：`S.mode` 扩展为 `'move' | 'wall' | 'break' | 'trap'`。
  随机传送不需要选目标，点一下道具立即发送；破墙/陷阱进入对应瞄准模式，
  画布上分别高亮「悬停到的路障」与「陷阱落点」。用完或取消都回 `move`。
- 倒计时：客户端用 `serverNow` 与本地时钟做偏差校准，250ms 刷新。
- 断线重连：指数退避自动重连 + 自动回房（localStorage 存 roomCode）。
- 弹幕：`st.danmaku` 是数组，客户端按**条数增量**播放（`S.danmakuSeen`），
  否则重连/刷新会把历史弹幕重放一遍。
- 显隐统一用 `classList.toggle('hidden')`，CSS 里必须保留全局 `.hidden { display:none !important }`
  （只写 `.overlay.hidden` 会导致其它元素的 hidden 完全不生效 —— 这是修过的真实 bug，见 6.1）。

### 5.6 私有信息（道具 / 陷阱）怎么下发
需求要求「玩家之间无法看到其他玩家所获得或持有的道具」，所以**不能再用一份 payload 广播给所有人**：

- `RoomManager.broadcast()` 改成逐人构造：对每个玩家调 `publicStateFor(room, pid)`。
- `publicStateFor()` 在公共状态基础上：
  - `game.traps` **过滤成只有自己埋的那些**（别人的陷阱不是「标记为隐藏」，而是根本不进 payload）；
  - `me.items` 只放自己的背包；
  - `game.seats[*]` 里不含任何道具字段，别人连「某人手上有几件」都看不到。
- 开箱发道具时：公开日志只写「某某打开了一个宝箱」，
  **开出什么只通过 `sendTo(本人)` 的 `toast` 告诉他**。
- 陷阱的日志同理：只写「某某悄悄埋下了一个陷阱」，不写坐标。

### 5.7 宝箱与道具的规则落点
- `settleAfterArrival(g, seat, r, c, kind)` 是**走子与随机传送共用的落点结算**：
  开宝箱 → 踩陷阱 → 判胜负 → 换手。这样「任何方式移动到宝箱格都算开箱」自然成立。
- 结算顺序里**胜负判定在陷阱之前**：踩中陷阱同时踩到中央时算获胜（不会被陷阱拦下）。
- 宝箱两种模式共用 `chest.openedBy` 数组：
  `chestMode==='once'` 时只要有内容就整体失效（箱子消失）；
  `'forever'` 时按座位去重（每人一次，前端给开过的箱子打勾）。
- 道具栏满了（`grantItem` 返回 null）时**不消耗宝箱**，只给本人发一条提示。
- 破墙只允许砸**对手**的墙（`removeWall` 返回 `own-wall`）。
- 陷阱不能埋在中央目标格上（`canPlaceTrap` 返回 `trap-on-goal`）。
- 跳过回合用 `game.seatState[seat].skipTurns` 计数：
  `applyMove` / `canPlaceWall` / `canPlaceTrap` / `removeWall` 全部先查 `isSkipped`，
  超时托管 `pickAutoAction` 遇到跳过状态返回 `{type:'skip'}`。
  不限时房间里没人「交回合」，所以 `tick()` 里有个 `_maybeAutoResolveTrap()` 兜底，
  否则被陷阱困住的玩家会把整局卡死。

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

### 6.4 服务端：一局结束后新加入的人被当成观众（**这次修的功能性 bug**）
`joinRoom` 原来用 `const inLobby = !room.game` 判断能否入座，只有「大厅」才算能坐。
但 `room.game` 在对局结束后**不会被清空**（`phase` 变成 `'finished'`，对象还在），
于是「一局打完、房主还没开下一局」这段时间进来的人全被判成观众；
房主快速重开走的是 `contenders()`（过滤掉观众），**他就被静默排除在下一局之外**。

修复（`src/rooms.js`）：

- `_canSit(room)`：只要**不是 `phase === 'playing'`** 且有座位，就算能入座
  （大厅、以及 `'finished'` 等待重开，都算）。
- `_promoteWaitingSpectators(room)`：一局结束时把观众席上还坐得下的人放回玩家席，
  这样房主重开时他们一起进新局。对局中进来的观众当时仍只能是观众（这点没变，是对的）。
- 调用点：`_afterAction()` 判胜后、以及 `tick()` 里超时托管导致结束时，都要调。

回归测试：`test/ws-flow.test.js` 的「对局结束后新加入的人算玩家，不是观众」。

### 6.5 服务端：`room.sendTo(...)` 写成实例外调用（**低级但静默**）
`react()` / `_grantChestItem()` 里第一版写的是 `room.sendTo(room, ...)`，
但 `sendTo` / `broadcast` / `priv` / `grantItem` 都是 **RoomManager 的方法**，不是 Room 的。
表现：抛 `room.sendTo is not a function`，被 `onError` 吞成一条
「服务器处理消息时出错」，**特效/提示一条都发不出去**。
教训：新增方法时先确认它是挂在 `Room` 还是 `RoomManager` 上；
`grep "room\.(sendTo|broadcast|priv|grantItem)("` 一秒就能查出来。

### 6.6 前端：`reaction` 永远匹配不到（**帧形状踩坑**）
`sendTo()` 发的是 `{ t:'state', ...完整状态, reaction:{...} }`，
而前端第一版写的是 `case 'reaction':`——**永远进不去**，互动特效完全没反应。
修复：在 `applyState()` 里读 `st.reaction`（`st.toast` 同理，一开始就是对的）。
`danmaku` 才是真正的独立帧。

### 6.7 宝箱落点随机 → 协议层测试写不稳
第一版想在 WS 测试里「走位撞宝箱」，结果：随机落点 + 对手挡路 + 走位震荡，
断言时好时坏，甚至出现过「房主沿中线直上直接踩中央赢了」这种自摆乌龙。

最终的划分（照这个来，别再折腾）：

- **开箱语义**（走上去就开、一次性/常驻、每人每箱一次、道具栏满不消耗、
  陷阱与宝箱同格时都结算）→ 全部放 `test/engine.test.js`，**直接构造棋盘**，完全确定。
- **房间管理层**（不限时房间的陷阱跳过兜底、隐私过滤、限流冷却）→ `test/rooms.test.js`。
- **协议层**（`test/ws-flow.test.js`）只验证：宝箱数据下发完整且不含中央格、
  背包是私密的、**用一件确定能拿到的道具**（5×5 小棋盘 + 10 个宝箱，最多重开 4 局必中）
  走完「获得 → 使用 → 换手 → 陷阱只自己可见」。
- 开箱那一步走完**回合已经交给对手**了；要接着用道具必须先等回自己的回合，
  否则会收到「还没轮到你」。这个竞态坑过一次，代码里有注释。

### 6.8 前端：道具栏把页面顶高 → sticky 顶栏盖住棋盘第一行（**回归**）
加了道具栏之后整块棋盘区超过一屏，页面出现滚动条；
顶栏是 `position: sticky; top: 0`，棋盘最上面一两行缩到它底下，
**鼠标点那几格会点到顶栏而不是画布**。表现是「合法放墙点了没反应」，
浏览器验收里 `合法放墙成功` / `路障余量 -1` 直接挂掉（基线 53/53 → 62/68）。

两处修复：

- `public/style.css`：`.board-zone.has-itembar` 时把 `max-width` 从
  `calc(100dvh - 200px)` 收到 `calc(100dvh - 268px)`，道具栏的高度提前预留出来，
  整块棋盘区仍然一屏放得下（`app.js` 的 `renderItems()` 负责加这个 class）。
- `test/browser-e2e.mjs` 的 `geometry()`：算坐标前先把棋盘滚进视口
  （`scrollBy(0, wrap.top - 72)`），别假设页面没有滚动。

### 6.9 前端：弹幕从屏幕左边冒出来（**动画覆盖行内样式**）
第一版 `pushDanmaku()` 是这么写的：

```js
el.style.transform = `translateX(${window.innerWidth}px)`;   // 想把它挪到屏幕右侧之外
el.style.animation = 'danmaku-fly 10s linear forwards';
```
```css
@keyframes danmaku-fly {
  from { transform: translateX(0); }          /* ← 这里把它按回了最左边 */
  to   { transform: translateX(var(--fly-dist)); }
}
```

`.danmaku-item` 是 `position:absolute` 且没写 `left`，静态位置就在层的左边缘；
而 **CSS 动画在层叠里比行内样式优先级更高**，`from` 的 `translateX(0)` 直接把
行内那句 `translateX(innerWidth)` 覆盖掉了。结果弹幕从**屏幕最左边**冒出来再往左飞，
既不是「从右侧进入」，也因为起点就在屏幕内而露馅。

修复（`public/style.css` + `public/app.js`）：

- 基准位置显式写 `left: 0`，不再依赖 `position:absolute` 的静态位置。
- **起止位移都交给 CSS 变量**，由 keyframes 使用（行内样式设的是变量，不是 transform）：
  ```css
  .danmaku-item { left: 0; --from-x: 100vw; --to-x: -100%; transform: translateX(var(--from-x)); }
  @keyframes danmaku-fly {
    from { transform: translateX(var(--from-x)); }
    to   { transform: translateX(var(--to-x)); }
  }
  ```
- JS 用**实测宽度**算两个端点，而不是 `window.innerWidth`：
  - 起点 `--from-x = 弹幕层 clientWidth`：整条的左边缘贴到屏幕右边缘之外
    （靠 `.danmaku-layer` 的 `overflow:hidden` 藏住，看起来就是「从右边冒出来」）；
  - 终点 `--to-x = -弹幕自身宽度`：整条的右边缘移到屏幕左边缘，才算完全移出。
  - 用弹幕层的 `clientWidth` 而不是 `window.innerWidth`：有滚动条时后者偏大。
  - 时长按像素恒定（`距离 / 110`，夹在 7~18 秒），屏幕越宽走得越久，观感才一致。

这个问题说明**光断言「元素存在」是不够的**。浏览器验收现在会把动画
`currentTime` 拨到 0 和 duration 各量一次 `getBoundingClientRect()`，直接断言：
起点 `left >= 屏幕宽度 - 1`（整条在右侧之外）、终点 `right <= 1`（完全移出左侧）。
覆盖桌面 1440、手机 375，以及「弹幕文字比屏幕还宽」（40 字 ≈ 660px vs 375px）三种情况。

### 6.10 前端：刷新页面把历史弹幕全部重放（**增量判断写反了**）
第一版想「只播新增的」，于是记了个**条数**：

```js
danmakuSeen: 0,                                   // 已经渲染过的条数
...
const danmaku = st.danmaku || [];
if (danmaku.length < S.danmakuSeen) S.danmakuSeen = danmaku.length;
for (let i = S.danmakuSeen; i < danmaku.length; i++) pushDanmaku(danmaku[i]);
S.danmakuSeen = danmaku.length;
```

问题在于：刷新页面后 `S.danmakuSeen` 从 0 开始，而服务端每份 state 都带着最近
30 条弹幕历史，于是 `for` 把**整段历史一次性全放出来**——一刷新就是满屏弹幕。
那句 `if (danmaku.length < S.danmakuSeen)` 只在「数组变短」时才生效，等于没防住首屏。

顺带还有个隐藏问题：一条弹幕会**从两条路径**到达客户端——实时帧 `t:'danmaku'`，
以及之后某次 state 里的历史数组。按条数/下标判断会把同一条播两遍。

修复：改成**按序号对齐**，不再数条数。

- 服务端（`rooms.js`）：每条弹幕带一个房间内单调递增的 `seq`
  （`room.danmakuSeq`，玩家弹幕与陷阱系统播报共用同一个计数器，裁剪历史不影响它继续增长）。
- 客户端（`app.js`）：
  - `playDanmaku(entry)`：`seq <= S.danmakuSeq` 直接丢弃，否则播并推进序号 → 天然去重；
  - `applyState()` 里第一次拿到 state 时**只对齐序号、一条都不播**（`S.danmakuPrimed`），
    这才是「刷新页面不重放」的关键；
  - `ws.onopen` 把 `danmakuPrimed` 清掉：重连后同样只对齐、不补播断开期间的老弹幕；
  - 换房间时把 `danmakuSeq` 归零（服务器重启后进新房间，序号会从 1 重新开始，
    不归零的话新弹幕会被旧房间的高序号一直挡着播不出来）。

浏览器验收的写法：另开一个观众页 → 断言服务端确实下发了历史（`history > 0`，否则断言没意义）
→ 断言屏幕上 0 条 → 真 `reload()` 再来一次 → 最后再发一条**实时**弹幕，确认它照常播
（免得「修好不重放」顺手把功能整个关掉）。
注意观众页要**主动点「离开房间」再关**：直接关页面会被当成掉线观众留在名单里，
本局结束时被自动放回玩家席，后面的「重开后仍是 2 人」断言就会崩。

### 6.11 前端：互动按钮只在鼠标悬停时才显示（**改成常态显示**）
`.pp-react` 原来是 `opacity: 0`，靠 `.player-item:hover` 才显形。
需求是「玩家头像旁的消息按钮常态显示」，所以直接去掉隐藏逻辑，并给足点击尺寸：

```css
.pp-react { width: 30px; height: 30px; border: 1px solid var(--line-2); background: #16161c; ... }
@media (pointer: coarse) { .pp-react { width: 36px; height: 36px; font-size: 17px; } }
```

浏览器验收里量 `getComputedStyle` 的 `opacity / visibility / display` 与尺寸，
而且**先把鼠标移到棋盘中央再量**，避免把 hover 态误当成常态；
手机端那条「可点控件 ≥36px」的检查也把 `.pp-react` 加进了选择器列表。

### 6.12 服务端：限时房间里踩中陷阱不会被跳过（**分支写窄了**）
`tick()` 原来长这样：

```js
if (!room.game || room.game.phase !== 'playing' || !room.deadline) {
  return this._maybeAutoResolveTrap(room);   // ← 只有「没有倒计时」才会走到这里
}
... 倒计时没到就 return false;
const auto = pickAutoAction(g, g.turn);
if (auto.type === 'skip') { ...跳过... }      // ← 要等倒计时**走完**才轮到这句
```

于是行为分裂成两种：

- **不限时房间**（`turnTimer = 0`，`deadline` 为 null）：走兜底分支，1 秒内跳过 —— 正常。
- **限时房间**（默认 60 秒，`deadline` 有值）：要等受害者那一回合的倒计时**整整走完**
  才会被托管跳过，看起来就是「踩了陷阱但根本不会自动跳过」。

修复：把跳过从「超时托管的一个分支」提升成**换手后的立刻结算**。

- 新增 `_resolveSkips(room)`：只要当前座位身上还挂着 `skipTurns`，就消耗一层并换手，
  循环到轮上一个能正常行动的人为止（每个座位的 `skipTurns` 都递减，
  循环次数另有上限，不会死循环）。
- 调用点覆盖所有会换手的路径：`_afterAction()`（走子 / 随机传送）、
  `placeWall()`、`useItem()` 的非传送分支，以及 `tick()` 开头（每秒兜底，
  也顺手替掉了原来的 `_maybeAutoResolveTrap`）。
- 这样限时/不限时行为一致：**轮到他就是直接跳过去**，不用等倒计时。

顺带修掉一个哑弹：`_announceTrap()` 原来只往 `room.pendingToast` 塞了个对象，
而**没有任何地方读这个字段**（`publicState` 里根本没有 toast），
所以受害者从来没收到过提示。现在改成 `sendTo(受害者, { toast, toastKind:'warn' })`，
客户端会弹一条「💥 你踩中了陷阱，下一回合无法行动」并闪一下红屏。
「全场播报」本身由日志 + 系统弹幕承担（`system: true` 那条），没变。

回归测试（`test/rooms.test.js`，7 条）：限时房间 `tick` 立刻跳过、
走子/放墙换手后立刻结算、连续两人被困一路跳过、全员被困不死循环、
受害者收到私聊提示。**这几条在旧实现下会红 3 条**（已实测确认）。

### 6.13 前端：可走格的圆点被宝箱图标盖住（**画布绘制顺序**）
`board.js` 的 `draw()` 里，「合法走法提示」原本画在**宝箱之前**，
于是当某一格既是可走格、又正好有宝箱时，宝箱图标整块盖在圆点上，
玩家看不到那一格其实能走（点上去是能走的，只是没提示，很迷惑）。

修复：把「合法走法提示 + 悬停格高亮」整层挪到宝箱 / 陷阱 / 路障 / 各种预览**之后**、
棋子之前。现在 `draw()` 的层次是：

```
底板 → 格子 → 中央目标 → 宝箱 → 陷阱(自己的) → 陷阱预览
     → 路障 → 破墙高亮 → 放墙预览
     → 合法走法圆点 + 悬停高亮     ← 交互提示层，压在场景物件之上
     → 棋子 → 胜者光环
```

棋子放在提示层之上是安全的：合法走法永远不会落在有棋子的格子上，两者不会重叠。
以后再往棋盘上加物件（新道具、新地形），记得**插在提示层之前**，否则又会盖住圆点。

## 7. 测试说明

### 7.1 `npm test`（必跑，60 项）
- `test/engine.test.js`（32 项）：走子/跳跃/斜走、墙的占用与交叉、封死判定、中央获胜、
  四人轮转、路障数量、坐标吸附；宝箱设置与产出池归一化、落点非中央且不重复、
  一次性/常驻两种开箱语义、随机传送不落终点、破墙只能砸对手的、陷阱不能埋中央、
  踩中陷阱跳过一回合且自己埋的雷不炸自己。
- `test/rooms.test.js`（23 项）：房间管理层的确定性单测——逐人状态的隐私过滤
  （背包 / 陷阱 / 广播 payload 各不相同）、开箱发道具与道具栏上限、观众与玩家席准入
  （含一局结束后回席、重连回席、且不超员）、弹幕限流与 **seq 单调递增（裁剪后仍继续增长）**、
  互动冷却；**陷阱跳回合 7 条**——限时与不限时房间都要「轮到就跳」、
  走子/放墙换手后立刻结算、连续两人被困一路跳过、全员被困不死循环、受害者收到私聊提示。
- `test/ws-flow.test.js`（5 个用例，内部 40+ 条断言）：真起服务器进程走完整流程——
  建房 → 邀请码加入 → 非法邀请码 → 非房主开局被拒 → 开始 → 走子 → 放墙 → 交叉墙被拒 →
  观众进入与只读 → 掉线 → 同身份重连 → **同 pid 连接接管** → 快速重开 → 踩中央获胜；
  外加「结束后加入算玩家」「开箱拿道具并使用」「没有道具时用道具被拒」
  「弹幕广播与限流」「头像互动与冷却」。

### 7.2 `npm run test:browser`（可选，83 项）
`test/browser-e2e.mjs`，真实 Chromium，自己起一个随机端口的测试服务器。覆盖：

- 首页两栏布局、无横向溢出
- 建房 → 深链加入 → 开局 → **真实鼠标点击**走完整局 → 胜利层 → 快速重开
- 合法放墙成功、交叉墙被引擎判定非法并弹中文原因、非法走子不生效
- **canvas 像素抽样**：确认中央黄块、发光棋子/路障真的画出来了（防止"白画布"）
- **宝箱 / 道具栏**：宝箱进了状态、道具栏可见、槽位数与设置一致
- **弹幕**：飘到对手屏幕、文案是「玩家名称：内容」、颜色确为发送者座位色；
  **几何断言**（把动画拨到起点/终点各量一次）：桌面 1440 与手机 375 都要
  「起点在屏幕右边缘之外、终点完全移出左侧」，并且文字比屏幕还宽时同样成立；
  **不重放断言**：新开页面与 `reload()` 后屏幕上都是 0 条，而实时新发的照常播
- **头像互动**：入口出现、**按钮常态可见**（鼠标先移开再量 `opacity/visibility/尺寸`）、
  不悬停直接点也能开、选择条 5 种 emoji、对手屏幕真的炸出特效且带来源
- 桌面 1440×900；手机 375×812（单栏、无溢出、控件 ≥36px 含互动按钮、**触摸走子**）；手机横屏
- 全程收集 console 报错 / 未捕获异常 / 4xx 资源（发现 favicon 404 就是这么来的）

截图落在 `gui-test-screenshots/`（`b01..b16`，新增 `b13_itembar` / `b14_danmaku` /
`b15_reaction_picker` / `b16_reaction_fx`）。
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
9. **`sendTo` / `broadcast` / `priv` / `grantItem` 是 `RoomManager` 的方法，不是 `Room` 的**。
   写成 `room.sendTo(...)` 不会报编译错，只会在运行时抛
   `room.sendTo is not a function`，然后被 `onError` 变成一条
   「服务器处理消息时出错」——**看起来像网络问题，其实是拼错了接收者**。
   新增这类方法后跑一次：
   ```bash
   grep -n "room\.\(sendTo\|broadcast\|priv\|grantItem\)(" src/*.js   # 应该没有输出
   ```
10. **改 `public/style.css` 里跟 `100dvh` 挂钩的高度时，留意 sticky 顶栏**。
    棋盘区一旦超过一屏就会出滚动条，棋盘顶部会被顶栏盖住，
    浏览器验收里所有「点棋盘最上面几行」的用例都会挂。改完跑一次
    `npm run test:browser` 确认。
11. **别用 PowerShell 的 `Set-Content` 改这几个 `.md`**：
    `Get-Content -Raw` + `Set-Content` 会把中文多字节字符打坏成 `?`（真坏过一次，
    最后只能 `git checkout` 重来）。要改文档请用编辑工具，或者显式指定
    `-Encoding utf8` 并确认结果。

## 9. 剩余工作 / 建议排期

1. **人眼对照参考图微调视觉**（唯一剩下的正事）：打开 `gui-test-screenshots/` 里的
   `b05_wall_placed.png`、`b13_itembar.png`、`b14_danmaku.png`、`b16_reaction_fx.png`、
   `b07_winner_overlay.png`、`b09_room_mobile.png` 等，
   与参考图比发光强度、配色饱和度、圆角大小，顺便看看宝箱/陷阱/道具栏/弹幕的特效观感。
   调参集中在：
   - 颜色：`src/engine.js` 的 `COLORS`、`ITEM_META`（道具图标与配色）
   - 棋盘/墙体/棋子/宝箱/陷阱绘制：`public/board.js`
     （`_drawWall` 三层霓虹、`_drawPawn` 光晕半径、`_drawChest`、`_drawTrap`）
   - 主题变量与弹幕/特效参数：`public/style.css` 顶部的 `--*`、
     `REACTION_FX`（`public/app.js`）里的 emoji 数量与扩散距离
   像素级"有没有画出来"已经有自动化断言兜底，这一步纯粹是审美。
2. 服务器上实跑一次 Docker / systemd。
3. 如有余力：
   - 道具再加几种（例如「额外路障」「透视对手陷阱」），
     加的时候只需在 `ITEM_META` / `ITEM_KIND_BY_KEY` 里登记，
     再在 `rooms.js` 的 `useItem()` 里加一个分支。
   - 掉线玩家由简单 AI 托管走子（`pickAutoMove` 已有，接上"离线即托管"即可）。
