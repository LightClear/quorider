# 路障棋 Quorider

> 网页端多人路障棋（Quoridor 变体）：**最多 4 人对战，率先触碰中央黄色方块者获胜。**
> 零 npm 依赖 —— 有 Node.js 就能跑，不需要 `npm install`。

---

## 1. 它是什么

经典路障棋里，玩家要绕开对手布下的路障，从自己那一侧走到对侧底线。
本作把它改造成**抢中央**的多人混战：

- 棋盘中央有一块**黄色方块**（可选 1 格或 2×2）。
- 每人轮流行动，二选一：**走一格棋子** 或 **放一面路障**（横竖各挡两格宽）。
- 棋子可以跳过紧邻的对手；跳不过去时改走斜向。
- **放墙不能把任何玩家彻底封死，也不能把中央方块完全围死**（服务端每次放墙都做连通性校验）。
- 第一个踩上中央方块的玩家获胜，房主可一键重开。

其余特性：

| 特性 | 说明 |
|------|------|
| 邀请码房间 | 创建房间生成 5 位邀请码（已去掉 I/O/0/1 等易混字符），朋友输入即加入 |
| 房主可调设置 | 棋盘 7/9/11/13、人数上限 2/3/4、每人路障数、回合限时、中央方块尺寸 |
| 断线重连 | 身份存在浏览器 localStorage，刷新/掉线后用同一身份自动回座，座位不丢 |
| 观众模式 | 对局进行中凭邀请码进来的人自动成为只读观众 |
| 回合限时托管 | 超时自动替你走一步（朝中央最近的方向）；当前玩家掉线时倒计时暂停 |
| 快速重开 | 房主在对局结束后一键再来一局，玩家与设置全部保留 |
| 移动端适配 | 响应式布局 + 触摸目标尺寸 + 安全区适配 |

---

## 2. 快速开始

要求：**Node.js ≥ 18**（零第三方依赖，不用 `npm install`）。

```bash
node server.js                 # 默认监听 0.0.0.0:3000
PORT=8080 node server.js       # 换端口
HOST=127.0.0.1 node server.js  # 只监听本机（配合反向代理）
```

浏览器打开 `http://<服务器IP>:3000` 即可。地址栏支持两个查询参数：

```
http://<服务器IP>:3000/?r=ABCDE            预填邀请码（发给朋友的就是这个链接）
http://<服务器IP>:3000/?r=ABCDE&pid=<身份>  用指定身份回到原来的座位（换设备/手机接管）
```

`pid` 是浏览器里 `localStorage` 的 `quorider.pid`。正常人不需要管它，
但在「同一局从电脑换到手机接着下」时很有用：把电脑上的 `pid` 带过去，
手机就能直接接管那个座位，而不是作为新玩家/观众进场。

健康检查（给负载均衡 / 容器编排用）：

