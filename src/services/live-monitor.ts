/**
 * 直播监控服务
 * 通过 B站弹幕 WebSocket 直接检测开播/下播，辅以 HTTP 轮询兜底
 *
 * 连接流程（参照 BililiveRecorder）：
 *   1. 获取 Wbi 签名密钥（GET /x/web-interface/nav → wbi_img）
 *   2. Wbi 签名调用 getDanmuInfo API → 获取弹幕服务器地址 + token
 *   3. 携带 token 建立 WebSocket 连接（wss://{host}/sub）
 *   4. 发送认证包（action=7, protover=3, key=token）
 *   5. 接收 LIVE/PREPARING 等命令
 */
import { PrismaClient } from '@prisma/client';
import { LiveWS } from 'bilibili-live-ws';
import axios from 'axios';
import * as crypto from 'crypto';
import { NotificationService } from './notification';
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';
import { config } from '../config';

// ========== Wbi 签名 ==========

/** Wbi 密钥置换表（BililiveRecorder 使用的固定表） */
const WBI_KEY_MAP = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** Wbi 签名密钥缓存 */
let wbiKeyCache: { key: string; timestamp: number } | null = null;
const WBI_KEY_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

/**
 * 从 wbi_img URL 提取文件名（不含扩展名）
 * 例: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png"
 *   → "7cd084941338484aae1ad9425b84077c"
 */
function extractFilename(url: string): string {
    const parts = url.split('/');
    const last = parts[parts.length - 1] || '';
    return last.replace(/\.[^.]+$/, '');
}

/**
 * 使用置换表混合两个文件名，生成 32 字符密钥
 */
function mixKey(imgFilename: string, subFilename: string): string {
    const raw = imgFilename + subFilename;
    return WBI_KEY_MAP.map(i => raw[i] || '').join('').substring(0, 32);
}

/**
 * 获取 Wbi 签名密钥（带缓存）
 */
async function getWbiKey(): Promise<string> {
    if (wbiKeyCache && Date.now() - wbiKeyCache.timestamp < WBI_KEY_CACHE_TTL) {
        return wbiKeyCache.key;
    }

    const resp = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
        timeout: 10000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Referer': 'https://www.bilibili.com',
        }
    });

    const wbiImg = resp.data?.data?.wbi_img;
    const imgFilename = extractFilename(wbiImg?.img_url || '');
    const subFilename = extractFilename(wbiImg?.sub_url || '');

    if (!imgFilename || !subFilename) {
        throw new Error('Failed to get Wbi key from nav API');
    }

    const key = mixKey(imgFilename, subFilename);
    wbiKeyCache = { key, timestamp: Date.now() };
    logger.info('LiveMonitor', `Wbi key refreshed: ${key.substring(0, 8)}...`);
    return key;
}

/**
 * 对请求参数进行 Wbi 签名
 * 参照 BililiveRecorder Wbi.cs 的实现
 */
async function signParams(params: Record<string, string | number>): Promise<string> {
    const key = await getWbiKey();
    const wts = Math.floor(Date.now() / 1000);

    // 合并参数 + wts
    const allParams: Record<string, string> = { ...params, wts: String(wts) };
    for (const k in allParams) {
        allParams[k] = String(allParams[k]).replace(/[!'()*]/g, '');
    }

    // 按 key 排序，拼接（空格用 + 编码，与 C# FormUrlEncodedContent 一致）
    const query = Object.keys(allParams)
        .sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k]).replace(/%20/g, '+')}`)
        .join('&');

    // MD5 签名
    const w_rid = crypto.createHash('md5').update(query + key).digest('hex');

    return `${query}&w_rid=${w_rid}`;
}

/**
 * 生成随机 buvid3（模拟浏览器指纹）
 */
function generateBuvid3(): string {
    const hex = crypto.randomBytes(16).toString('hex').toUpperCase();
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}infoc`;
}

// ========== 连接状态 ==========

