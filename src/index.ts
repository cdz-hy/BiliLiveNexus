
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { NapCatClient, WebhookService, BotService } from './services/index';
import { logger } from './utils/logger';
import { stats } from './utils/stats';

const app: FastifyInstance = Fastify({ logger: true });
const db = new PrismaClient();

// 初始化核心服务
const napcat = new NapCatClient();
const webhookService = new WebhookService(db, napcat);
const botService = new BotService(db, napcat);

app.register(cors);

// ========================
// 安全插件
// ========================
// 暂时注释掉限流插件，因为可能导致 502 错误
// app.register(require('@fastify/rate-limit'), {
//     global: false, // 默认不开启全局限制，防止误伤静态资源
//     max: 100,
//     timeWindow: '1 minute'
// });

// ========================
// 认证中间件
// ========================
const NEXUS_PASSWORD = process.env.NEXUS_PASSWORD;

app.addHook('preHandler', async (req, reply) => {
    // 排除 WebHook 接口、根路径(Bot上报)、登录接口，以及静态资源中的图片/样式
    if (req.url.startsWith('/webhook') || req.url === '/' || req.url === '/api/login' || req.url === '/index.html' || !NEXUS_PASSWORD) {
        return;
    }

    // 检查 Cookie 中的认证信息
    const auth = req.headers.authorization;
    if (auth !== NEXUS_PASSWORD) {
        reply.code(401).send({ error: 'Unauthorized' });
    }
});

// 简易内存限流器 (IP -> { count, resetTime }) (不需要依赖外部插件，更稳定)
const loginAttempts = new Map<string, { count: number, resetTime: number }>();

app.post('/api/login', async (req: any, reply) => {
    const ip = req.ip;
    const now = Date.now();

    // 获取或初始化记录
    let record = loginAttempts.get(ip);
    if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + 60 * 1000 }; // 1分钟窗口
        loginAttempts.set(ip, record);
    }

    // 检查是否超限
    if (record.count >= 5) {
        return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' });
    }

    // 增加计数
    record.count++;

    const { password } = req.body;
    if (!NEXUS_PASSWORD || password === NEXUS_PASSWORD) {
        // 登录成功重置计数
        loginAttempts.delete(ip);
        return { status: 'ok', token: NEXUS_PASSWORD };
    }
    reply.code(401).send({ error: 'Invalid password' });
});

// 注册静态文件服务 (WebUI)
const publicPath = require('fs').existsSync(path.join(process.cwd(), 'public'))
    ? path.join(process.cwd(), 'public')
    : path.join(process.cwd(), 'src/public');

app.register(fastifyStatic, {
    root: publicPath,
    prefix: '/', // 访问根路径即访问 index.html
});

// ========================
// Bot & Webhook 路由
// ========================

app.post('/webhook/bili', async (req: any, reply: any) => {
    const event = req.body;
    app.log.info({ msg: 'Received Bili Webhook', event });
    await webhookService.handleStreamEvent(event);
    return { status: 'ok' };
});

app.post('/', async (req: any, reply: any) => {
    const event = req.body;

    // 简易脱敏日志
    try {
        const sensitiveKeys = ['token', 'password', 'Authorization'];
        const logEvent = JSON.parse(JSON.stringify(event, (key, value) => {
            if (sensitiveKeys.includes(key)) return '***';
            // 脱敏 QQ 号和群号的中间几位
            if ((key === 'user_id' || key === 'group_id') && typeof value === 'number') {
                const s = String(value);
                return s.length > 4 ? `${s.slice(0, 2)}****${s.slice(-2)}` : value;
            }
            return value;
        }));

        // 记录非心跳包的重要事件
        if (event.post_type === 'message') {
            app.log.info({ msg: 'Received Message Event', type: event.message_type, user: logEvent.user_id });
        } else if (event.post_type !== 'meta_event') {
            app.log.info({ msg: 'Received Event', type: event.post_type, detail: logEvent });
        }
    } catch (e) { }

    botService.handleGroupMessage(event).catch(err => {
        app.log.error(err);
    });
    return { status: 'ok' };
});

// ========================
// WebUI API
// ========================

// 获取所有主播配置
app.get('/api/streamers', async () => {
    return await db.streamer.findMany({ orderBy: { updatedAt: 'desc' } });
});

// 添加主播
app.post('/api/streamers', async (req: any) => {
    const { uid, groupId, name } = req.body;
    // 转换 groupId 为 string
    return await db.streamer.create({
        data: { uid: String(uid), groupId: String(groupId), name }
    });
});

// 删除主播
app.delete('/api/streamers/:id', async (req: any) => {
    const { id } = req.params;
    return await db.streamer.delete({ where: { id: Number(id) } });
});

// 获取回复规则
app.get('/api/rules', async () => {
    return await db.replyRule.findMany({ orderBy: { priority: 'desc' } });
});

