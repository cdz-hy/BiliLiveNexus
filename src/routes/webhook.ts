/**
 * B站直播 Webhook 路由
 * 接收直播开播/下播事件，转发至 WebhookService 处理
 */
import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { logger } from '../utils/logger';
import { WebhookService } from '../services/webhook';

export async function webhookRoutes(app: FastifyInstance, webhookService: WebhookService) {
    /** B站直播事件回调端点 */
    app.post('/webhook/bili', async (req: any, reply: any) => {
        // 若配置了密钥，校验请求头 X-Webhook-Secret
        if (config.webhookSecret) {
            const provided = req.headers['x-webhook-secret'] || req.query?.secret;
            if (provided !== config.webhookSecret) {
                logger.warn('Webhook', `Rejected webhook from ${req.ip}: invalid secret`);
                return reply.code(403).send({ error: 'Forbidden' });
            }
        }

        const event = req.body;
        app.log.info({ msg: 'Received Bili Webhook', event });
        await webhookService.handleStreamEvent(event);
        return { status: 'ok' };
    });
}
