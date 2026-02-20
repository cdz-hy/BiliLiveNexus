
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { LLMFactory } from '../adapters/llm.adapter'; // Change import to Factory
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';

/**
 * NapCat 客户端封装
 */
export class NapCatClient {
    private baseUrl: string;
    private token: string;

    private requestTimestamps: number[] = [];

    constructor() {
        this.baseUrl = process.env.NAPCAT_URL || 'http://localhost:3000';
        this.token = process.env.NAPCAT_TOKEN || '';
    }

    private checkRateLimit(): boolean {
        const now = Date.now();
        // 清理 1 分钟前的记录
        this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60000);
        if (this.requestTimestamps.length >= 10) {
            return false;
        }
        this.requestTimestamps.push(now);
        return true;
    }

    async sendGroupMsg(groupId: number, message: any[]): Promise<boolean> {
        if (!this.checkRateLimit()) {
            logger.error('NapCat', `触发呼叫频率限制（>10次/分钟）！已丢弃给群 ${groupId} 的消息。`);
            return false;
        }

        try {
            logger.info('NapCat', `Sending to Group ${groupId}: ${JSON.stringify(message[0].data)}...`);
            const res = await axios.post(
                `${this.baseUrl}/send_group_msg`,
                { group_id: groupId, message, auto_escape: false },
                { headers: { Authorization: `Bearer ${this.token}` } }
            );

            if (res.data && res.data.status === 'failed') {
                throw new Error(res.data.msg || res.data.wording || 'API Error');
            }
            return true;
        } catch (e: any) {
            logger.error('NapCat', `Failed to send to Group ${groupId}: ${e.message}`);
            return false;
        }
    }
}

/**
 * Webhook 服务：处理 B站开播通知
 */
export class WebhookService {
    constructor(private db: PrismaClient, private napcat: NapCatClient) { }

    async handleStreamEvent(event: any) {
        stats.webhookHits++;

        const { EventType, EventData } = event;
        logger.info('Webhook', `Received event: ${EventType} / ${EventData?.Title || EventData?.RoomId}`);

        if (EventType !== 'StreamStarted' && EventType !== 'StreamEnded') return;

        const { RoomId, Title, CoverFromUser } = EventData;

        // 查找该主播的所有订阅（支持一个主播通知多个群）
        const streamers = await this.db.streamer.findMany({
            where: { uid: RoomId.toString() }
        });

        if (streamers.length === 0) {
            logger.warn('Webhook', `Ignoring unconfigured streamer RoomID: ${RoomId}`);
            return;
        }

        for (const streamer of streamers) {
            if (EventType === 'StreamStarted') {
                const now = new Date();

                // 检查 5 分钟冷却期，防止频繁通知
                if (streamer.lastLive) {
                    const timeDiff = now.getTime() - streamer.lastLive.getTime();
                    if (timeDiff < 5 * 60 * 1000) { // 5 分钟内
                        logger.warn('Webhook', `Blocked frequent StreamStarted notification for ${streamer.name} to Group ${streamer.groupId} (Cooldown: ${Math.round((5 * 60 * 1000 - timeDiff) / 1000)}s)`);
                        continue;
                    }
                }

                const msgWithAtAll = [
                    { type: 'at', data: { qq: 'all' } },
                    { type: 'text', data: { text: `\nUP 主 ${streamer.name || ''} 开播啦！\n标题：${Title}\n直播间：https://live.bilibili.com/${RoomId}\n` } },
                    { type: 'image', data: { file: CoverFromUser } }
                ];

                // 优先尝试发送 @全体成员
                let success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithAtAll);

                // 若失败（通常是因为机器人不是管理员没有@all权限），回退到发送普通消息
                if (!success) {
                    logger.warn('Webhook', `给群 ${streamer.groupId} 发送 @全体 失败，系统自动降级发送普通无@消息...`);
                    const msgWithoutAtAll = [
                        { type: 'text', data: { text: `${streamer.name || ''} 开播啦！\n标题：${Title}\n直播间：https://live.bilibili.com/${RoomId}\n` } },
                        { type: 'image', data: { file: CoverFromUser } }
                    ];
                    success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithoutAtAll);
                }

                // 若发送成功才算作真正打卡
                if (success) {
                    await this.db.streamer.update({
                        where: { id: streamer.id },
                        data: { isLive: true, lastLive: now }
                    });
                    logger.info('Bot', `Sent StreamStarted notification for ${streamer.name} to Group ${streamer.groupId}`);
                }
            } else {
                await this.napcat.sendGroupMsg(Number(streamer.groupId), [
                    { type: 'text', data: { text: `主播下播啦 QwQ` } }
                ]);
                await this.db.streamer.update({
                    where: { id: streamer.id },
                    data: { isLive: false }
                });
                logger.info('Bot', `Sent StreamEnded notification for ${streamer.name} to Group ${streamer.groupId}`);
            }
        }
    }
}

