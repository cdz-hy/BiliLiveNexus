# BiliLiveNexus 数据库结构文档

> 数据库引擎：SQLite（通过 Prisma ORM 管理）
> 数据库文件：`data/nexus.db`
> Schema 定义：`prisma/schema.prisma`

---

## ER 关系图（文本）

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│  Streamer   │       │  ReplyRule   │       │IgnoredUser  │
│─────────────│       │──────────────│       │─────────────│
│ id (PK)     │       │ id (PK)      │       │ id (PK)     │
│ uid         │       │ name         │       │ uid (UNIQUE)│
│ name?       │       │ priority     │       │ note?       │
│ groupId     │       │ matchType    │       │ createdAt   │
│ isLive      │       │ keyword      │       └─────────────┘
│ lastLive?   │       │ responseType │
│ updatedAt   │       │ content      │
└─────────────┘       │ isEnabled    │
                      └──────────────┘

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

存储需要监控的 B 站主播信息，开播时向关联 QQ 群发送通知。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | Int | PK, 自增 | 主键 |
| `uid` | String | — | B 站房间号 / 主播 UID |
| `name` | String? | 可空 | 主播备注名 |
| `groupId` | String | — | 通知目标 QQ 群号 |
| `isLive` | Boolean | 默认 false | 当前是否在播 |
| `lastLive` | DateTime? | 可空 | 最近一次开播时间（用于 5 分钟冷却防刷） |
| `updatedAt` | DateTime | 自动更新 | 记录最后更新时间 |

**业务规则：**
- 同一 `uid` 可关联多个 `groupId`（一个主播通知多个群）
- `lastLive` 用于 Webhook 去重：5 分钟内重复开播事件会被忽略
- `isLive` 在开播/下播时自动切换

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

**匹配优先级：**
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
- 会话删除时自动清除所有关联消息
- 取最近 5~10 条消息作为 LLM 上下文

---

### 5. SystemSetting（全局配置表）

Key-Value 结构的系统配置存储，用于持久化 LLM 密钥、系统 Prompt 等。

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
用户 @机器人消息
    │
    ▼
IgnoredUser 过滤 ──命中──▶ 丢弃
    │未命中
    ▼
ReplyRule 匹配 ──命中──▶ 组合回复发送
    │未命中
    ▼
ChatSession/ChatMessage ──▶ LLM 适配器 ──▶ 回复发送

B站 Webhook 事件
    │
    ▼
Streamer 查询 ──未找到──▶ 忽略
    │找到
    ▼
NapCat 发送群通知（开播/下播）
```

---

## 迁移历史

| 迁移文件 | 说明 |
|----------|------|
| `20250219130854_init` | 初始建表：Streamer、ReplyRule、SystemSetting、IgnoredUser |
| `20250219132623_add_chat_memory` | 新增 ChatSession、ChatMessage 表（LLM 记忆功能） |
