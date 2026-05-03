# BiliLiveNexus

B 站直播通知 + QQ 群聊 AI 机器人 服务。

本项目只是一个轻量后端，本身不直接获取直播状态，需要配合以下两个外部工具使用：

- **[NapCat](https://napneko.github.io/)** — QQ 机器人框架，负责接收群消息（上报给本程序处理）和发送群通知
- **[BililiveRecorder（弹幕姬）](https://github.com/BililiveRecorder/BililiveRecorder)** — B 站直播录制工具，通过 Webhook 将开播/下播事件推送给本程序

工作流程：弹幕姬检测到直播状态变化 → Webhook 推送到本程序 → 本程序查询订阅列表 → 通过 NapCat 向 QQ 群发送通知。群内 @机器人 则触发关键词规则回复或大模型 AI 对话。内置 WebUI 管理控制台。

## 功能概览

- **直播通知** — 订阅 B 站主播，开播/下播时自动发送 QQ 群通知（支持 @全体、封面图、5 分钟冷却防刷）
- **智能回复** — 关键词规则匹配（精确/包含/正则），命中直接回复，未命中走大模型兜底
- **大模型对话** — 支持 OpenAI 兼容接口（DeepSeek / GPT / Qwen 等）和讯飞星火
- **WebUI 控制台** — 仪表盘统计、主播管理、规则配置、忽略名单、大模型设置、系统日志
- **安全机制** — JWT 认证、登录 IP 限流、Webhook 密钥验证、日志脱敏

## 技术栈

Node.js + TypeScript + Fastify 4 + Prisma (SQLite) + Vue 3 (CDN) + Tailwind CSS

---

## 部署前准备

### 1. NapCat QQ 机器人

NapCat 是基于 NTQQ 的 QQ 协议实现框架，本项目通过其 HTTP API 发送群消息。

#### 安装 NapCat

参考 [NapCat 官方文档](https://napneko.github.io/) 安装，推荐使用 Docker 方式部署。

#### 配置 HTTP 服务器

在 NapCat 的 WebUI 或配置文件中，找到 **HTTP 服务器** 设置项，按以下方式配置：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 服务器域名 | `0.0.0.0` | 监听所有网卡 |
| 服务器端口 | `3000` | 本项目通过此端口调用 NapCat 发送消息 |
| access-token | 自定义字符串 | 与 `.env` 中 `NAPCAT_TOKEN` 保持一致 |

#### 配置 HTTP 客户端（消息上报）

本项目需要接收 NapCat 上报的群消息才能处理 @机器人 的请求。在 NapCat 中找到 **HTTP 客户端** 或 **数据上报 HTTP 服务器** 设置项，添加一个上报地址：

```
http://<本程序所在IP>:5555
```

> **网络地址注意：** 尽量不要使用公网 IP（除非必要），优先使用 Docker 网桥地址或内网地址：
>
> - NapCat 和本程序都用 Docker 部署在同一台机器：`http://172.17.0.1:5555`（Docker 默认网关）
> - NapCat 和本程序在同一台机器但非 Docker：`http://127.0.0.1:5555`
> - 不同机器：使用内网 IP，如 `http://192.168.x.x:5555`

确保以下选项已开启：

| 配置项 | 状态 | 说明 |
|--------|------|------|
| 消息上报 | **开启** | NapCat 将群消息上报给本程序处理 |
| 上报 Bot 自身消息 | **开启** | 可选，避免机器人自己的消息触发回复 |

> **重要：** 消息上报的格式请选择 **Array**（默认值即可），本项目按 array 格式解析消息段。

---

### 2. BililiveRecorder（弹幕姬）Webhook

[BililiveRecorder](https://github.com/BililiveRecorder/BililiveRecorder) 是 B 站直播录制工具，支持通过 Webhook2 上报直播开播/下播事件。

在弹幕姬的 WebUI 中，进入 **设置 → Webhook2**，添加一个 Webhook 地址：

```
http://<本程序所在IP>:5555/webhook/bili
```

如果设置了 `WEBHOOK_SECRET`，则地址为：

```
http://<本程序所在IP>:5555/webhook/bili?secret=你的密钥
```

> **网络地址注意：** 同上，优先使用 Docker 网桥地址或内网地址，避免使用公网 IP。
> - `http://172.17.0.1:5555/webhook/bili`（Docker 网桥）
> - `http://127.0.0.1:5555/webhook/bili`（同机非 Docker）
> - `http://192.168.x.x:5555/webhook/bili`（内网）

> 弹幕姬的 Webhook2 接口会发送 `StreamStarted` 和 `StreamEnded` 事件，本项目只处理这两种事件类型。

---

## 部署方式

### Docker Compose 部署（推荐）

#### 1. 克隆项目

```bash
git clone <仓库地址> bililivenexus
cd bililivenexus
```

#### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填写实际配置：

```ini
# --- 基础服务 ---
PORT=5555
DATABASE_URL="file:./data/nexus.db"

# --- 安全认证 ---
NEXUS_PASSWORD=你的管理密码
JWT_SECRET=
WEBHOOK_SECRET=

# --- NapCat QQ 机器人 ---
BOT_QQ_ID=机器人的QQ号
NAPCAT_URL=http://172.17.0.1:3000
NAPCAT_TOKEN=你的NapCat的access-token
```

> **Docker 网络注意：** `NAPCAT_URL` 不能写 `localhost`，因为容器内的 `localhost` 指向容器自身。如果 NapCat 运行在宿主机上，使用 Docker 网桥网关地址：
> - Linux: `http://172.17.0.1:3000`
> - macOS/Windows (Docker Desktop): `http://host.docker.internal:3000`
>
> 如果 NapCat 也运行在 Docker 中，使用 NapCat 容器的服务名或容器 IP。
>
> 同理，NapCat 的消息上报地址和弹幕姬的 Webhook2 地址也不能用 `localhost`，需要填写本程序容器的网桥地址（如 `http://172.17.0.1:5555`）或内网 IP。

#### 3. 构建并启动

```bash
docker-compose build --no-cache
docker-compose up -d
```

#### 4. 访问 WebUI

浏览器打开 `http://<服务器IP>:5555`，使用 `NEXUS_PASSWORD` 登录。

#### 常用命令

```bash
# 查看日志
docker-compose logs -f backend

# 重启服务（数据保留）
docker-compose restart

# 停止并重新创建容器（数据保留）
docker-compose down && docker-compose up -d

# 停止并删除数据卷（数据库会丢失！慎用）
docker-compose down -v
```

---

### 本地开发

```bash
# 安装依赖
npm install

# 初始化数据库
npx prisma generate
npx prisma migrate deploy

# 启动开发服务器
npm run dev
```

---

## 环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | `5555` | 服务监听端口 |
| `DATABASE_URL` | 是 | — | SQLite 数据库路径，Docker 中固定为 `file:./data/nexus.db` |
| `NEXUS_PASSWORD` | 是 | — | WebUI 管理密码 |
| `JWT_SECRET` | 否 | 同 `NEXUS_PASSWORD` | JWT 签名密钥 |
| `WEBHOOK_SECRET` | 否 | — | Webhook 验证密钥，设置后请求须携带密钥 |
| `BOT_QQ_ID` | 否 | — | 机器人 QQ 号，用于识别群消息中的 @ |
| `NAPCAT_URL` | 否 | `http://localhost:3000` | NapCat HTTP API 地址 |
| `NAPCAT_TOKEN` | 否 | — | NapCat 的 access-token |
| `XF_APPID` | 否 | — | 讯飞星火 APPID（可选，部署后可在 WebUI 修改） |
| `XF_API_SECRET` | 否 | — | 讯飞星火 API Secret |
| `XF_API_KEY` | 否 | — | 讯飞星火 API Key |

---

## WebUI 控制台

登录后可通过侧边栏切换以下功能模块：

| 页面 | 功能 |
|------|------|
| **系统概览** | 运行时长、消息统计、规则命中、AI 调用次数、内存占用图表、最近活动日志 |
| **大模型设置** | 切换 OpenAI 兼容 / 讯飞星火、配置 API 密钥、编辑系统 Prompt、连接测试 |
| **主播监控** | 添加/删除订阅主播（房间号 + 群号），实时显示在播/离线状态 |
| **回复策略** | 配置关键词自动回复规则（精确匹配/包含/正则），支持文本和图片回复 |
| **忽略名单** | 添加/移除被忽略的 QQ 用户，被忽略用户 @机器人 不会收到回应 |
| **系统日志** | 按级别过滤（INFO/WARN/ERROR），彩色显示，智能滚动 |

---

## 消息处理流程

```
QQ 群消息
    │
    ├─ 不是群消息 / 不是 @机器人 → 忽略
    │
    ├─ 发送者在忽略名单中 → 忽略
    │
    ├─ 匹配到关键词规则 → 组合回复（不再调用大模型）
    │
    └─ 未匹配规则 → 调用大模型 AI 回复
```

## Webhook 事件处理流程

```
Blrec 发送 Webhook 事件
    │
    ├─ EventType = StreamStarted
    │   ├─ 查找订阅的主播 → 未找到则忽略
    │   ├─ 5 分钟冷却检查 → 重复则忽略
    │   ├─ 构建通知消息（@全体 + 颜文字 + 直播间链接）
    │   └─ 通过 NapCat 发送到关联的 QQ 群
    │
    └─ EventType = StreamEnded
        ├─ 查找订阅的主播 → 未找到则忽略
        └─ 发送下播通知到关联的 QQ 群
```

---

## 项目结构

```
bililivenexus/
├── src/
│   ├── index.ts              # 应用入口
│   ├── config.ts             # 配置中心
│   ├── adapters/
│   │   └── llm.adapter.ts    # LLM 适配器（OpenAI 兼容 / 讯飞星火）
│   ├── plugins/
│   │   └── auth.ts           # JWT 认证 + 登录限流
│   ├── routes/
│   │   ├── api.ts            # WebUI 管理 API
│   │   └── webhook.ts        # B站直播 Webhook 回调
│   ├── services/
│   │   ├── napcat.ts         # NapCat QQ 机器人客户端
│   │   ├── webhook.ts        # 直播事件处理
│   │   └── bot.ts            # QQ 群消息处理
│   ├── utils/
│   │   ├── logger.ts         # 内存日志系统
│   │   └── stats.ts          # 运行时统计
│   └── public/
│       └── index.html        # WebUI 前端（Vue 3 SPA）
├── prisma/
│   ├── schema.prisma         # 数据库 Schema
│   └── migrations/           # 迁移历史
├── data/                     # SQLite 数据库（持久化卷）
├── docs/                     # 项目文档
├── docker-compose.yml
├── Dockerfile
└── .env
```

---

## 许可证

MIT
