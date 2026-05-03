/**
 * 全局配置中心
 * 集中管理所有环境变量，避免各模块直接读取 process.env
 */
export const config = {
    /** 服务监听端口 */
    port: Number(process.env.PORT) || 5555,
    /** WebUI 管理密码 */
    nexusPassword: process.env.NEXUS_PASSWORD || '',
    /** JWT 签名密钥，未设置则 fallback 到管理密码 */
    jwtSecret: process.env.JWT_SECRET || process.env.NEXUS_PASSWORD || 'nexus-default-secret-change-me',
    /** B站直播 Webhook 验证密钥 */
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    /** 机器人 QQ 号，用于识别 @ 消息 */
    botQqId: process.env.BOT_QQ_ID || '',
    /** NapCat API 配置 */
    napcat: {
        url: process.env.NAPCAT_URL || 'http://localhost:3000',
        token: process.env.NAPCAT_TOKEN || '',
    },
};