/** 每个房间的连接状态 */
interface RoomConnection {
    ws: any;
    connected: boolean;       // 是否已通过认证（收到 welcome）
    reconnectTimer: NodeJS.Timeout | null;
    connectedAt: number;      // 连接建立时间戳
}

export class LiveMonitorService {
    /** roomId → 连接状态 */
    private connections: Map<string, RoomConnection> = new Map();
    /** 用户输入ID → 真实roomId */
    private resolvedRooms: Map<string, string> = new Map();
    /** 轮询定时器 */
    private pollTimer: NodeJS.Timeout | null = null;
    /** buvid3（生成一次，所有连接共用） */
    private buvid3: string = generateBuvid3();

    /** 重连参数（参照 BililiveRecorder TimingDanmakuRetry = 9s） */
    private static readonly RECONNECT_DELAY = 9000;
    /** 连接持续超过此时长则立即重连（不等待） */
    private static readonly IMMEDIATE_RECONNECT_THRESHOLD = 60000;

    constructor(private db: PrismaClient, private notification: NotificationService) { }

    /**
     * 启动监控：加载所有已订阅房间，逐个建立 WS 连接
     */
    async start(): Promise<void> {
        logger.info('LiveMonitor', 'Starting live monitor service...');

        // 预热 Wbi 密钥
        try {
            await getWbiKey();
        } catch (e: any) {
            logger.warn('LiveMonitor', `Failed to pre-fetch Wbi key: ${e.message}. Will retry per connection.`);
        }

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

            logger.info('LiveMonitor', `Synced live status for room ${roomId}: ${isLive ? 'LIVE' : 'OFFLINE'} (live_status=${liveStatus})`);
        } catch (e: any) {
            logger.error('LiveMonitor', `Failed to sync live status for room ${roomId}: ${e.message}`);
        }
    }

    /**
     * 通过 B站 API 解析真实房间号
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

        const conn: RoomConnection = {
            ws: null,
            connected: false,
            reconnectTimer: null,
            connectedAt: 0,
        };
        this.connections.set(realRoomId, conn);

        await this.createConnection(realRoomId, conn);
    }

    /**
     * 通过 Wbi 签名调用 getDanmuInfo API 获取弹幕服务器地址和 token
     * 参照 BililiveRecorder HttpApiClient.GetDanmuInfoAsync
     */
    private async getDanmakuConf(roomId: string): Promise<{ address: string; key: string }> {
        const signedQuery = await signParams({
            id: roomId,
            type: '0',
            web_location: '444.8',
        });

        const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signedQuery}`;
        const resp = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Referer': 'https://live.bilibili.com',
                'Origin': 'https://live.bilibili.com',
                'Cookie': `buvid3=${this.buvid3}`,
            }
        });

        const data = resp.data?.data;
        if (!data?.token) {
            logger.error('LiveMonitor', `getDanmakuConf for room ${roomId}: no token. code=${resp.data?.code}, msg=${resp.data?.message}`);
            throw new Error(`getDanmuInfo failed: code=${resp.data?.code}`);
        }

        // 从 host_list 选择服务器（排除默认 broadcastlv.chat.bilibili.com）
        const hostList = data.host_list || [];
        const filtered = hostList.filter((h: any) => h.host !== 'broadcastlv.chat.bilibili.com');
        const selected = filtered.length > 0
            ? filtered[Math.floor(Math.random() * filtered.length)]
            : { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };

        return {
            address: `wss://${selected.host}:${selected.wss_port || 443}/sub`,
            key: data.token,
        };
    }

    /**
     * 创建实际的 WS 连接并注册事件
     */
    private async createConnection(realRoomId: string, conn: RoomConnection): Promise<void> {
        try {
            // 通过 Wbi 签名获取弹幕服务器地址和认证 token
            const { address, key } = await this.getDanmakuConf(realRoomId);
            logger.info('LiveMonitor', `Room ${realRoomId}: Danmaku server=${address}`);

            // 创建 WebSocket 连接（protover=3 = Brotli 压缩）
            const ws = new LiveWS(Number(realRoomId), { address, key, protover: 3 });

            // === 连接生命周期 ===

            ws.on('live', () => {
                conn.connected = true;
                conn.connectedAt = Date.now();
                logger.info('LiveMonitor', `Room ${realRoomId}: Connection authenticated (welcome received)`);
            });

            ws.on('heartbeat', (online: number) => {
                logger.debug('LiveMonitor', `Room ${realRoomId}: Heartbeat, online=${online}`);
            });

            ws.on('close', (code: number) => {
                const wasConnected = conn.connected;
                conn.connected = false;
                stats.wsReconnects++;
                logger.warn('LiveMonitor', `Room ${realRoomId}: Connection closed (code=${code}, wasConnected=${wasConnected})`);
                this.scheduleReconnect(realRoomId, conn);
            });

            ws.on('error', (err?: Error) => {
                logger.error('LiveMonitor', `Room ${realRoomId}: WS error: ${err?.message || 'unknown'}`);
            });

            // === 调试：记录收到的 cmd ===
            ws.on('msg', (data: any) => {
                const cmd = data?.cmd || data?.msg?.cmd || 'UNKNOWN';
                const highFreqCmds = ['DANMU_MSG', 'SEND_GIFT', 'GUARD_BUY', 'SUPER_CHAT_MESSAGE',
                    'ONLINE_RANK_COUNT', 'WIDGET_BANNER', 'ENTRY_EFFECT', 'INTERACT_WORD',
                    'WATCHED_CHANGE', 'LIKE_INFO_V3_UPDATE', 'ACTIVITY_BANNER_UPDATE',
                    'ROOM_REAL_TIME_MESSAGE_UPDATE', 'HOT_RANK_CHANGED', 'POPULAR_RANK_CHANGED',
                    'COMBO_SEND', 'NOTICE_MSG', 'SYS_MSG', 'STOP_LIVE_ROOM_LIST',
                    'LIKE_INFO_V3_CLICK', 'TOAST_MESSAGE', 'RECOMMEND_CARD', 'ROOM_SKIN_MSG'];
                if (!highFreqCmds.includes(cmd)) {
                    logger.debug('LiveMonitor', `Room ${realRoomId}: cmd=${cmd}`);
                }
            });

            // === 直播状态事件 ===

            ws.on('LIVE', async () => {
                logger.info('LiveMonitor', `Room ${realRoomId}: >>> LIVE (开播)`);
                stats.liveEvents++;
                try {
                    await this.updateRoomInfo(realRoomId);
                    await this.notification.notifyStreamEvent(realRoomId, 'LIVE');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling LIVE for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('PREPARING', async () => {
                logger.info('LiveMonitor', `Room ${realRoomId}: >>> PREPARING (下播/轮播切换)`);
                stats.liveEvents++;
                try {
                    await this.notification.notifyStreamEvent(realRoomId, 'PREPARING');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling PREPARING for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('ROUND', async () => {
                logger.info('LiveMonitor', `Room ${realRoomId}: >>> ROUND (轮播开始)`);
                stats.liveEvents++;
                try {
                    await this.notification.notifyStreamEvent(realRoomId, 'PREPARING');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling ROUND for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('ROOM_CHANGE', async (msg: any) => {
                const data = msg?.data || msg;
                logger.info('LiveMonitor', `Room ${realRoomId}: ROOM_CHANGE (title="${data?.title || ''}")`);
                try {
                    await this.updateRoomInfo(realRoomId);
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling ROOM_CHANGE for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('ROOM_LOCK', async () => {
                logger.warn('LiveMonitor', `Room ${realRoomId}: >>> ROOM_LOCK (房间被封禁)`);
                try {
                    await this.notification.notifyStreamEvent(realRoomId, 'PREPARING');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling ROOM_LOCK for room ${realRoomId}: ${e.message}`);
                }
            });

            ws.on('CUT_OFF', async () => {
                logger.warn('LiveMonitor', `Room ${realRoomId}: >>> CUT_OFF (直播被切断)`);
                try {
                    await this.notification.notifyStreamEvent(realRoomId, 'PREPARING');
                } catch (e: any) {
                    logger.error('LiveMonitor', `Error handling CUT_OFF for room ${realRoomId}: ${e.message}`);
                }
            });

            conn.ws = ws;
            stats.activeConnections = this.connections.size;
            logger.info('LiveMonitor', `Connecting to room ${realRoomId}...`);
        } catch (e: any) {
            logger.error('LiveMonitor', `Failed to create connection for room ${realRoomId}: ${e.message}`);
            this.scheduleReconnect(realRoomId, conn);
        }
    }

    /**
     * 重连策略（参照 BililiveRecorder）：
     *   连接持续 > 1 分钟 → 立即重连（说明连接是稳定的，只是正常断开）
     *   连接持续 ≤ 1 分钟 → 等待 9 秒后重连（避免快速重连风暴）
     *   永不放弃，无限重试
     */
    private scheduleReconnect(realRoomId: string, conn: RoomConnection): void {
        if (conn.reconnectTimer) return;

        const duration = conn.connectedAt > 0 ? Date.now() - conn.connectedAt : 0;
        const delay = duration > LiveMonitorService.IMMEDIATE_RECONNECT_THRESHOLD
            ? 0
            : LiveMonitorService.RECONNECT_DELAY;

        logger.info('LiveMonitor', `Room ${realRoomId}: Reconnecting in ${delay / 1000}s (was connected ${Math.round(duration / 1000)}s)...`);

        conn.reconnectTimer = setTimeout(async () => {
            conn.reconnectTimer = null;

            if (conn.ws) {
                try { conn.ws.close(); } catch { }
                conn.ws = null;
            }

            await this.createConnection(realRoomId, conn);
        }, delay);
    }

    /**
     * 新增主播时调用
     */
    async addStreamer(uid: string): Promise<void> {
        const existing = await this.db.streamer.findFirst({
            where: { uid, roomId: { not: null } }
        });
        if (existing?.roomId && this.connections.has(existing.roomId)) {
            logger.info('LiveMonitor', `Room ${existing.roomId} already monitored for uid ${uid}`);
            await this.updateRoomInfo(existing.roomId, uid);
            await this.syncLiveStatus(existing.roomId, uid);
            return;
        }
        await this.resolveAndConnect(uid);
    }

    /**
     * 删除主播时调用
     */
    async removeStreamer(uid: string): Promise<void> {
        const remaining = await this.db.streamer.findMany({ where: { uid } });
        if (remaining.length > 0) {
            logger.info('LiveMonitor', `Still have ${remaining.length} subscriptions for uid ${uid}, keeping connection`);
            return;
        }

        const realRoomId = this.resolvedRooms.get(uid);
        if (realRoomId && this.connections.has(realRoomId)) {
            const conn = this.connections.get(realRoomId)!;
            if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
            if (conn.ws) try { conn.ws.close(); } catch { }
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
     * live_status: 0=未开播, 1=直播中, 2=轮播（视为未开播）
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

                    // live_status=1 才算直播中，0 和 2（轮播）都算未开播
                    const isActuallyLive = roomStatus === 1;

                    if (isActuallyLive && !anyLive) {
                        logger.warn('LiveMonitor', `Polling fallback: Room ${roomId} is LIVE but DB says offline`);
                        await this.updateRoomInfo(roomId);
                        await this.notification.notifyStreamEvent(roomId, 'LIVE');
                    } else if (!isActuallyLive && anyLive) {
                        logger.warn('LiveMonitor', `Polling fallback: Room ${roomId} is offline (live_status=${roomStatus}) but DB says LIVE`);
                        await this.notification.notifyStreamEvent(roomId, 'PREPARING');
                    }
                } catch (e: any) {
                    logger.error('LiveMonitor', `Polling error for room ${roomId}: ${e.message}`);
                }
            }
        }, intervalMs);
    }

    /**
     * 优雅关闭
     */
    async shutdown(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        for (const [roomId, conn] of this.connections) {
            if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
            if (conn.ws) try { conn.ws.close(); } catch { }
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
