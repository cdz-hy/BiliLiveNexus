# BiliLiveNexus 项目结构文档

> B 站直播通知 + QQ 群聊 AI 机器人后端服务
> 技术栈：Node.js + TypeScript + Fastify 4 + Prisma (SQLite) + Vue 3 (CDN)

---

## 目录树

```
bililivenexus/
├── .dockerignore           # Docker 构建排除规则
├── .env                    # 环境变量（不入库）
├── .env.example            # 环境变量模板
├── .gitignore              # Git 排除规则
├── Dockerfile              # Docker 镜像构建文件
├── docker-compose.yml      # Docker Compose 编排文件
├── package.json            # 项目依赖与脚本
├── package-lock.json       # 依赖锁定文件
├── tsconfig.json           # TypeScript 编译配置
│
├── docs/                   # 项目文档
│   ├── database.md         # 数据库结构文档
│   └── project-structure.md# 项目结构文档（本文件）
│
├── prisma/                 # Prisma ORM
│   ├── schema.prisma       # 数据库 Schema 定义
│   ├── dev.db              # 开发环境 SQLite 数据库
│   ├── dev.db-journal      # SQLite 日志文件
│   └── migrations/         # 数据库迁移历史
│       ├── 20250219130854_init/
│       └── 20250219132623_add_chat_memory/
│
├── data/                   # 运行时数据（挂载卷，不入库）
│   └── nexus.db            # 生产环境 SQLite 数据库
│
├── logs/                   # 运行日志目录（不入库）
│
├── dist/                   # TypeScript 编译输出（不入库）
│
└── src/                    # 源代码
    ├── index.ts            # 应用入口
    ├── config.ts           # 全局配置中心
    │
    ├── adapters/           # LLM 适配器层
    │   └── llm.adapter.ts  # LLM 接口定义 + OpenAI/Spark 适配器 + 工厂
    │
    ├── plugins/            # Fastify 插件
    │   └── auth.ts         # JWT 认证 + 登录限流
    │
    ├── routes/             # 路由层
    │   ├── api.ts          # WebUI 管理 API（CRUD + 配置）
    │   └── webhook.ts      # B站直播 Webhook 回调
    │
    ├── services/           # 业务服务层
    │   ├── index.ts        # 桶文件（统一导出）
    │   ├── napcat.ts       # NapCat QQ 机器人客户端
    │   ├── webhook.ts      # B站直播事件处理
    │   └── bot.ts          # QQ 群消息处理（规则 + LLM）
    │
    ├── utils/              # 工具模块
    │   ├── logger.ts       # 内存日志系统（脱敏 + 缓存）
    │   └── stats.ts        # 运行时统计（计数器 + 内存）
    │
    └── public/             # 前端静态资源
        └── index.html      # Vue 3 SPA 控制台（CDN 模式）
```

---

## 模块职责说明

### 入口与配置

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 应用入口。初始化 Fastify、Prisma、核心服务；注册插件和路由；启动 HTTP 服务；处理优雅停机（SIGINT/SIGTERM） |
| `src/config.ts` | 集中管理环境变量：端口、密码、JWT 密钥、Webhook 密钥、NapCat 连接信息。避免各模块直接读 `process.env` |

### 适配器层（adapters）

| 文件 | 职责 |
|------|------|
| `llm.adapter.ts` | 定义 `LLMAdapter` 统一接口（`chat` / `testConnection`）；实现 `OpenAIAdapter`（支持任意 OpenAI 兼容 API，可自定义 Base URL 和模型名）和 `SparkAdapter`（讯飞星火 4.0 Ultra）；`LLMFactory` 工厂类按配置动态切换 |

**接口设计：**
```typescript
interface LLMAdapter {
    chat(sessionId: string, prompt: string): Promise<string>;
    testConnection(): Promise<boolean>;
}
```

### 插件层（plugins）

| 文件 | 职责 |
|------|------|
| `auth.ts` | 注册 `@fastify/jwt`；全局 preHandler 钩子校验 `/api/*` 请求的 JWT；`/api/login` 端点实现密码验证 + IP 限流（5 次/分钟）+ 8 小时 JWT 签发 |

**公开路径（无需认证）：** `/api/login`、`/webhook/bili`、`/`

### 路由层（routes）

