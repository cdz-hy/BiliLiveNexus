
/**
 * Bot 运行时统计数据
 */
export const stats = {
    startTime: new Date(),
    totalMessages: 0,
    ruleHits: 0,
    webhookHits: 0,
    llmCalls: 0,

    /**
     * 获取当前系统状态
     */
    getSummary: () => {
        const memory = process.memoryUsage();
        const uptimeSec = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
        const day = Math.floor(uptimeSec / 86400);
        const hour = Math.floor((uptimeSec % 86400) / 3600);
        const min = Math.floor((uptimeSec % 3600) / 60);

        return {
            uptime: `${day}天 ${hour}小时 ${min}分钟`,
            uptimeSec,
            memory: {
                rss: (memory.rss / 1024 / 1024).toFixed(1) + ' MB',
                heapUsed: (memory.heapUsed / 1024 / 1024).toFixed(1) + ' MB'
            },
            counts: {
                totalMessages: stats.totalMessages,
                ruleHits: stats.ruleHits,
                webhookHits: stats.webhookHits,
                llmCalls: stats.llmCalls
            }
        };
    }
};
