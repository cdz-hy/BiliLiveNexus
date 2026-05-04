/**
 * 直播监控服务
 * 通过 B站弹幕 WebSocket 直接检测开播/下播，辅以 HTTP 轮询兜底
 */
import { PrismaClient } from '@prisma/client';
import { KeepLiveWS } from 'bilibili-live-ws';
import axios from 'axios';
import { NotificationService } from './notification';
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';
import { config } from '../config';

export class LiveMonitorService {
    /** roomId → WebSocket 连接实例 */
    private connections: Map<string, any> = new Map();
    /** 用户输入ID → 真实roomId */
    private resolvedRooms: Map<string, string> = new Map();
    /** 轮询定时器 */
    private pollTimer: NodeJS.Timeout | null = null;

    constructor(private db: PrismaClient, private notification: NotificationService) { }

    /**
     * 启动监控：加载所有已订阅房间，逐个建立 WS 连接
     */
    async start(): Promise<void> {
        logger.info('LiveMonitor', 'Starting live monitor service...');

        // 查询所有唯一 uid
        const streamers = await this.db.streamer.findMany({
            select: { uid: true },
            distinct: ['uid']
        });

        const uniqueUids = streamers.map((s: any) => s.uid);
        logger.info('LiveMonitor', `Found ${uniqueUids.length} unique rooms to monitor`);

        // 逐个解析并连接，间隔 500ms 避免限流
        for (const uid of uniqueUids) {
            try {
                await this.resolveAndConnect(uid);
            } catch (e: any) {
                logger.error('LiveMonitor', `Failed to initialize monitoring for uid ${uid}: ${e.message}`);
            }
            if (uniqueUids.indexOf(uid) < uniqueUids.length - 1) {
                await this.sleep(500);
            }
        }

        // 启动 HTTP 轮询兜底
        this.startPolling(config.liveMonitor.pollIntervalMs);

        logger.info('LiveMonitor', `Monitor started. Active connections: ${this.connections.size}`);
        stats.activeConnections = this.connections.size;
    }

    /**
     * 解析用户输入的 ID 为真实房间号并建立连接
     */
    async resolveAndConnect(inputId: string): Promise<void> {
        const realRoomId = await this.resolveRoomId(inputId);
        this.resolvedRooms.set(inputId, realRoomId);

        // 更新数据库中所有该 uid 的记录的 roomId
        await this.db.streamer.updateMany({
            where: { uid: inputId },
            data: { roomId: realRoomId }
        });

        await this.connectRoom(realRoomId);

        // 连接后获取并保存直播间信息
        await this.updateRoomInfo(realRoomId, inputId);

        // 检查当前直播状态并同步到 DB（启动时主播可能已在直播）
        await this.syncLiveStatus(realRoomId, inputId);
    }

    /**
     * 检查房间当前直播状态并同步到数据库
     * WebSocket 只在状态变化时触发事件，启动时需要主动检查
     */
    private async syncLiveStatus(roomId: string, uid?: string): Promise<void> {
        try {
            const liveStatus = await this.getRoomLiveStatus(roomId);
            const isLive = liveStatus === 1;

            const where = uid
                ? { OR: [{ uid }, { roomId }] }
                : { roomId };

            await this.db.streamer.updateMany({
                where,
                data: { isLive }
            });

            logger.info('LiveMonitor', `Synced live status for room ${roomId}: ${isLive ? 'LIVE' : 'OFFLINE'}`);
        } catch (e: any) {
            logger.error('LiveMonitor', `Failed to sync live status for room ${roomId}: ${e.message}`);
        }
    }

