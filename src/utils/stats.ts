/**
 * Bot 运行时统计
 * 记录启动时间、消息计数、规则命中、LLM 调用等核心指标
 */
export const stats = {
    startTime: new Date(),
    totalMessages: 0,  // 总消息数
    ruleHits: 0,       // 规则命中次数
    webhookHits: 0,    // Webhook 事件数
    llmCalls: 0,       // LLM 调用次数

    /** 获取系统状态摘要（含运行时长与内存占用） */
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
