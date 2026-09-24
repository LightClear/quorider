# 路障棋 Quorider —— 零依赖，构建期不需要 npm install
FROM node:22-alpine

# 交给非 root 用户运行（node 镜像自带 uid/gid 1000 的 node 用户）
WORKDIR /app

# 只拷运行必需的文件：没有 package-lock / node_modules 可拷
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY deploy/ ./deploy/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER node

EXPOSE 3000

# 自检：容器编排与 docker run 都能直接看到健康状态
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 node 直接跑：不需要 shell，Ctrl+C / docker stop 能收到 SIGTERM
CMD ["node", "server.js"]
