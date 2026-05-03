# ---- 构建阶段 ----
FROM node:20-alpine
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

WORKDIR /app

# 安装 Prisma 所需的系统依赖
RUN apk add --no-cache openssl

# 先复制依赖清单，利用 Docker 缓存层减少重复安装
COPY package.json package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com

# 复制 Prisma Schema 并生成 Client
COPY prisma ./prisma
RUN npx prisma generate

# 复制源码与构建配置
COPY tsconfig.json ./
COPY src ./src

# 将 WebUI 静态资源复制到 /app/public
# Fastify 通过 process.cwd() + 'public' 查找，需要在根目录而非 src 下
COPY src/public ./public

# 编译 TypeScript
RUN npm run build

EXPOSE 5555

# 启动时执行数据库迁移，然后启动编译后的 JS
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
