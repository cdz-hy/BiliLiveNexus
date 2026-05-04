# BiliLiveNexus 项目结构文档

> B 站直播通知 + QQ 群聊 AI 机器人后端服务
> 技术栈：Node.js + TypeScript + Fastify 4 + Prisma (SQLite) + Vue 3 (CDN) + bilibili-live-ws

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
│   └── migrations/         # 数据库迁移历史
│       ├── 20260219135331_add_llm_config/
│       ├── 20260220130011_init_ignored_user/
│       └── 20260503175622_add_room_id/
│
├── data/                   # 运行时数据（挂载卷，不入库）
│   └── nexus.db            # 生产环境 SQLite 数据库
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
    │   ├── api.ts          # WebUI 管理 API（CRUD + 配置 + NapCat 事件接收）
    │   └── webhook.ts      # 外部 Webhook 回调（可选通道）
    │
    ├── services/           # 业务服务层
    │   ├── index.ts        # 桶文件（统一导出）
    │   ├── live-monitor.ts # 直播监控（弹幕 WS + HTTP 轮询）
    │   ├── notification.ts # 通知服务（消息构建 + 冷却 + 降级）
    │   ├── webhook.ts      # Webhook 适配器（事件解析）
    │   ├── bot.ts          # QQ 群消息处理（规则 + LLM）
    │   └── napcat.ts       # NapCat QQ 机器人客户端
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
| `src/index.ts` | 应用入口。初始化 Fastify、Prisma、核心服务；注册插件和路由；启动 HTTP 服务；启动直播监控；处理优雅停机 |
| `src/config.ts` | 集中管理环境变量：端口、密码、JWT 密钥、Webhook 密钥、NapCat 连接、直播监控开关与轮询间隔 |

### 适配器层（adapters）

| 文件 | 职责 |
|------|------|
| `llm.adapter.ts` | 定义 `LLMAdapter` 统一接口（`chat` / `testConnection`）；`OpenAIAdapter` 支持任意 OpenAI 兼容 API；`SparkAdapter` 支持讯飞星火 4.0 Ultra；`LLMFactory` 按配置动态切换 |

### 插件层（plugins）

| 文件 | 职责 |
|------|------|
| `auth.ts` | 注册 `@fastify/jwt`；全局 preHandler 校验 `/api/*` JWT；`/api/login` 实现密码验证 + IP 限流（5 次/分钟）+ 8 小时 JWT 签发 |

**公开路径（无需认证）：** `/api/login`、`/webhook/bili`、`/`

### 路由层（routes）

| 文件 | 职责 |
|------|------|
| `api.ts` | WebUI 管理 API：NapCat 事件接收（`POST /`）、系统状态、日志、主播 CRUD（联动 LiveMonitorService 动态连接）、规则 CRUD、忽略名单 CRUD、LLM 配置 |
| `webhook.ts` | 外部 Webhook 回调（`POST /webhook/bili`），可选通道，支持密钥验证 |

### 服务层（services）

| 文件 | 职责 |
|------|------|
| `live-monitor.ts` | **直播监控核心**。启动时加载所有已订阅房间，通过 `bilibili-live-ws` 建立弹幕 WebSocket 连接，监听 `LIVE`/`PREPARING` 事件；HTTP 轮询兜底（默认 3 分钟）；支持动态增删连接 |
| `notification.ts` | **通知服务**。接收房间号 + 事件类型，查询订阅列表，构建通知消息（@全体 + 封面图 + 颜文字），5 分钟冷却防刷，@全体失败自动降级 |
| `webhook.ts` | Webhook 适配层。解析外部推送的事件格式（BililiveRecorder），委托给 NotificationService 处理 |
| `bot.ts` | QQ 群消息处理：@检测 → 忽略名单过滤 → 规则匹配（EXACT/CONTAINS/REGEX）→ LLM 兜底回复 |
| `napcat.ts` | 封装 NapCat HTTP API 调用（`send_group_msg`），内置滑动窗口限流（10 次/分钟） |
| `index.ts` | 桶文件，统一导出所有服务 |

**直播检测数据流：**
```
B站弹幕 WS ──LIVE/PREPARING──▶ LiveMonitorService ──▶ NotificationService ──▶ NapCat ──▶ QQ 群
外部 Webhook ──POST /webhook/bili──▶ WebhookService ──┘
HTTP 轮询（3min）──状态对比──┘
```

**消息处理流水线：**
```
群消息 → @我？ → 忽略名单？ → 规则匹配？ → LLM 回复
```

### 工具层（utils）

| 文件 | 职责 |
|------|------|
| `logger.ts` | 内存日志系统：控制台输出 + 缓存最近 200 条 + 敏感信息脱敏（QQ 号、Token、消息内容） |
| `stats.ts` | 运行时统计：启动时间、消息计数、规则命中、Webhook 事件、直播事件、活跃连接数、LLM 调用、内存占用 |

### 前端（public）

| 文件 | 职责 |
|------|------|
| `index.html` | Vue 3 SPA 控制台。包含：登录页、仪表盘（统计卡片 + 内存图表 + 活动日志）、大模型设置、主播监控、回复策略、忽略名单、系统日志 |

---

## 核心依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `fastify` | ^4.26.1 | Web 框架 |
| `@fastify/cors` | ^8.5.0 | 跨域支持 |
| `@fastify/jwt` | ^7.0.0 | JWT 认证 |
| `@fastify/static` | ^6.12.0 | 静态文件服务 |
| `@prisma/client` | ^5.10.2 | 数据库 ORM |
| `prisma` | ^5.10.2 | 数据库迁移与代码生成 |
| `axios` | ^1.6.7 | HTTP 请求 |
| `dotenv` | ^16.4.5 | 环境变量加载 |
| `bilibili-live-ws` | latest | B 站弹幕 WebSocket 客户端（自动重连、心跳、压缩） |

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | 5555 | 服务监听端口 |
| `DATABASE_URL` | 是 | — | SQLite 数据库路径 |
| `NEXUS_PASSWORD` | 是 | — | WebUI 管理密码 |
| `JWT_SECRET` | 否 | 同 NEXUS_PASSWORD | JWT 签名密钥 |
| `WEBHOOK_SECRET` | 否 | — | Webhook 验证密钥（可选） |
| `BOT_QQ_ID` | 否 | — | 机器人 QQ 号 |
| `NAPCAT_URL` | 否 | http://localhost:3000 | NapCat HTTP API 地址 |
| `NAPCAT_TOKEN` | 否 | — | NapCat API Token |
| `LIVE_MONITOR_ENABLED` | 否 | true | 是否启用内置直播监控 |
| `LIVE_MONITOR_POLL_INTERVAL` | 否 | 180000 | HTTP 轮询间隔（毫秒） |
| `XF_APPID` | 否 | — | 讯飞星火 APPID |
| `XF_API_SECRET` | 否 | — | 讯飞星火 API Secret |
| `XF_API_KEY` | 否 | — | 讯飞星火 API Key |
