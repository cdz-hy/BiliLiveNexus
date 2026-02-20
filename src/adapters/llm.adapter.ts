
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { logger } from '../utils/logger'; // 引入 Logger

/**
 * 通用 LLM 适配器接口
 */
export interface LLMAdapter {
    chat(sessionId: string, prompt: string): Promise<string>;
    testConnection(): Promise<boolean>;
}

/**
 * DeepSeek 适配器 
 */
export class DeepSeekAdapter implements LLMAdapter {
    private apiKey: string = '';
    private baseUrl: string = 'https://api.deepseek.com';

    constructor(private db: PrismaClient) { }

    private async loadConfig() {
        const config = await this.db.systemSetting.findUnique({ where: { key: 'deepseek_config' } });
        if (config) {
            const data = JSON.parse(config.value);
            this.apiKey = data.apiKey;
            this.baseUrl = data.baseUrl || 'https://api.deepseek.com';
        }
    }

    async testConnection(): Promise<boolean> {
        await this.loadConfig();
        try {
            const resp = await axios.post(`${this.baseUrl}/chat/completions`, {
                model: "deepseek-chat",
                messages: [{ role: "user", content: "Hi" }],
                max_tokens: 5
            }, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }
            });
            return resp.status === 200;
        } catch (e: any) {
            logger.error('DeepSeek', `Connection test failed: ${e.message}`);
            return false;
        }
    }

    async chat(sessionId: string, prompt: string): Promise<string> {
        await this.loadConfig();

        // 获取 System Prompt
        const sysPromptSetting = await this.db.systemSetting.findUnique({ where: { key: 'system_prompt' } });
        const systemPrompt = sysPromptSetting?.value || '你是一个可爱的 AI 助手。';

        // 历史上下文逻辑 (复用 Prisma)
        let session = await this.db.chatSession.findUnique({
            where: { id: sessionId },
            include: { messages: true }
        });

        if (!session) {
            session = await this.db.chatSession.create({
                data: { id: sessionId }, // System Prompt 动态获取，不再硬编码在数据库
                include: { messages: true }
            });
        }

        // 存入新消息
        await this.db.chatMessage.create({
            data: { sessionId, role: 'user', content: prompt }
        });

        // 构建历史消息
        const history = session.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
        history.unshift({ role: 'system', content: systemPrompt });
        history.push({ role: 'user', content: prompt });

        try {
            const resp = await axios.post(
                `${this.baseUrl}/chat/completions`,
                {
                    model: 'deepseek-chat',
                    messages: history,
                    stream: false
                },
                { headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } }
            );

            const reply = resp.data.choices[0].message.content;

            await this.db.chatMessage.create({
                data: { sessionId, role: 'assistant', content: reply }
            });

            return reply;
        } catch (e: any) {
            logger.error('DeepSeek', `Chat failed: ${e.message}`);
            return 'DeepSeek 罢工了 QwQ';
        }
    }
}

/**
 * 讯飞星火 Spark 4.0 Ultra 适配器
 */
export class SparkAdapter implements LLMAdapter {
    private appId: string = '';
    private apiSecret: string = '';
    private apiKey: string = '';
    private url = 'https://spark-api-open.xf-yun.com/v1/chat/completions';

    constructor(private db: PrismaClient) { }

    private async loadConfig() {
        // 优先读取数据库配置，没有则读环境变量
        const config = await this.db.systemSetting.findUnique({ where: { key: 'spark_config' } });
        if (config) {
            const data = JSON.parse(config.value);
            this.appId = data.appId;
            this.apiSecret = data.apiSecret;
            this.apiKey = data.apiKey;
        } else {
            this.appId = process.env.XF_APPID || '';
            this.apiSecret = process.env.XF_API_SECRET || '';
            this.apiKey = process.env.XF_API_KEY || '';
        }
    }

    async testConnection(): Promise<boolean> {
        await this.loadConfig();
        try {
            const resp = await axios.post(this.url, {
                model: '4.0Ultra',
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 5
            }, {
                headers: { 'Authorization': `Bearer ${this.apiKey}:${this.apiSecret}` }
            });
            return resp.status === 200;
        } catch (e: any) {
            logger.error('Spark', `Test failed: ${e.message}`);
            return false;
        }
    }

    async chat(sessionId: string, prompt: string): Promise<string> {
        await this.loadConfig();

        // 获取 System Prompt
        const sysPromptSetting = await this.db.systemSetting.findUnique({ where: { key: 'system_prompt' } });
        // 默认值与之前保持一致
        const defaultSys = `你是一位可爱的AI助手`;
        const systemPrompt = sysPromptSetting?.value || defaultSys;

        let session = await this.db.chatSession.findUnique({
            where: { id: sessionId },
            include: { messages: true }
        });

        if (!session) {
            session = await this.db.chatSession.create({
                data: { id: sessionId },
                include: { messages: true }
            });
        }

        await this.db.chatMessage.create({ data: { sessionId, role: 'user', content: prompt } });

        const history = session.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
        history.unshift({ role: 'system', content: systemPrompt });
        history.push({ role: 'user', content: prompt });

        try {
            const resp = await axios.post(
                this.url,
                {
                    model: '4.0Ultra',
                    messages: history,
                    stream: false
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}:${this.apiSecret}`
                    }
                }
            );

            const reply = resp.data.choices[0].message.content;
            await this.db.chatMessage.create({ data: { sessionId, role: 'assistant', content: reply } });
            return reply;
        } catch (e: any) {
            logger.error('Spark', `API Error: ${e.message}`);
            return '呜呜，大脑过载了，等一下再试吧～';
        }
    }
}

/**
 * 工厂类：管理当前激活的 LLM
 */
export class LLMFactory {
    constructor(private db: PrismaClient) { }

    async getAdapter(): Promise<LLMAdapter> {
        const setting = await this.db.systemSetting.findUnique({ where: { key: 'llm_provider' } });
        const provider = setting?.value || 'spark'; // 默认 Spark

        if (provider === 'deepseek') {
            return new DeepSeekAdapter(this.db);
        }
        return new SparkAdapter(this.db);
    }

    // 临时获取特定 adapter 用于测试
    getSpecificAdapter(provider: string): LLMAdapter {
        if (provider === 'deepseek') return new DeepSeekAdapter(this.db);
        return new SparkAdapter(this.db);
    }
}
