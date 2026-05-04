/**
 * B站直播 Webhook 服务（适配器层）
 * 接收外部工具推送的 Webhook 事件，委托给 NotificationService 处理
 */
import { NotificationService } from './notification';
import { stats } from '../utils/stats';
import { logger } from '../utils/logger';

export class WebhookService {
    constructor(private notification: NotificationService) { }

    /**
     * 处理外部推送的直播事件
     * @param event B站直播 Webhook 事件体（BililiveRecorder 格式）
     */
    async handleStreamEvent(event: any) {
        stats.webhookHits++;

        const { EventType, EventData } = event;
        logger.info('Webhook', `Received event: ${EventType} / ${EventData?.Title || EventData?.RoomId}`);

        // 仅处理开播与下播事件
        if (EventType !== 'StreamStarted' && EventType !== 'StreamEnded') return;

        const roomId = String(EventData.RoomId);
        const eventType = EventType === 'StreamStarted' ? 'LIVE' : 'PREPARING';
        const title = EventData?.Title;
        const coverUrl = EventData?.CoverFromUser || EventData?.CoverFromRoom;

        await this.notification.notifyStreamEvent(roomId, eventType, title, coverUrl);
    }
}
