/**
 * NapCat QQ 机器人客户端
 * 封装 NapCat HTTP API 调用，内置频率限制
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export class NapCatClient {
    /** 请求时间戳队列，用于滑动窗口限流 */
    private requestTimestamps: number[] = [];

    /** 滑动窗口限流：每分钟最多 10 次请求 */
    private checkRateLimit(): boolean {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60000);
        if (this.requestTimestamps.length >= 10) {
            return false;
        }
        this.requestTimestamps.push(now);
        return true;
    }

    /**
     * 向 QQ 群发送消息
     * @param groupId 群号
     * @param message NapCat 消息段数组
     * @returns 是否发送成功
     */
    async sendGroupMsg(groupId: number, message: any[]): Promise<boolean> {
        if (!this.checkRateLimit()) {
            logger.error('NapCat', `触发呼叫频率限制（>10次/分钟）！已丢弃给群 ${groupId} 的消息。`);
            return false;
        }

        try {
            logger.info('NapCat', `Sending to Group ${groupId}: ${JSON.stringify(message[0].data)}...`);
            const res = await axios.post(
                `${config.napcat.url}/send_group_msg`,
                { group_id: groupId, message, auto_escape: false },
                { headers: { Authorization: `Bearer ${config.napcat.token}` } }
            );

            if (res.data && res.data.status === 'failed') {
                throw new Error(res.data.msg || res.data.wording || 'API Error');
            }
            return true;
        } catch (e: any) {
            logger.error('NapCat', `Failed to send to Group ${groupId}: ${e.message}`);
            return false;
        }
    }
}
