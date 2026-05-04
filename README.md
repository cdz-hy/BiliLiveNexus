# BiliLiveNexus

B 站直播通知 + QQ 群聊 AI 机器人后端服务。

本项目作为一个轻量后端，能实现**自主连接 B 站弹幕服务器**检测开播/下播状态并且触发QQ群通知，但需要配合以下外部工具使用：

- **[NapCat](https://napneko.github.io/)** — QQ 机器人框架，负责接收群消息（上报给本程序处理）和发送群通知


工作流程：本程序检测直播状态变化（保留 Webhook 接口，可用弹幕姬进行检测）→查询群通知列表 → 通过 NapCat 向 QQ 群发送通知。群内 @机器人 则触发关键词规则回复或大模型 AI 对话。内置 WebUI 管理控制台。

## 功能概览

- **自主直播监控** — 直连 B 站弹幕 WebSocket 实时检测开播/下播，辅以 HTTP 轮询兜底
- **QQ 群通知** — 开播 @全体 + 封面图 + 颜文字，失败自动降级；5 分钟冷却防刷
- **智能回复** — 关键词规则匹配（精确/包含/正则），命中直接回复，未命中走大模型对话
- **大模型对话** — 支持 OpenAI 兼容接口（DeepSeek / GPT / Qwen 等）和讯飞星火
- **WebUI 控制台** — 仪表盘统计、主播管理、规则配置、忽略名单、大模型设置、系统日志
- **安全机制** — JWT 认证、登录 IP 限流、Webhook 密钥验证、日志脱敏

## 技术栈

Node.js + TypeScript + Fastify 4 + Prisma (SQLite) + Vue 3 (CDN) + Tailwind CSS

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    BiliLiveNexus                        │
│                                                         │
│  ┌─────────────────┐     ┌──────────────────────────┐  │
│  │ LiveMonitorSvc  │────▶│                          │  │
│  │ (弹幕 WS 连接)  │     │   NotificationService    │  │
│  │ + HTTP 轮询兜底  │     │   (通知构建+发送+冷却)    │──▶ NapCat ──▶ QQ 群
│  └─────────────────┘     │                          │  │
│                           └──────────────────────────┘  │
│  ┌─────────────────┐              ▲                     │
│  │ WebhookService  │──────────────┘                     │
│  │ (外部事件适配)   │   POST /webhook/bili (可选)        │
│  └─────────────────┘                                    │
│                                                         │
│  ┌─────────────────┐                                    │
│  │   BotService    │──▶ 规则匹配 / LLM 回复 ──▶ NapCat │
│  │ (群消息处理)     │                                    │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

**直播检测双通道：**
- **主通道** — 弹幕 WebSocket（`bilibili-live-ws`）：实时监听 `LIVE`/`PREPARING` 命令，低延迟
- **备用通道** — HTTP API 轮询（默认 3 分钟间隔）：对比 `live_status` 与数据库状态，兜底防遗漏
- **外部通道** — `POST /webhook/bili`：兼容 BililiveRecorder 等外部工具推送

---

## 部署前准备

### 1. NapCat QQ 机器人

[NapCat](https://napneko.github.io/) 是基于 NTQQ 的 QQ 协议实现框架，本项目通过其 HTTP API 发送群消息。

#### 安装 NapCat

参考 [NapCat 官方文档](https://napneko.github.io/) 安装，推荐使用 Docker 方式部署。

#### 配置 HTTP 服务器

在 NapCat 的 WebUI 中配置 **HTTP 服务器**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 服务器域名 | `0.0.0.0` | 监听所有网卡 |
| 服务器端口 | `3000` | 本项目通过此端口调用 NapCat |
| access-token | 自定义字符串 | 与 `.env` 中 `NAPCAT_TOKEN` 一致 |

#### 配置 HTTP 客户端（消息上报）

本项目需要接收 NapCat 上报的群消息才能处理 @机器人 的请求。在 NapCat 中找到 **HTTP 客户端** 或 **数据上报 HTTP 服务器** 设置项，添加一个上报地址：

```
http://<本程序所在IP>:5555
```

> 网络地址注意：尽量不要使用公网 IP（除非必要），优先使用 Docker 网桥地址或内网地址
> - NapCat 和本程序同机 Docker：`http://172.17.0.1:5555`（Docker 默认网关）
> - NapCat 和本程序同机非 Docker：`http://127.0.0.1:5555`
> - 不同机器：使用内网 IP，如 `http://192.168.x.x:5555`

确保以下选项已开启：

| 配置项 | 状态 |
|--------|------|
| 消息上报 | **开启** |
| 上报 Bot 自身消息 | **开启**（可选） |
| 消息格式 | **Array**（默认值） |

---

## 部署方式

### Docker Compose 部署（推荐）

#### 1. 克隆项目

```bash
# 1. 克隆项目
git clone https://github.com/cdz-hy/BiliLiveNexus.git bililivenexus
cd bililivenexus

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填写实际配置

# 3. 构建并启动
docker-compose build --no-cache
docker-compose up -d

# 4. 访问 WebUI
# 浏览器打开 http://<服务器IP>:5555，使用 NEXUS_PASSWORD 登录
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
JWT_SECRET=（可选不填）
WEBHOOK_SECRET=（可选不填）

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
docker-compose logs -f backend     # 查看日志
docker-compose restart             # 重启（数据保留）
docker-compose down && docker-compose up -d   # 重建容器
docker-compose down -v             # 删除数据卷（慎用！数据库会丢失）
```

### 本地开发

```bash
npm install # 安装依赖
npx prisma generate # 初始化数据库
npx prisma migrate deploy
npm run dev # 启动开发服务器
```

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | `5555` | 服务监听端口 |
| `DATABASE_URL` | 是 | — | SQLite 数据库路径 |
| `NEXUS_PASSWORD` | 是 | — | WebUI 管理密码 |
| `JWT_SECRET` | 否 | 同 `NEXUS_PASSWORD` | JWT 签名密钥 |
| `WEBHOOK_SECRET` | 否 | — | Webhook 验证密钥（可选） |
| `BOT_QQ_ID` | 否 | — | 机器人 QQ 号 |
| `NAPCAT_URL` | 否 | `http://localhost:3000` | NapCat HTTP API 地址 |
| `NAPCAT_TOKEN` | 否 | — | NapCat 的 access-token |
| `LIVE_MONITOR_ENABLED` | 否 | `true` | 是否启用内置直播监控 |
| `LIVE_MONITOR_POLL_INTERVAL` | 否 | `180000` | HTTP 轮询间隔（毫秒） |
| `XF_APPID` | 否 | — | 讯飞星火 APPID |
| `XF_API_SECRET` | 否 | — | 讯飞星火 API Secret |
| `XF_API_KEY` | 否 | — | 讯飞星火 API Key |

---

## WebUI 控制台

登录后可通过侧边栏切换以下功能模块：

| 页面           | 功能                                                         |
| -------------- | ------------------------------------------------------------ |
| **系统概览**   | 运行时长、消息统计、规则命中、AI 调用次数、内存占用图表、最近活动日志 |
| **大模型设置** | 切换 OpenAI 兼容 / 讯飞星火、配置 API 密钥、编辑系统 Prompt、连接测试 |
| **主播监控**   | 添加/删除订阅主播（房间号 + 群号），实时显示在播/离线状态    |
| **回复策略**   | 配置关键词自动回复规则（精确匹配/包含/正则），支持文本和图片回复 |
| **忽略名单**   | 添加/移除被忽略的 QQ 用户，被忽略用户 @机器人 不会收到回应   |
| **系统日志**   | 按级别过滤（INFO/WARN/ERROR），彩色显示，智能滚动            |

<p align="center">
  <img src="https://github.com/user-attachments/assets/132d9e3f-355a-4cf4-9623-0a4ba6a6b99a" alt="WebUI 界面预览" width="800">
</p>

---

## 使用流程

### 添加主播监控

1. 打开 WebUI → 主播监控 → 新增监控
2. 输入 **B站直播间号**（短号或真实房间号均可，系统自动解析）
3. 填写备注名和通知群号
4. 点击添加，系统自动建立弹幕 WebSocket 连接

开播/下播时自动向关联 QQ 群发送通知。

### 配置大模型

1. 打开 WebUI → 大模型设置
2. 选择 OpenAI 兼容模型或讯飞星火
3. 填写 API 密钥，点击测试连接
4. 可编辑系统 Prompt 定制机器人人设

---

## 项目结构

```
src/
├── index.ts                # 应用入口：服务编排、启动、优雅停机
├── config.ts               # 全局配置中心（环境变量）
├── adapters/
│   └── llm.adapter.ts      # LLM 适配器（OpenAI 兼容 / 讯飞星火）
├── plugins/
│   └── auth.ts             # JWT 认证 + 登录限流
├── routes/
│   ├── api.ts              # WebUI 管理 API + NapCat 事件接收
│   └── webhook.ts          # 外部 Webhook 回调（可选通道）
├── services/
│   ├── index.ts            # 统一导出
│   ├── live-monitor.ts     # 直播监控：弹幕 WS 连接 + HTTP 轮询
│   ├── notification.ts     # 通知服务：消息构建、冷却、降级
│   ├── webhook.ts          # Webhook 适配器：事件解析 → NotificationService
│   ├── bot.ts              # 群消息处理：规则匹配 + LLM 兜底
│   └── napcat.ts           # NapCat HTTP API 客户端
├── utils/
│   ├── logger.ts           # 内存日志（脱敏 + 200 条缓存）
│   └── stats.ts            # 运行时统计
└── public/
    └── index.html          # WebUI 前端（Vue 3 SPA）
```

---

## 许可证

MIT