/**
 * 机器人服务：处理回复逻辑
 */
export class BotService {
    private llmFactory: LLMFactory;

    constructor(
        private db: PrismaClient,
        private napcat: NapCatClient
    ) {
        this.llmFactory = new LLMFactory(db);
    }

    async handleGroupMessage(msg: any) {
        if (msg.post_type !== 'message' || msg.message_type !== 'group') return;
        stats.totalMessages++;

        // 如果是心跳包等其他事件
        if (!msg.message) return;

        const groupId = msg.group_id;
        const userId = msg.user_id;
        const rawText = msg.raw_message || '';

        console.log(`[DEBUG] Received msg.message: ${JSON.stringify(msg.message)}`);
        console.log(`[DEBUG] Expected BOT_QQ_ID: ${process.env.BOT_QQ_ID}`);

        // 检查是否 @ 了机器人
        const isAtMe = msg.message.some((m: any) => m.type === 'at' && m.data.qq == process.env.BOT_QQ_ID);

        if (!isAtMe) {
            logger.info('BotService', `Message ignored (Not @me): User ${userId}, Group ${groupId}`);
            return;
        }

        // 检查忽略名单
        const isIgnored = await this.db.ignoredUser.findFirst({
            where: { uid: String(userId) }
        });

        if (isIgnored) {
            logger.info('BotService', `Message ignored (User in Ignore List): User ${userId}, Group ${groupId}`);
            return;
        }

        logger.info('BotService', `Handling message from User ${userId} in Group ${groupId}`);

        logger.info('Bot', `Received @mention from ${userId} in Group ${groupId}: ${rawText.slice(0, 50)}...`);

        // 清理 @ 文本，只保留内容
        const cleanText = rawText.replace(/\[CQ:at,qq=\d+\]/g, '').trim();

        // 1. 策略匹配
        const rules = await this.db.replyRule.findMany({
            where: { isEnabled: true },
            orderBy: { priority: 'desc' }
        });

        for (const rule of rules) {
            let matched = false;
            if (rule.matchType === 'EXACT' && cleanText === rule.keyword) matched = true;
            if (rule.matchType === 'CONTAINS' && cleanText.includes(rule.keyword)) matched = true;
            if (rule.matchType === 'REGEX') {
                try {
                    if (new RegExp(rule.keyword).test(cleanText)) matched = true;
                } catch (e: any) {
                    logger.error('Regex', `Invalid regex in rule ${rule.name}: ${e.message}`);
                }
            }

            if (matched) {
                stats.ruleHits++;
                logger.info('Rule', `Matched rule "${rule.name}" for keyword "${cleanText}"`);

                const replyMsg = [];
                if (rule.responseType === 'TEXT') {
                    replyMsg.push({ type: 'text', data: { text: rule.content } });
                } else if (rule.responseType === 'IMAGE') {
                    replyMsg.push({ type: 'image', data: { file: rule.content } });
                }

                await this.napcat.sendGroupMsg(groupId, replyMsg);
                return; // 命中后直接返回
            }
        }

        // 2. LLM 回复
        stats.llmCalls++;

        // 隐私脱敏显示 LLM 的输入问题
        let maskedInput = cleanText;
        if (cleanText.length > 2) {
            maskedInput = cleanText.substring(0, 1) + '***' + cleanText.substring(cleanText.length - 1);
        } else if (cleanText.length === 2) {
            maskedInput = cleanText.substring(0, 1) + '*';
        } else {
            maskedInput = '*';
        }

        logger.info('LLM', `Fallback to LLM for: ${maskedInput}`);

        try {
            const adapter = await this.llmFactory.getAdapter(); // Get current active adapter
            const reply = await adapter.chat(userId.toString(), cleanText);
            await this.napcat.sendGroupMsg(groupId, [
                { type: 'at', data: { qq: userId } },
                { type: 'text', data: { text: ` ${reply}` } }
            ]);
        } catch (e: any) {
            logger.error('LLM', `LLM call failed: ${e.message}`);
        }
    }
}