| 文件 | 职责 |
|------|------|
| `api.ts` | WebUI 管理 API，包含：NapCat 事件接收（`POST /`）、系统状态（`GET /api/stats`）、日志（`GET /api/logs`）、主播 CRUD、规则 CRUD、忽略名单 CRUD、LLM 配置读写、连接测试 |
| `webhook.ts` | B 站直播事件回调（`POST /webhook/bili`），支持 `X-Webhook-Secret` 密钥验证 |

### 服务层（services）

| 文件 | 职责 |
|------|------|
| `napcat.ts` | 封装 NapCat HTTP API 调用（`send_group_msg`），内置滑动窗口限流（10 次/分钟） |
| `webhook.ts` | 处理 B 站开播/下播事件：查询订阅主播 → 构建通知消息 → @全体降级策略 → 5 分钟冷却防刷 |
| `bot.ts` | 处理 QQ 群消息：@检测 → 忽略名单过滤 → 规则匹配（EXACT/CONTAINS/REGEX）→ LLM 兜底回复 |
| `index.ts` | 桶文件，统一导出 `NapCatClient`、`WebhookService`、`BotService` |

**消息处理流水线：**
```
群消息 → @我？ → 忽略名单？ → 规则匹配？ → LLM 回复
```

### 工具层（utils）

| 文件 | 职责 |
|------|------|
| `logger.ts` | 内存日志系统：控制台输出 + 缓存最近 200 条日志 + 敏感信息脱敏（QQ 号、Token、消息内容） |
| `stats.ts` | 运行时统计：启动时间、消息计数、规则命中、Webhook 事件、LLM 调用、内存占用 |

### 前端（public）

| 文件 | 职责 |
|------|------|
| `index.html` | 单页应用（SPA），Vue 3 CDN 模式 + Tailwind CSS + RemixIcon。包含：登录页、仪表盘（统计卡片 + 内存图表 + 活动日志）、大模型设置、主播监控、回复策略、忽略名单、系统日志 |

**前端特性：**
- 可收起侧边栏（w-64 ↔ w-20），折叠态 tooltip
- 毛玻璃效果顶栏和登录页
- Toast 通知系统（替代原生 alert）
- Tab 切换动画、卡片悬浮效果
- 智能轮询（仪表盘 3s，其他页面 10s）
- 日志按级别过滤，智能滚动

---

## 核心依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `fastify` | ^4.26.1 | Web 框架 |
| `@fastify/cors` | ^8.5.0 | 跨域支持 |
| `@fastify/jwt` | ^7.0.0 | JWT 认证（Fastify 4 兼容） |
| `@fastify/static` | ^6.12.0 | 静态文件服务 |
| `@prisma/client` | ^5.10.2 | 数据库 ORM 客户端 |
| `prisma` | ^5.10.2 | 数据库迁移与代码生成 |
| `axios` | ^1.6.7 | HTTP 请求（NapCat API、LLM API） |
| `dotenv` | ^16.4.5 | 环境变量加载 |

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | 5555 | 服务监听端口 |
| `DATABASE_URL` | 是 | — | SQLite 数据库路径 |
| `NEXUS_PASSWORD` | 是 | — | WebUI 管理密码 |
| `JWT_SECRET` | 否 | 同 NEXUS_PASSWORD | JWT 签名密钥 |
| `WEBHOOK_SECRET` | 否 | — | B站 Webhook 验证密钥 |
| `BOT_QQ_ID` | 否 | — | 机器人 QQ 号 |
| `NAPCAT_URL` | 否 | http://localhost:3000 | NapCat HTTP API 地址 |
| `NAPCAT_TOKEN` | 否 | — | NapCat API 鉴权 Token |
| `XF_APPID` | 否 | — | 讯飞星火 APPID |
| `XF_API_SECRET` | 否 | — | 讯飞星火 API Secret |
| `XF_API_KEY` | 否 | — | 讯飞星火 API Key |

---

## Docker 部署

```bash
# 构建并启动
docker-compose build --no-cache && docker-compose up -d

# 查看日志
docker-compose logs -f backend

# 停止
docker-compose down
```

**容器结构：**
- 镜像基于 `node:20-alpine`
- 源码编译为 JS 后运行（`tsc` → `dist/`）
- 数据库与日志通过 volume 挂载到宿主机 `./data` 和 `./logs`
- 启动时自动执行 `prisma migrate deploy`
