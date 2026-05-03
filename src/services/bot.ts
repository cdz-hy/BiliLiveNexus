/**
 * QQ 群聊机器人服务
 * 处理群消息：忽略名单过滤 → 回复规则匹配 → LLM 兜底回复
 */
import { PrismaClient } from '@prisma/client';
import { LLMFactory } from '../adapters/llm.adapter';
import { NapCatClient } from './napcat';
import { config } from '../config';
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';

export class BotService {
    private llmFactory: LLMFactory;

    constructor(
        private db: PrismaClient,
        private napcat: NapCatClient
    ) {
        this.llmFactory = new LLMFactory(db);
    }

    /**
     * 处理群消息事件
     * @param msg NapCat 上报的消息事件对象
     */
    async handleGroupMessage(msg: any) {
        // 仅处理群消息类型
        if (msg.post_type !== 'message' || msg.message_type !== 'group') return;
        stats.totalMessages++;

        if (!msg.message) return;

        const groupId = msg.group_id;
        const userId = msg.user_id;
        const rawText = msg.raw_message || '';

        // 检查是否 @ 了机器人
        const isAtMe = msg.message.some((m: any) => m.type === 'at' && m.data.qq == config.botQqId);

        if (!isAtMe) {
            return;
        }

        // 检查忽略名单
        const isIgnored = await this.db.ignoredUser.findFirst({
            where: { uid: String(userId) }
        });

        if (isIgnored) {
            return;
        }

        logger.info('Bot', `Received @mention from ${userId} in Group ${groupId}: ${rawText.slice(0, 50)}...`);

        // 清理 CQ 码中的 @ 标记，提取纯文本
        const cleanText = rawText.replace(/\[CQ:at,qq=\d+\]/g, '').trim();

        // ---- 阶段一：回复规则匹配 ----
        const rules = await this.db.replyRule.findMany({
            where: { isEnabled: true },
            orderBy: { priority: 'desc' }
        });

        let hasMatchedAnyRule = false;
        const combinedReplyMsg: any[] = [];

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
                hasMatchedAnyRule = true;
                stats.ruleHits++;
                logger.info('Rule', `Matched rule "${rule.name}" for keyword "${cleanText}"`);

                if (rule.responseType === 'TEXT') {
                    combinedReplyMsg.push({ type: 'text', data: { text: rule.content + '\n' } });
                } else if (rule.responseType === 'IMAGE') {
                    combinedReplyMsg.push({ type: 'image', data: { file: rule.content } });
                }
            }
        }

        // 命中规则则直接返回，不进入 LLM 流程
        if (hasMatchedAnyRule) {
            await this.napcat.sendGroupMsg(groupId, combinedReplyMsg);
            return;
        }

        // ---- 阶段二：LLM 兜底回复 ----
        stats.llmCalls++;

        // 日志脱敏：隐藏用户输入内容
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
            const adapter = await this.llmFactory.getAdapter();
            logger.info('LLM', `当前正在使用的模型引擎是: ${adapter.constructor.name}`);
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
