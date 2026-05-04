/**
 * WebUI 管理 API 路由
 * 包含：NapCat 事件上报、系统状态、主播/规则/忽略名单 CRUD、AI 配置管理
 */
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { BotService } from '../services/bot';
import { LiveMonitorService } from '../services/live-monitor';
import { LLMFactory } from '../adapters/llm.adapter';
import { stats } from '../utils/stats';
import { logger } from '../utils/logger';

export async function apiRoutes(app: FastifyInstance, db: PrismaClient, bot: BotService, liveMonitor: LiveMonitorService) {
    const llmFactory = new LLMFactory(db);

    // ========================
    // NapCat 事件上报入口
    // ========================
    app.post('/', async (req: any, reply: any) => {
        const event = req.body;

        // 脱敏与系统日志记录
        try {
            if (event.post_type === 'notice') {
                logger.info('NapCat', `Received Notice: ${event.notice_type} (User: ${event.user_id})`);
            } else if (event.post_type === 'request') {
                logger.info('NapCat', `Received Request: ${event.request_type} (User: ${event.user_id})`);
            } else if (event.post_type !== 'meta_event' && event.post_type !== 'message') {
                logger.info('NapCat', `Received Event: ${event.post_type}`);
            }
            // message 由 BotService 单独处理并脱敏打印，meta_event（心跳）直接忽略以防刷屏
        } catch { }

        // 异步处理群消息，不阻塞响应
        bot.handleGroupMessage(event).catch(err => app.log.error(err));
        return { status: 'ok' };
    });

    // ========================
    // 系统监控
    // ========================

    /** 系统运行状态（内存、计数器等） */
    app.get('/api/stats', async () => stats.getSummary());

    /** 实时日志（最近 200 条，已脱敏） */
    app.get('/api/logs', async () => logger.getRecentLogs());

    // ========================
    // 主播管理 CRUD
    // ========================
    app.get('/api/streamers', async () => {
        return db.streamer.findMany({ orderBy: { updatedAt: 'desc' } });
    });

    app.post('/api/streamers', async (req: any, reply: any) => {
        const { uid, groupId, name } = req.body;

        // 先校验房间是否存在
        let realRoomId: string;
        try {
            realRoomId = await liveMonitor.resolveRoomId(String(uid));
        } catch (e: any) {
            logger.warn('API', `Room validation failed for uid ${uid}: ${e.message}`);
            return reply.code(400).send({ error: e.message || '房间不存在' });
        }

        // 获取直播间信息
        const roomInfo = await liveMonitor.fetchRoomInfo(realRoomId);

        const streamer = await db.streamer.create({
            data: {
                uid: String(uid),
                groupId: String(groupId),
                name: name || undefined,
                roomId: realRoomId,
                uname: roomInfo?.uname || undefined,
                title: roomInfo?.title || undefined,
                description: roomInfo?.description || undefined,
                cover: roomInfo?.cover || undefined,
            }
        });
        // 触发直播监控连接该房间
        liveMonitor.addStreamer(String(uid)).catch(err => {
            logger.error('API', `Failed to start monitoring uid ${uid}: ${err.message}`);
        });
        return streamer;
    });

    app.delete('/api/streamers/:id', async (req: any) => {
        const streamer = await db.streamer.findUnique({ where: { id: Number(req.params.id) } });
        const result = await db.streamer.delete({ where: { id: Number(req.params.id) } });
        // 删除后检查是否需要断开监控连接
        if (streamer) {
            liveMonitor.removeStreamer(streamer.uid).catch(err => {
                logger.error('API', `Failed to clean up monitoring for uid ${streamer.uid}: ${err.message}`);
            });
        }
        return result;
    });

    // ========================
    // 回复规则 CRUD
    // ========================
    app.get('/api/rules', async () => {
        return db.replyRule.findMany({ orderBy: { priority: 'desc' } });
    });

    app.post('/api/rules', async (req: any) => {
        const { name, keyword, content, type, matchType } = req.body;
        return db.replyRule.create({
            data: {
                name,
                keyword,
                content,
                matchType: matchType || 'CONTAINS',
                responseType: type || 'TEXT'
            }
        });
    });

    app.delete('/api/rules/:id', async (req: any) => {
        return db.replyRule.delete({ where: { id: Number(req.params.id) } });
    });

    // ========================
    // 忽略名单 CRUD
    // ========================

    /** 获取忽略名单（UID 脱敏显示） */
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

    app.post('/api/ignored-users', async (req: any) => {
        const { uid, note } = req.body;
        if (!uid) throw new Error('UID is required');
        return db.ignoredUser.create({
            data: { uid: String(uid).trim(), note }
        });
    });

    app.delete('/api/ignored-users/:id', async (req: any) => {
        return db.ignoredUser.delete({ where: { id: Number(req.params.id) } });
    });

    // ========================
    // AI / LLM 配置管理
    // ========================

    /** 获取 AI 配置（API Key 不返回明文） */
    app.get('/api/config/llm', async () => {
        const provider = await db.systemSetting.findUnique({ where: { key: 'llm_provider' } });
        const sysPrompt = await db.systemSetting.findUnique({ where: { key: 'system_prompt' } });
        const sparkConfig = await db.systemSetting.findUnique({ where: { key: 'spark_config' } });
        const openaiConfig = await db.systemSetting.findUnique({ where: { key: 'openai_config' } });
        const deepseekConfig = await db.systemSetting.findUnique({ where: { key: 'deepseek_config' } });

        return {
            provider: provider?.value || 'spark',
            systemPrompt: sysPrompt?.value || '',
            hasSparkConfig: !!sparkConfig,
            hasOpenaiConfig: !!(openaiConfig || deepseekConfig)
        };
    });

    /** 保存基础配置：模型提供商与 System Prompt */
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

    /** 保存讯飞星火密钥 */
    app.post('/api/config/llm/spark', async (req: any) => {
        const { appId, apiSecret, apiKey } = req.body;
        const value = JSON.stringify({ appId, apiSecret, apiKey });
        await db.systemSetting.upsert({
            where: { key: 'spark_config' }, update: { value }, create: { key: 'spark_config', value }
        });
        // 保存配置时自动激活该引擎
        await db.systemSetting.upsert({
            where: { key: 'llm_provider' }, update: { value: 'spark' }, create: { key: 'llm_provider', value: 'spark' }
        });
        return { status: 'ok' };
    });

    /** 保存 OpenAI 兼容模型密钥 */
    app.post('/api/config/llm/openai', async (req: any) => {
        const { apiKey, baseUrl, model } = req.body;
        const value = JSON.stringify({ apiKey, baseUrl, model });
        await db.systemSetting.upsert({
            where: { key: 'openai_config' }, update: { value }, create: { key: 'openai_config', value }
        });
        // 保存配置时自动激活该引擎
        await db.systemSetting.upsert({
            where: { key: 'llm_provider' }, update: { value: 'openai' }, create: { key: 'llm_provider', value: 'openai' }
        });
        return { status: 'ok' };
    });

    /** 测试指定 LLM 提供商的连通性 */
    app.post('/api/config/llm/test', async (req: any) => {
        const { provider } = req.body;
        const adapter = llmFactory.getSpecificAdapter(provider);
        const success = await adapter.testConnection();
        return { success };
    });
}
