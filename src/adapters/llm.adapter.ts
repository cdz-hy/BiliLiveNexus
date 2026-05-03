/**
 * LLM 适配器层
 * 定义统一接口，实现 OpenAI 兼容 / 讯飞星火 两种模型适配器，工厂类按配置动态切换
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { logger } from '../utils/logger';

/** LLM 适配器统一接口 */
export interface LLMAdapter {
    /** 发送消息并获取回复 */
    chat(sessionId: string, prompt: string): Promise<string>;
    /** 测试 API 连通性 */
    testConnection(): Promise<boolean>;
}

/**
 * OpenAI 兼容适配器
 * 支持任意 OpenAI 兼容 API（DeepSeek、GPT、Moonshot、通义千问等）
 * 可自定义 Base URL 和模型名称
 */
export class OpenAIAdapter implements LLMAdapter {
    private apiKey: string = '';
    private baseUrl: string = 'https://api.deepseek.com';
    private model: string = 'deepseek-chat';

    constructor(private db: PrismaClient) { }

    /** 从数据库加载 API 配置 */
    private async loadConfig() {
        const config = await this.db.systemSetting.findUnique({ where: { key: 'openai_config' } });
        if (config) {
            const data = JSON.parse(config.value);
            this.apiKey = data.apiKey;
            this.baseUrl = data.baseUrl || 'https://api.deepseek.com';
            this.model = data.model || 'deepseek-chat';
        }
    }

    async testConnection(): Promise<boolean> {
        await this.loadConfig();
        try {
            const resp = await axios.post(`${this.baseUrl}/chat/completions`, {
                model: this.model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 5
            }, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }
            });
            return resp.status === 200;
        } catch (e: any) {
            logger.error('OpenAI', `Connection test failed: ${e.message}`);
            return false;
        }
    }

    async chat(sessionId: string, prompt: string): Promise<string> {
        await this.loadConfig();

        const sysPromptSetting = await this.db.systemSetting.findUnique({ where: { key: 'system_prompt' } });
        const systemPrompt = sysPromptSetting?.value || '你是一个可爱的 AI 助手。';

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

        await this.db.chatMessage.create({
            data: { sessionId, role: 'user', content: prompt }
        });

        const history = session.messages.slice(-5).map(m => ({ role: m.role, content: m.content }));
        history.unshift({ role: 'system', content: systemPrompt });
        history.push({ role: 'user', content: prompt });

        try {
            const resp = await axios.post(
                `${this.baseUrl}/chat/completions`,
                { model: this.model, messages: history, stream: false },
                { headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } }
            );

            const reply = resp.data.choices[0].message.content;

            await this.db.chatMessage.create({
                data: { sessionId, role: 'assistant', content: reply }
            });

            return reply;
        } catch (e: any) {
            logger.error('OpenAI', `Chat failed: ${e.message}`);
            return '模型罢工了 QwQ';
        }
    }
}

/**
 * 讯飞星火 Spark 4.0 Ultra 适配器
 * 使用讯飞 Open API 接口
 */
export class SparkAdapter implements LLMAdapter {
    private appId: string = '';
    private apiSecret: string = '';
    private apiKey: string = '';
    private url = 'https://spark-api-open.xf-yun.com/v1/chat/completions';

    constructor(private db: PrismaClient) { }

    /** 从数据库加载配置，未配置则 fallback 到环境变量 */
    private async loadConfig() {
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

        const sysPromptSetting = await this.db.systemSetting.findUnique({ where: { key: 'system_prompt' } });
        const systemPrompt = sysPromptSetting?.value || '你是一位可爱的AI助手';

        // 查询或创建会话
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

        // 构建上下文：取最近 10 条历史
        const history = session.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
        history.unshift({ role: 'system', content: systemPrompt });
        history.push({ role: 'user', content: prompt });

        try {
            const resp = await axios.post(
                this.url,
                { model: '4.0Ultra', messages: history, stream: false },
                { headers: { 'Authorization': `Bearer ${this.apiKey}:${this.apiSecret}` } }
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
 * LLM 工厂类
 * 根据数据库配置动态返回对应的适配器实例
 */
export class LLMFactory {
    constructor(private db: PrismaClient) { }

    /** 获取当前激活的适配器（读取 llm_provider 配置） */
    async getAdapter(): Promise<LLMAdapter> {
        const setting = await this.db.systemSetting.findUnique({ where: { key: 'llm_provider' } });
        const provider = setting?.value || 'spark';

        if (provider === 'openai') {
            return new OpenAIAdapter(this.db);
        }
        return new SparkAdapter(this.db);
    }

    /** 获取指定适配器（用于连接测试） */
    getSpecificAdapter(provider: string): LLMAdapter {
        if (provider === 'openai') return new OpenAIAdapter(this.db);
        return new SparkAdapter(this.db);
    }
}