```bash
curl http://localhost:3000/healthz
# {"ok":true,"rooms":0,"uptime":12.34}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；反向代理场景建议设为 `127.0.0.1` |

### npm 脚本

| 命令 | 作用 |
|------|------|
| `npm start` | 等于 `node server.js` |
| `npm run dev` | `node --watch server.js`，改代码自动重启（开发用） |
| `npm test` | 规则引擎单测 + WebSocket 端到端协议测试 |
| `npm run test:browser` | 可选：真实 Chromium 实机验收（需先自行起服务器，见第 5 节） |

---

## 3. 部署

四种方式任选，默认端口都是 3000，健康检查路径都是 `/healthz`。

### 3.1 systemd（裸机 / VPS，推荐）

```bash
# 1) 放代码（示例路径 /opt/quorider）
sudo mkdir -p /opt/quorider
sudo cp -r ./* /opt/quorider/

# 2) 安装 unit
sudo cp deploy/quorider.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quorider

# 3) 查看状态与日志
systemctl status quorider
journalctl -u quorider -f
```

`deploy/quorider.service` 使用 `DynamicUser` + 只读文件系统 + 严格的沙箱选项，
应用本身不写磁盘（房间状态全在内存），所以可以直接以只读方式运行。
改端口：`sudo systemctl edit quorider` 覆盖 `Environment=PORT=...` 即可。

### 3.2 nginx 反向代理（绑定域名 / 上 HTTPS）

WebSocket 必须单独放行 `Upgrade` 头，否则房间会一直连不上。

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/quorider
sudo ln -s /etc/nginx/sites-available/quorider /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/nginx.conf` 已经包含：静态资源缓存、WebSocket 升级头、长连接超时、
以及给 `ws` 用的 `proxy_buffering off`。用 Certbot 上 HTTPS 后，
前端会自动把 `ws://` 切成 `wss://`（见 `public/app.js` 的 `wsUrl()`）。

### 3.3 Docker

```bash
docker build -t quorider .
docker run -d --name quorider -p 3000:3000 --restart unless-stopped quorider
```

镜像基于 `node:22-alpine`，构建期**不执行 npm install**（没有依赖），
以非 root 用户运行，内置 `HEALTHCHECK`。

### 3.4 docker compose

```bash
docker compose up -d --build
docker compose logs -f
```

需要改配置时复制 `deploy/env.example` 为 `.env` 再改。

---

## 4. 玩法与操作

1. 首页填昵称 → 「创建房间」或输入邀请码「加入房间」。
2. 大厅里把邀请码发给朋友（点顶部邀请码即可复制）；房主可改房间设置、移出玩家。
3. 房主点「开始游戏」。移动端与桌面端操作一致：
   - **走子模式**：棋盘上会亮出可走的格子（自己颜色的圆点/圆环），点一下就走。
   - **放墙模式**：点操作条的「放墙」，在棋盘格线上悬停会预览幽灵墙；
     合法显示自己颜色，非法显示红色并弹出中文原因（如「路障不能交叉」）。
4. 谁先踩到中央黄色方块谁赢；房主点「快速重开」再来一局。

规则细节（实现见 `src/engine.js`）：

- 走子：直走 1 格；正前方有对手可跳 2 格；跳位被墙或棋盘边缘挡住时改走斜向。
- 放墙：范围校验 → 占用校验 → 交叉校验 → **BFS 连通性校验**（不得封死任何玩家，不得封死中央方块）。
- 一面墙同时占两个"半格"，但**交叉判定用的是墙根**，所以 T 形相接是合法的。

---

## 5. 测试

### 5.1 自动化测试（必跑）

```bash
npm test
```

- `test/engine.test.js` —— 规则引擎单测 16 项：走子/跳跃/斜走、墙的占用与交叉、
  封死判定、中央获胜、四人轮转、路障数量、坐标吸附。
- `test/ws-flow.test.js` —— 端到端协议测试：真起一个服务器进程，走完整流程
  （建房 → 邀请码加入 → 非法邀请码 → 非房主开局被拒 → 开始 → 走子 → 放墙 →
  交叉墙被拒 → 观众进入与只读 → 掉线 → 同身份重连保留座位 → 快速重开 → 踩中央获胜）。

### 5.2 浏览器实机验收（可选，开发用）

需要真实浏览器，脚本用 Playwright 的 CDP 协议驱动 Chromium：

```bash
npm i -D playwright-core
npx playwright install chromium
node server.js &                       # 或另开终端
npm run test:browser
```

脚本会自己再起一个测试服务器（默认 3902 端口）并完成：

- 首页两栏布局 / 无横向溢出
- 建房 → 深链加入 → 开局 → 用**真实鼠标点击**走完整局 → 胜利层 → 快速重开
- 合法放墙成功、非法交叉墙弹出中文原因、非法走子不生效
- canvas 像素抽样：确认中央黄块、发光棋子/路障真的画出来了（防止白画布）
- 桌面 1440×900、手机 375×812（单栏、无溢出、触摸目标 ≥36px、触摸走子）、手机横屏
- 全程收集 console 报错 / 未捕获异常 / 4xx 资源

截图与日志：`gui-test-screenshots/`。
可用环境变量：`QDR_CHROME` 指定浏览器可执行文件，`QDR_PW` 指定 playwright-core 目录，
`QDR_PW_PORT` / `QDR_CDP_PORT` 换端口。

---

## 6. 目录结构

```
quorider/
├── server.js                  # HTTP 静态服务 + WS 挂载 + 消息路由 + 每秒定时器
├── package.json               # type: module，零依赖
├── src/
│   ├── engine.js              # ★ 规则引擎（浏览器与 Node 共用，纯数据纯函数）
│   ├── ws.js                  # RFC6455 最小实现（帧解析、分片、心跳、关闭握手）
│   └── rooms.js               # 房间/座位/邀请码/限时托管/广播
├── public/
│   ├── index.html             # 首页 + 房间页两屏
│   ├── style.css              # 深色霓虹主题 + 响应式
│   ├── board.js               # Canvas 棋盘渲染（发光格/墙/棋子/中央黄块）
│   └── app.js                 # 前端状态机、WS 客户端、交互
├── test/
│   ├── engine.test.js         # 规则单测
│   ├── ws-flow.test.js        # 端到端协议测试
│   └── browser-e2e.mjs        # 浏览器实机验收（可选）
├── deploy/
│   ├── quorider.service       # systemd unit
│   ├── nginx.conf             # nginx 反代（含 WS 升级头）
│   └── env.example            # 端口等环境变量示例
├── Dockerfile
├── docker-compose.yml
└── HANDOFF.md                 # 开发交接文档（设计与踩坑记录）
```

浏览器里的 `/shared/engine.js` 由服务器把 `src/engine.js` 直接吐出，
**两端共用同一份规则代码**，不会出现前后端规则不一致。

---

## 7. 常见问题

**Q：房间一直显示"重连中…"？**
多半是反向代理没放行 WebSocket。确认 nginx 配置里有
`proxy_set_header Upgrade $http_upgrade;` 和 `proxy_set_header Connection $connection_upgrade;`，
并确保 `map $http_upgrade $connection_upgrade` 定义在 `http` 块里（`deploy/nginx.conf` 有完整示例）。

**Q：玩家刷新页面后座位丢了？**
座位绑在 localStorage 里的 `pid` 上。只要还是同一个浏览器、没清站点数据，
刷新后会自动用同一个 `pid` 重新 `join` 回原座位；对局中掉线的座位会保留。
换设备/换浏览器会变成新玩家（对局中则成为观众），但可以用
`?r=邀请码&pid=原身份` 直接把座位接管过来（见第 2 节）。

**Q：棋子突然不动了？**
看是不是轮到了别人（操作条会显示"轮到 XXX"），或者你的路障用完了。
超时托管开启时，倒计时结束会由服务器替你走一步。

**Q：服务器重启，房间还在吗？**
不在。房间状态全部在内存里，进程重启即清空。这是刻意的设计——
没有数据库依赖，`git clone` + `node server.js` 就能上线。

**Q：怎么改默认设置？**
改 `src/engine.js` 里的 `DEFAULT_SETTINGS`（棋盘 9、路障 10、限时 60 秒、4 人、中央 1 格）。
房主在界面上的改动只作用于自己那个房间。
