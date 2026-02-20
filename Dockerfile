FROM node:20-alpine

WORKDIR /app

# 安装构建依赖
RUN apk add --no-cache openssl

# 复制依赖文件
COPY package.json package-lock.json* ./

# 安装依赖
RUN npm install

# 复制源代码与 Prisma Schema
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

# 重要：复制 WebUI 静态资源到运行目录根目录 public
# 这样 Fastify 才能通过 process.cwd() + 'public' 找到它
COPY src/public ./public

# 生成 Prisma Client
RUN npx prisma generate

# 构建 TS 代码
RUN npm run build

# 暴露端口
EXPOSE 5555

# 启动命令
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