// 添加回复规则
app.post('/api/rules', async (req: any) => {
    const { name, keyword, content, type, matchType } = req.body;
    return await db.replyRule.create({
        data: {
            name,
            keyword,
            content,
            matchType: matchType || 'CONTAINS',
            responseType: type || 'TEXT'
        }
    });
});

// 删除回复规则
app.delete('/api/rules/:id', async (req: any) => {
    const { id } = req.params;
    return await db.replyRule.delete({ where: { id: Number(id) } });
});

// 获取忽略用户名单 (数据脱敏)
app.get('/api/ignored-users', async () => {
    const users = await db.ignoredUser.findMany({ orderBy: { createdAt: 'desc' } });
    return users.map((user: any) => {
        let maskedUid = user.uid;
        if (maskedUid.length >= 5) {
            const visibleLen = Math.floor(maskedUid.length / 3);
            maskedUid = maskedUid.slice(0, visibleLen) + '****' + maskedUid.slice(-visibleLen);
        }
        return { id: user.id, maskedUid, note: user.note, createdAt: user.createdAt };
    });
});

// 添加忽略用户
app.post('/api/ignored-users', async (req: any) => {
    const { uid, note } = req.body;
    // 简单校验
    if (!uid) throw new Error('UID is required');
    return await db.ignoredUser.create({
        data: { uid: String(uid).trim(), note }
    });
});

// 删除忽略用户
app.delete('/api/ignored-users/:id', async (req: any) => {
    const { id } = req.params;
    return await db.ignoredUser.delete({ where: { id: Number(id) } });
});

// 系统状态面板
app.get('/api/stats', async () => {
    return stats.getSummary();
});

// 实时日志
app.get('/api/logs', async () => {
    return logger.getRecentLogs();
});

// ========================
// AI 配置 API
// ========================

// 获取 AI 配置 (自动脱敏 Key)
app.get('/api/config/llm', async () => {
    const provider = await db.systemSetting.findUnique({ where: { key: 'llm_provider' } });
    const sysPrompt = await db.systemSetting.findUnique({ where: { key: 'system_prompt' } });

    // 检查 Key 是否已设置 (返回 boolean 而不是真实值)
    const sparkConfig = await db.systemSetting.findUnique({ where: { key: 'spark_config' } });
    const deepseekConfig = await db.systemSetting.findUnique({ where: { key: 'deepseek_config' } });

    return {
        provider: provider?.value || 'spark',
        systemPrompt: sysPrompt?.value || '',
        hasSparkConfig: !!sparkConfig,
        hasDeepseekConfig: !!deepseekConfig
    };
});

// 保存基础配置 (Provider & Prompt)
app.post('/api/config/llm/base', async (req: any) => {
    const { provider, systemPrompt } = req.body;
    await db.systemSetting.upsert({
        where: { key: 'llm_provider' }, update: { value: provider }, create: { key: 'llm_provider', value: provider }
    });
    await db.systemSetting.upsert({
        where: { key: 'system_prompt' }, update: { value: systemPrompt }, create: { key: 'system_prompt', value: systemPrompt }
    });
    return { status: 'ok' };
});

// 保存 Spark Key (Encrypted/Hidden)
app.post('/api/config/llm/spark', async (req: any) => {
    const { appId, apiSecret, apiKey } = req.body;
    const value = JSON.stringify({ appId, apiSecret, apiKey });
    await db.systemSetting.upsert({
        where: { key: 'spark_config' }, update: { value }, create: { key: 'spark_config', value }
    });
    return { status: 'ok' };
});

// 保存 DeepSeek Key
app.post('/api/config/llm/deepseek', async (req: any) => {
    const { apiKey, baseUrl } = req.body;
    const value = JSON.stringify({ apiKey, baseUrl });
    await db.systemSetting.upsert({
        where: { key: 'deepseek_config' }, update: { value }, create: { key: 'deepseek_config', value }
    });
    return { status: 'ok' };
});

// 测试连接
app.post('/api/config/llm/test', async (req: any) => {
    const { provider } = req.body;
    // 使用 Factory 临时获取特定 adapter 进行测试
    // 注意：BotService 中的 llmFactory 是私有的，无法直接使用，我们需要在 index.ts 中实例化一个 factory 或者让 BotService 暴露
    // 既然 BotService 已经实例化了，我们可以通过 new LLMFactory(db) 新建一个，反正它是无状态的(只读 DB)
    const { LLMFactory } = require('./adapters/llm.adapter');
    const factory = new LLMFactory(db);
    const adapter = factory.getSpecificAdapter(provider);

    const success = await adapter.testConnection();
    return { success };
});


// 启动服务
const start = async () => {
    try {
        const port = Number(process.env.PORT) || 5555;
        await app.listen({ port, host: '0.0.0.0' });
        console.log(`Nexus Backend running on http://0.0.0.0:${port}`);
        console.log(`Serving WebUI from ${path.join(process.cwd(), 'public')}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
