/**
 * 认证插件
 * 注册 JWT 鉴权、请求拦截中间件及登录端点（含 IP 限流）
 */
import { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { config } from '../config';

/** 无需认证的公开路径 */
const PUBLIC_PATHS = ['/api/login', '/webhook/bili', '/'];

export async function registerAuth(app: FastifyInstance) {
    // 注册 JWT 插件
    app.register(fastifyJwt, { secret: config.jwtSecret });

    // 登录限流表：IP -> { 计数, 窗口重置时间 }
    const loginAttempts = new Map<string, { count: number; resetTime: number }>();

    // 全局前置钩子：校验 /api/* 请求的 JWT
    app.addHook('preHandler', async (req, reply) => {
        // 公开路径与非 API 路径跳过认证
        if (PUBLIC_PATHS.some(p => req.url === p) || req.url.startsWith('/webhook')) {
            return;
        }
        if (!req.url.startsWith('/api/') || !config.nexusPassword) {
            return;
        }
        try {
            await req.jwtVerify();
        } catch {
            reply.code(401).send({ error: 'Unauthorized' });
        }
    });

    // 登录端点：验证密码，签发 JWT（8 小时有效）
    app.post('/api/login', async (req: any, reply) => {
        const ip = req.ip;
        const now = Date.now();

        // 检查并更新限流计数
        let record = loginAttempts.get(ip);
        if (!record || now > record.resetTime) {
            record = { count: 0, resetTime: now + 60_000 };
            loginAttempts.set(ip, record);
        }
        if (record.count >= 5) {
            return reply.code(429).send({ error: 'Too many login attempts. Please try again later.' });
        }
        record.count++;

        const { password } = req.body;
        if (!config.nexusPassword || password === config.nexusPassword) {
            loginAttempts.delete(ip);
            const token = app.jwt.sign({ role: 'admin' }, { expiresIn: '8h' });
            return { status: 'ok', token };
        }
        reply.code(401).send({ error: 'Invalid password' });
    });
}