    /**
     * 通过 B站 API 解析真实房间号
     * 短号、自定义号 → 真实房间号
     * @throws 房间不存在或 API 异常时抛出错误
     */
    async resolveRoomId(inputId: string): Promise<string> {
        const resp = await axios.get(
            `https://api.live.bilibili.com/room/v1/Room/room_init?id=${inputId}`,
            { timeout: 10000 }
        );
        const code = resp.data?.code;
        if (code !== 0) {
            throw new Error(resp.data?.message || `房间 ${inputId} 不存在`);
        }
        const realId = resp.data?.data?.room_id;
        if (!realId) {
            throw new Error(`房间 ${inputId} 不存在`);
        }
        logger.info('LiveMonitor', `Resolved room ${inputId} → ${realId}`);
        return String(realId);
    }

    /**
     * 为指定房间建立弹幕 WebSocket 连接
     */
    async connectRoom(realRoomId: string): Promise<void> {
        if (this.connections.has(realRoomId)) {
            logger.info('LiveMonitor', `Already connected to room ${realRoomId}, skipping`);
            return;
        }

        try {
            const ws = new KeepLiveWS(Number(realRoomId));

            ws.on('LIVE', async (msg: any) => {
                logger.info('LiveMonitor', `Room ${realRoomId}: LIVE event detected`);
                stats.liveEvents++;
                try {
                    // 刷新直播间信息到 DB（封面、标题等）
                    const roomInfo = await this.updateRoomInfo(realRoomId);
                    // 通知服务从 DB 读取封面，不传参
                    await this.notification.notifyStreamEvent(realRoomId, 'LIVE');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling LIVE for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('PREPARING', async (msg: any) => {
                logger.info('LiveMonitor', `Room ${realRoomId}: PREPARING (stream ended)`);
                stats.liveEvents++;
                try {
                    await this.notification.notifyStreamEvent(realRoomId, 'PREPARING');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling PREPARING for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('error', (err: Error) => {
                logger.error('LiveMonitor', `WS error for room ${realRoomId}: ${err.message}`);
            });

            this.connections.set(realRoomId, ws);
            stats.activeConnections = this.connections.size;
            logger.info('LiveMonitor', `Connected to room ${realRoomId}`);
        } catch (e: any) {
            logger.error('LiveMonitor', `Failed to connect to room ${realRoomId}: ${e.message}`);
        }
    }

    /**
     * 新增主播时调用：如果该房间未连接则建立连接，始终刷新直播间信息
     */
    async addStreamer(uid: string): Promise<void> {
        // 检查是否已有该 uid 的连接
        const existing = await this.db.streamer.findFirst({
            where: { uid, roomId: { not: null } }
        });
        if (existing?.roomId && this.connections.has(existing.roomId)) {
            logger.info('LiveMonitor', `Room ${existing.roomId} already monitored for uid ${uid}`);
            // 连接已存在，刷新直播间信息并同步直播状态
            await this.updateRoomInfo(existing.roomId, uid);
            await this.syncLiveStatus(existing.roomId, uid);
            return;
        }
        await this.resolveAndConnect(uid);
    }

    /**
     * 删除主播时调用：如果该 uid 无其他订阅则断开连接
     */
    async removeStreamer(uid: string): Promise<void> {
        // 检查是否还有其他订阅使用该 uid
        const remaining = await this.db.streamer.findMany({ where: { uid } });
        if (remaining.length > 0) {
            logger.info('LiveMonitor', `Still have ${remaining.length} subscriptions for uid ${uid}, keeping connection`);
            return;
        }

        // 查找并断开连接
        const realRoomId = this.resolvedRooms.get(uid);
        if (realRoomId && this.connections.has(realRoomId)) {
            const ws = this.connections.get(realRoomId);
            try { ws.close(); } catch { }
            this.connections.delete(realRoomId);
            stats.activeConnections = this.connections.size;
            logger.info('LiveMonitor', `Disconnected from room ${realRoomId} (uid ${uid} removed)`);
        }
        this.resolvedRooms.delete(uid);
    }

    /**
     * 获取直播间详细信息
     */
    async fetchRoomInfo(roomId: string): Promise<{
        uname: string; title: string; description: string; cover: string
    } | null> {
        try {
            // 并行请求房间信息和主播信息
            const [roomResp, anchorResp] = await Promise.all([
                axios.get(`https://api.live.bilibili.com/room/v1/Room/get_info?id=${roomId}`, { timeout: 10000 }),
                axios.get(`https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`, { timeout: 10000 }).catch(() => null)
            ]);

            const data = roomResp.data?.data;
            if (!data) return null;

            // 封面 URL：B站返回完整 https:// 或协议相对路径
            let cover = data.user_cover || '';
            if (cover.startsWith('//')) cover = 'https:' + cover;

            // UP主名称：从 get_anchor_in_room 获取
            const uname = anchorResp?.data?.data?.info?.uname || '';

            return {
                uname,
                title: data.title || '',
                description: data.description || '',
                cover
            };
        } catch (e: any) {
            logger.error('LiveMonitor', `fetchRoomInfo failed for ${roomId}: ${e.message}`);
            return null;
        }
    }

    /**
     * 获取并保存直播间信息到数据库
     * @param roomId 真实房间号
     * @param uid 可选，用于匹配数据库记录
     * @returns 获取到的直播间信息，失败返回 null
     */
    async updateRoomInfo(roomId: string, uid?: string): Promise<{
        uname: string; title: string; description: string; cover: string
    } | null> {
        const info = await this.fetchRoomInfo(roomId);
        if (!info) return null;

        const where = uid
            ? { OR: [{ uid }, { roomId }] }
            : { roomId };

        await this.db.streamer.updateMany({
            where,
            data: {
                uname: info.uname,
                title: info.title,
                description: info.description,
                cover: info.cover,
            }
        });

        return info;
    }

    /**
     * 获取房间直播状态（0=未开播, 1=直播中, 2=轮播）
     */
    async getRoomLiveStatus(roomId: string): Promise<number> {
        try {
            const resp = await axios.get(
                `https://api.live.bilibili.com/room/v1/Room/get_info?id=${roomId}`,
                { timeout: 10000 }
            );
            return resp.data?.data?.live_status ?? -1;
        } catch {
            return -1;
        }
    }

    /**
     * HTTP 轮询兜底：定期检查所有监控房间的直播状态
     * 对比 B站 API 返回的 live_status 与数据库中的 isLive 标记
     */
    private startPolling(intervalMs: number): void {
        this.pollTimer = setInterval(async () => {
            for (const [roomId] of this.connections) {
                try {
                    const roomStatus = await this.getRoomLiveStatus(roomId);
                    if (roomStatus === -1) continue;

                    const streamers = await this.db.streamer.findMany({
                        where: { OR: [{ uid: roomId }, { roomId }] }
                    });
                    const anyLive = streamers.some((s: any) => s.isLive);

                    if (roomStatus === 1 && !anyLive) {
                        logger.warn('LiveMonitor', `Polling fallback: Room ${roomId} is LIVE but DB says offline`);
                        await this.updateRoomInfo(roomId);
                        await this.notification.notifyStreamEvent(roomId, 'LIVE');
                    } else if (roomStatus !== 1 && anyLive) {
                        logger.warn('LiveMonitor', `Polling fallback: Room ${roomId} is offline but DB says LIVE`);
                        await this.notification.notifyStreamEvent(roomId, 'PREPARING');
                    }
                } catch (e: any) {
                    logger.error('LiveMonitor', `Polling error for room ${roomId}: ${e.message}`);
                }
            }
        }, intervalMs);
    }

    /**
     * 优雅关闭：断开所有 WebSocket 连接
     */
    async shutdown(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        for (const [roomId, ws] of this.connections) {
            try { ws.close(); } catch { }
        }
        this.connections.clear();
        this.resolvedRooms.clear();
        stats.activeConnections = 0;
        logger.info('LiveMonitor', 'All connections closed');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
