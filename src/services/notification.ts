/**
 * 通知服务
 * 处理开播/下播事件的 QQ 群通知逻辑：冷却防刷、@全体降级、颜文字
 */
import { PrismaClient } from '@prisma/client';
import { NapCatClient } from './napcat';
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';

export class NotificationService {
    constructor(private db: PrismaClient, private napcat: NapCatClient) { }

    /**
     * 发送直播开播/下播通知
     * @param roomId B站房间号（真实房间号或用户输入的ID）
     * @param eventType 'LIVE' 开播 / 'PREPARING' 下播
     * @param title 直播标题（开播时）
     * @param coverUrl 封面图URL（开播时）
     */
    async notifyStreamEvent(
        roomId: string,
        eventType: 'LIVE' | 'PREPARING',
        title?: string,
        coverUrl?: string
    ): Promise<void> {
        // 查询该房间的所有订阅（兼容 uid 和 roomId 两种匹配）
        const streamers = await this.db.streamer.findMany({
            where: {
                OR: [
                    { uid: roomId },
                    { roomId: roomId }
                ]
            }
        });

        if (streamers.length === 0) {
            logger.warn('Notification', `Ignoring unconfigured room: ${roomId}`);
            return;
        }

        for (const streamer of streamers) {
            try {
                if (eventType === 'LIVE') {
                    await this.handleLiveStart(streamer, roomId, title, coverUrl);
                } else {
                    await this.handleLiveEnd(streamer, roomId);
                }
            } catch (e: any) {
                logger.error('Notification', `Error notifying group ${streamer.groupId} for room ${roomId}: ${e.message}`);
            }
        }
    }

    private async handleLiveStart(streamer: any, roomId: string, title?: string, coverUrl?: string) {
        const now = new Date();

        // 优先使用传入参数，否则从 DB 读取（WS 通道已通过 updateRoomInfo 写入最新数据）
        title = title || streamer.title || '';
        coverUrl = coverUrl || streamer.cover || '';

        // 补全协议相对路径
        if (coverUrl && coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;

        // 始终更新直播状态（不受冷却影响）
        await this.db.streamer.update({
            where: { id: streamer.id },
            data: { isLive: true }
        });

        // 5 分钟冷却期：仅阻止通知发送，不阻止状态更新
        if (streamer.lastLive) {
            const timeDiff = now.getTime() - streamer.lastLive.getTime();
            if (timeDiff < 5 * 60 * 1000) {
                logger.warn('Notification', `Blocked frequent LIVE notification for ${streamer.name} to Group ${streamer.groupId} (Cooldown: ${Math.round((5 * 60 * 1000 - timeDiff) / 1000)}s)`);
                return;
            }
        }

        const happyKaomojis = [
            '(≧∇≦)ﾉ', '(*^▽^*)', '(＾Ｕ＾)ノ~ＹＯ', 'o(*￣▽￣*)ブ', 'ヽ(✿ﾟ▽ﾟ)ノ',
            '(๑>◡<๑)', 'ヾ(≧▽≦*)o', 'φ(゜▽゜*)♪', '( *^-^)ρ(^0^* )', 'o(*≧▽≦)ツ',
            '\\(￣︶￣*\\))', '(*^▽^*)', '♪(^∇^*)', '(o゜▽゜)o☆', 'ヾ(•ω•`)o',
            '(´▽`ʃ♡ƪ)', '╰(*°▽°*)╯', 'o(*^＠^*)o', '(*^ω^*)', '(*^__^*)',
            '(✿◡‿◡)', 'ヾ(✿ﾟ▽ﾟ)ノ', '(๑•̀ㅂ•́)و✧', '(☆▽☆)', '(/≧▽≦)/'
        ];
        const randomKaomoji = happyKaomojis[Math.floor(Math.random() * happyKaomojis.length)];

        // 构建 @全体成员 + 文字 + 封面图的消息
        const msgWithAtAll: any[] = [
            { type: 'at', data: { qq: 'all' } },
            { type: 'text', data: { text: ` ${streamer.name || ''} 开播啦！ ${randomKaomoji}\n${title || ''}\nhttps://live.bilibili.com/${roomId}\n` } }
        ];
        if (coverUrl) {
            msgWithAtAll.push({ type: 'image', data: { file: coverUrl } });
        }

        // 优先发送 @全体，失败则降级为普通消息
        let success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithAtAll);

        if (!success) {
            logger.warn('Notification', `给群 ${streamer.groupId} 发送 @全体 失败，自动降级发送普通消息...`);
            const msgWithoutAtAll: any[] = [
                { type: 'text', data: { text: `${streamer.name || ''} 开播啦！ ${randomKaomoji}\n${title || ''}\nhttps://live.bilibili.com/${roomId}\n` } }
            ];
            if (coverUrl) {
                msgWithoutAtAll.push({ type: 'image', data: { file: coverUrl } });
            }
            success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithoutAtAll);
        }

        // 通知发送成功后更新 lastLive 时间戳（用于冷却判断）
        if (success) {
            await this.db.streamer.update({
                where: { id: streamer.id },
                data: { lastLive: now }
            });
            logger.info('Notification', `Sent LIVE notification for ${streamer.name} to Group ${streamer.groupId}`);
        }
    }

    private async handleLiveEnd(streamer: any, roomId: string) {
        // 始终更新直播状态
        await this.db.streamer.update({
            where: { id: streamer.id },
            data: { isLive: false }
        });

        const kaomojis = [
            'QwQ', 'QAQ', 'T^T', 'TAT', '(╥﹏╥)', '(つд⊂)', 'Ó╭╮Ò', 'o(╥﹏╥)o',
            '( ´•̥̥̥ω•̥̥̥` )', '(´；ω；`)', '(;´༎ຶД༎ຶ`)', '(๑´•.̫ • `๑)', '(-̩̩-̩̩͡_-̩̩-̩̩͡)', '(T_T)',
            '(ToT)', '・゜・(PД`q｡)・゜・', '(；д；)', '。゜゜(´Ｏ`) ゜゜。', '( p′︵‵。)',
            '(´-ω-` )', '( ´△｀)', '(っ- ‸ - ς)', '( Ĭ ^ Ĭ )', '(๑•́ ₃ •̀๑)',
            '(´._.`)', '(╯︵╰,)', 'π_π', '╥﹏╥', 'o(TヘTo)', '(ಥ﹏ಥ)', '( ｡>﹏<｡)'
        ];
        const randomKaomoji = kaomojis[Math.floor(Math.random() * kaomojis.length)];

        await this.napcat.sendGroupMsg(Number(streamer.groupId), [
            { type: 'text', data: { text: `主包下播啦 ${randomKaomoji}` } }
        ]);

        logger.info('Notification', `Sent PREPARING notification for ${streamer.name} to Group ${streamer.groupId}`);
    }
}
