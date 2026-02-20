
/**
 * 内存日志系统
 * 支持输出到控制台，并缓存最近 200 条日志供 WebUI 展示
 */
interface LogEntry {
    level: string; // 'INFO' | 'WARN' | 'ERROR'
    message: string;
    timestamp: string;
    source: string; // 'System', 'Bot', 'Webhook', etc.
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];

// 敏感信息脱敏处理
function maskSensitiveInfo(str: string): string {
    if (!str) return str;

    let masked = str;

    // 1. 脱敏 QQ 号 / 群号 (匹配 5-11 位数字)
    // 强制脱敏所有看起来像 QQ 号的数字，不再局限于特定前缀，但为了避免误伤时间戳（通常13位），限制在 5-11 位
    // 同时也匹配 key: value 格式
    masked = masked.replace(/\b(\d{5,11})\b/g, (match) => {
        if (match.length < 5) return match;
        const visibleLen = Math.floor(match.length / 3);
        const start = match.slice(0, visibleLen);
        const end = match.slice(-visibleLen);
        return `${start}****${end}`;
    });

    // 2. 脱敏 Token / Password / Key / Authorization
    masked = masked.replace(/("?(token|password|Authorization|key|secret)"?)\s*[:=]\s*"?([^"\s,]+)"?/gi, '$1: "***"');

    // 3. 脱敏具体消息内容 (针对 NapCat 上报的消息结构)
    // 如果日志中包含 raw_message 或 message 字段，将其内容替换为 [HIDDEN]
    masked = masked.replace(/("?(raw_message|message)"?)\s*[:=]\s*"(.*?)"/gi, '$1: "[HIDDEN MESSAGE CONTENT]"');
    // 针对数组形式的消息 [{"type":"text","data":{"text":"..."}}]
    masked = masked.replace(/"text"\s*:\s*"(.*?)"/gi, '"text": "[HIDDEN]"');

    return masked;
}

// 将日志添加到内存
function pushLog(level: 'INFO' | 'WARN' | 'ERROR', source: string, msg: any) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    let message = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : String(msg);

    // *** 核心脱敏步骤：入库前强制脱敏 ***
    message = maskSensitiveInfo(message);

    // 清理超限
    if (logBuffer.length >= MAX_LOGS) {
        logBuffer.shift();
    }

    logBuffer.push({ level, source, message, timestamp });

    // 同时输出到标准输出
    if (level === 'ERROR') {
        console.error(`[${level}] [${source}] ${message}`);
    } else {
        console.log(`[${level}] [${source}] ${message}`);
    }
}

export const logger = {
    info: (source: string, msg: any) => pushLog('INFO', source, msg),
    warn: (source: string, msg: any) => pushLog('WARN', source, msg),
    error: (source: string, msg: any) => pushLog('ERROR', source, msg),
    getRecentLogs: () => [...logBuffer] // 保证终端式的最新在下顺序
};
