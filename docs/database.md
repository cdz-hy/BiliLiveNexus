# BiliLiveNexus 数据库结构文档

> 数据库引擎：SQLite（通过 Prisma ORM 管理）
> 数据库文件：`data/nexus.db`
> Schema 定义：`prisma/schema.prisma`

---

## ER 关系图

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│  Streamer   │       │  ReplyRule   │       │IgnoredUser  │
│─────────────│       │──────────────│       │─────────────│
│ id (PK)     │       │ id (PK)      │       │ id (PK)     │
│ uid         │       │ name         │       │ uid (UNIQUE)│
│ roomId?     │       │ priority     │       │ note?       │
│ uname?      │       │ matchType    │       │ createdAt   │
│ name?       │       │ keyword      │       └─────────────┘
│ title?      │       │ responseType │
│ description?│       │ content      │
│ cover?      │       │ isEnabled    │
│ groupId     │       └──────────────┘
│ isLive      │
│ lastLive?   │
│ updatedAt   │
└─────────────┘

┌──────────────┐  1:N  ┌─────────────┐
│ ChatSession  │──────▶│ ChatMessage │
│──────────────│       │─────────────│
│ id (PK)      │       │ id (PK)     │
│ updatedAt    │       │ sessionId(FK│
└──────────────┘       │ role        │
                       │ content     │
                       │ createdAt   │
                       └─────────────┘

┌────────────────┐
│ SystemSetting  │  (Key-Value 全局配置)
│────────────────│
│ key (PK)       │
│ value          │
│ updatedAt      │
└────────────────┘
```

---

## 表结构详解

### 1. Streamer（主播订阅表）

存储需要监控的 B 站主播信息。系统启动时自动为每个唯一房间建立弹幕 WebSocket 连接。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | Int | PK, 自增 | 主键 |
| `uid` | String | — | 用户输入的 B 站房间号（可能是短号） |
| `roomId` | String? | 可空 | 解析后的真实房间号（系统自动填充，用于弹幕 WS 连接） |
| `uname` | String? | 可空 | UP 主名称（B 站 API 自动获取） |
| `name` | String? | 可空 | 用户自定义备注名 |
| `title` | String? | 可空 | 当前直播间标题（自动更新） |
| `description` | String? | 可空 | 直播间简介 |
| `cover` | String? | 可空 | 直播间封面图 URL |
| `groupId` | String | — | 通知目标 QQ 群号 |
| `isLive` | Boolean | 默认 false | 当前是否在播 |
| `lastLive` | DateTime? | 可空 | 最前一次开播时间（用于 5 分钟冷却防刷） |
| `updatedAt` | DateTime | 自动更新 | 记录最后更新时间 |

**业务规则：**
- 同一 `uid` 可关联多个 `groupId`（一个主播通知多个群），系统只建一个 WS 连接
- `uid` 是用户输入（可能是短号），`roomId` 是通过 B 站 API 解析的真实房间号
- `uname`、`title`、`description`、`cover` 在添加时通过 B 站 API 自动获取，开播时自动刷新
- `lastLive` 用于去重：5 分钟内重复开播事件会被忽略
- `isLive` 在开播/下播时由 NotificationService 自动切换

---

### 2. ReplyRule（智能回复策略表）

定义机器人的关键词匹配规则，命中后直接回复，不进入 LLM 流程。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | Int | PK, 自增 | 主键 |
| `name` | String | 默认 "unnamed rule" | 策略名称 |
| `priority` | Int | 默认 0 | 优先级（越高越先匹配） |
| `matchType` | String | — | 匹配方式：`EXACT` / `CONTAINS` / `REGEX` |
| `keyword` | String | — | 关键词或正则表达式 |
| `responseType` | String | — | 回复类型：`TEXT` / `IMAGE` / `FUNCTION` |
| `content` | String | — | 回复内容（文本 / 图片链接 / 函数名） |
| `isEnabled` | Boolean | 默认 true | 是否启用 |

**匹配逻辑：**
1. 按 `priority` 降序排列逐条匹配
2. 支持多条规则同时命中，结果合并发送
3. 命中任意规则后不再调用 LLM

---

### 3. ChatSession（LLM 会话表）

持久化 LLM 对话的会话上下文，支持多轮对话记忆。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | String | PK | 会话 ID（通常为用户 QQ 号或群号） |
| `updatedAt` | DateTime | 默认 now() | 最后活跃时间 |

---

### 4. ChatMessage（LLM 消息表）

存储每轮对话的具体消息内容。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | Int | PK, 自增 | 主键 |
| `sessionId` | String | FK → ChatSession | 所属会话 ID |
| `role` | String | — | 角色：`user` / `assistant` / `system` |
| `content` | String | — | 消息内容 |
| `createdAt` | DateTime | 默认 now() | 创建时间 |

**关联关系：**
- `sessionId` 外键关联 `ChatSession.id`，级联删除
- 取最近 5~10 条消息作为 LLM 上下文

---

### 5. SystemSetting（全局配置表）

Key-Value 结构的系统配置存储。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `key` | String | PK | 配置键名 |
| `value` | String | — | 配置值（JSON 字符串或纯文本） |
| `updatedAt` | DateTime | 自动更新 | 最后更新时间 |

**已使用的键名：**

| 键名 | 值格式 | 说明 |
|------|--------|------|
| `llm_provider` | `"spark"` 或 `"openai"` | 当前激活的 LLM 提供商 |
| `system_prompt` | 纯文本 | LLM 系统人设 Prompt |
| `spark_config` | `{"appId":"...","apiSecret":"...","apiKey":"..."}` | 讯飞星火密钥 |
| `openai_config` | `{"apiKey":"...","baseUrl":"...","model":"..."}` | OpenAI 兼容模型配置 |

---

### 6. IgnoredUser（忽略名单表）

被忽略的用户 @机器人时不会收到任何回应。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | Int | PK, 自增 | 主键 |
| `uid` | String | UNIQUE | 用户 QQ 号（唯一约束） |
| `note` | String? | 可空 | 备注说明 |
| `createdAt` | DateTime | 默认 now() | 添加时间 |

---

## 数据流关系

```
B站弹幕 WS（LIVE/PREPARING）
    │
    ▼
LiveMonitorService ──提取 roomId──▶ NotificationService
                                        │
外部 Webhook（POST /webhook/bili）──────┘
                                        │
                                        ▼
Streamer 查询 ──未找到──▶ 忽略
    │找到
    ▼
5 分钟冷却检查 ──重复──▶ 忽略
    │通过
    ▼
NapCat 发送群通知（@全体 + 封面图）

QQ 群 @机器人消息
    │
    ▼
IgnoredUser 过滤 ──命中──▶ 丢弃
    │未命中
    ▼
ReplyRule 匹配 ──命中──▶ 组合回复发送
    │未命中
    ▼
ChatSession/ChatMessage ──▶ LLM 适配器 ──▶ 回复发送
```

---

## 迁移历史

| 迁移文件 | 说明 |
|----------|------|
| `20260219135331_add_llm_config` | 新增 ChatSession、ChatMessage 表（LLM 记忆功能） |
| `20260220130011_init_ignored_user` | 新增 IgnoredUser 表 |
| `20260503175622_add_room_id` | Streamer 模型新增 `roomId` 字段（弹幕 WS 连接用） |
| `20260503180839_add_room_info` | Streamer 模型新增 `uname`、`title`、`description`、`cover` 字段（直播间信息） |
