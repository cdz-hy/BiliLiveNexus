/**
 * 内存日志系统
 * 输出到控制台，同时缓存最近 200 条日志供 WebUI 展示，内置敏感信息脱敏
 */

interface LogEntry {
    level: string;    // 日志级别：INFO / WARN / ERROR
    message: string;  // 日志内容（已脱敏）
    timestamp: string; // 时间戳
    source: string;   // 来源模块：System / Bot / Webhook / LLM 等
}

/** 最大缓存条数 */
const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];

/**
 * 敏感信息脱敏
 * 覆盖：QQ 号、Token/Password/Key、消息内容
 */
function maskSensitiveInfo(str: string): string {
    if (!str) return str;

    let masked = str;

    // 脱敏 QQ 号/群号（5-11 位数字，避免误伤时间戳）
    masked = masked.replace(/\b(\d{5,11})\b/g, (match) => {
        if (match.length < 5) return match;
        const visibleLen = Math.floor(match.length / 3);
        const start = match.slice(0, visibleLen);
        const end = match.slice(-visibleLen);
        return `${start}****${end}`;
    });

    // 脱敏 Token / Password / Key / Authorization 字段值
    masked = masked.replace(/("?(token|password|Authorization|key|secret)"?)\s*[:=]\s*"?([^"\s,]+)"?/gi, '$1: "***"');

    // 脱敏消息内容字段
    masked = masked.replace(/("?(raw_message|message)"?)\s*[:=]\s*"(.*?)"/gi, '$1: "[HIDDEN MESSAGE CONTENT]"');
    masked = masked.replace(/"text"\s*:\s*"(.*?)"/gi, '"text": "[HIDDEN]"');

    return masked;
}

/**
 * 写入日志（内存 + 控制台）
 * @param level 日志级别
 * @param source 来源模块
 * @param msg 日志内容
 */
function pushLog(level: 'INFO' | 'WARN' | 'ERROR', source: string, msg: any) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    let message = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : String(msg);

    // 入库前强制脱敏
    message = maskSensitiveInfo(message);

    // 超限淘汰最旧条目
    if (logBuffer.length >= MAX_LOGS) {
        logBuffer.shift();
    }

    logBuffer.push({ level, source, message, timestamp });

    // 同步输出到标准输出
    if (level === 'ERROR') {
        console.error(`[${level}] [${source}] ${message}`);
    } else {
        console.log(`[${level}] [${source}] ${message}`);
    }
}

/** 日志工具对象 */
export const logger = {
    info: (source: string, msg: any) => pushLog('INFO', source, msg),
    warn: (source: string, msg: any) => pushLog('WARN', source, msg),
    error: (source: string, msg: any) => pushLog('ERROR', source, msg),
    /** 获取最近日志（最新在前） */
    getRecentLogs: () => [...logBuffer].reverse()
};
