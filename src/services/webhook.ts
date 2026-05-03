/**
 * B站直播 Webhook 服务
 * 处理开播/下播事件，发送 QQ 群通知，支持 @全体降级与冷却防刷
 */
import { PrismaClient } from '@prisma/client';
import { NapCatClient } from './napcat';
import { logger } from '../utils/logger';
import { stats } from '../utils/stats';

export class WebhookService {
    constructor(private db: PrismaClient, private napcat: NapCatClient) { }

    /**
     * 处理直播事件
     * @param event B站直播 Webhook 事件体
     */
    async handleStreamEvent(event: any) {
        stats.webhookHits++;

        const { EventType, EventData } = event;
        logger.info('Webhook', `Received event: ${EventType} / ${EventData?.Title || EventData?.RoomId}`);

        // 仅处理开播与下播事件
        if (EventType !== 'StreamStarted' && EventType !== 'StreamEnded') return;

        const { RoomId, Title } = EventData;

        // 查询该主播的所有订阅（支持同一主播通知多个群）
        const streamers = await this.db.streamer.findMany({
            where: { uid: RoomId.toString() }
        });

        if (streamers.length === 0) {
            logger.warn('Webhook', `Ignoring unconfigured streamer RoomID: ${RoomId}`);
            return;
        }

        for (const streamer of streamers) {
            if (EventType === 'StreamStarted') {
                const now = new Date();

                // 5 分钟冷却期：防止 API 重复推送导致刷屏
                if (streamer.lastLive) {
                    const timeDiff = now.getTime() - streamer.lastLive.getTime();
                    if (timeDiff < 5 * 60 * 1000) {
                        logger.warn('Webhook', `Blocked frequent StreamStarted notification for ${streamer.name} to Group ${streamer.groupId} (Cooldown: ${Math.round((5 * 60 * 1000 - timeDiff) / 1000)}s)`);
                        continue;
                    }
                }

                const coverUrl = EventData?.CoverFromUser || EventData?.CoverFromRoom;

                const happyKaomojis = [
                    '(≧∇≦)ﾉ', '(*^▽^*)', '(＾Ｕ＾)ノ~ＹＯ', 'o(*￣▽￣*)ブ', 'ヽ(✿ﾟ▽ﾟ)ノ',
                    '(๑>◡<๑)', 'ヾ(≧▽≦*)o', 'φ(゜▽゜*)♪', '( *^-^)ρ(^0^* )', 'o(*≧▽≦)ツ',
                    '\\(￣︶￣*\\))', '(*^▽^*)', '♪(^∇^*)', '(o゜▽゜)o☆', 'ヾ(•ω•`)o',
                    '(´▽`ʃ♡ƪ)', '╰(*°▽°*)╯', 'o(*^＠^*)o', '(*^ω^*)', '(*^__^*)',
                    '(✿◡‿◡)', 'ヾ(✿ﾟ▽ﾟ)ノ', '(๑•̀ㅂ•́)و✧', '(☆▽☆)', '(/≧▽≦)/'
                ];
                const randomHappyKaomoji = happyKaomojis[Math.floor(Math.random() * happyKaomojis.length)];

                // 构建 @全体成员 + 文字 + 封面图的消息
                const msgWithAtAll: any[] = [
                    { type: 'at', data: { qq: 'all' } },
                    { type: 'text', data: { text: ` ${streamer.name || ''} 开播啦！ ${randomHappyKaomoji}\n${Title}\nhttps://live.bilibili.com/${RoomId}\n` } }
                ];
                if (coverUrl) {
                    msgWithAtAll.push({ type: 'image', data: { file: coverUrl } });
                }

                // 优先发送 @全体，失败则降级为普通消息
                let success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithAtAll);

                if (!success) {
                    logger.warn('Webhook', `给群 ${streamer.groupId} 发送 @全体 失败，系统自动降级发送普通无@消息...`);
                    const msgWithoutAtAll: any[] = [
                        { type: 'text', data: { text: `${streamer.name || ''} 开播啦！ ${randomHappyKaomoji}\n${Title}\nhttps://live.bilibili.com/${RoomId}\n` } }
                    ];
                    if (coverUrl) {
                        msgWithoutAtAll.push({ type: 'image', data: { file: coverUrl } });
                    }
                    success = await this.napcat.sendGroupMsg(Number(streamer.groupId), msgWithoutAtAll);
                }

                // 发送成功后更新直播状态与时间戳
                if (success) {
                    await this.db.streamer.update({
                        where: { id: streamer.id },
                        data: { isLive: true, lastLive: now }
                    });
                    logger.info('Bot', `Sent StreamStarted notification for ${streamer.name} to Group ${streamer.groupId}`);
                }
            } else {
                // 下播通知
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
                await this.db.streamer.update({
                    where: { id: streamer.id },
                    data: { isLive: false }
                });
                logger.info('Bot', `Sent StreamEnded notification for ${streamer.name} to Group ${streamer.groupId}`);
            }
        }
    }
}
