/**
 * 应用入口
 * 负责初始化服务、注册插件/路由、启动服务器及优雅停机
 */
import dotenv from 'dotenv';
dotenv.config({ override: false });
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { registerAuth } from './plugins/auth';
import { webhookRoutes } from './routes/webhook';
import { apiRoutes } from './routes/api';
import { NapCatClient, WebhookService, BotService, NotificationService, LiveMonitorService } from './services';

// 初始化 Fastify 实例与数据库连接
const app: FastifyInstance = Fastify({ logger: true });
const db = new PrismaClient();

// 初始化核心业务服务
const napcat = new NapCatClient();
const notification = new NotificationService(db, napcat);
const webhookService = new WebhookService(notification);
const botService = new BotService(db, napcat);
const liveMonitor = new LiveMonitorService(db, notification);

// 注册插件：跨域、JWT 认证
app.register(cors);
registerAuth(app);

// 注册静态文件服务（WebUI）
const publicPath = fs.existsSync(path.join(process.cwd(), 'public'))
    ? path.join(process.cwd(), 'public')
    : path.join(process.cwd(), 'src/public');

app.register(fastifyStatic, { root: publicPath, prefix: '/' });

// 注册路由
app.register((instance, _opts, done) => {
    webhookRoutes(instance, webhookService);
    done();
});
app.register((instance, _opts, done) => {
    apiRoutes(instance, db, botService, liveMonitor);
    done();
});

// 启动服务
const start = async () => {
    try {
        await app.listen({ port: config.port, host: '0.0.0.0' });
        console.log(`Nexus Backend running on http://0.0.0.0:${config.port}`);
        console.log(`Serving WebUI from ${publicPath}`);

        // 启动直播监控服务
        if (config.liveMonitor.enabled) {
            liveMonitor.start().catch(err => {
                console.error('Failed to start live monitor:', err.message);
            });
        } else {
            console.log('Live monitor disabled, using external webhook only');
        }
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

// 优雅停机：关闭 HTTP 连接、直播监控和数据库
const shutdown = async () => {
    console.log('Shutting down...');
    await liveMonitor.shutdown();
    await app.close();
    await db.$disconnect();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
