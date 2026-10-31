/**
 * dsh-haavk-boot — Host 端（模块 C：节点调度后台核心）
 *
 * 复刻《三角洲行动》哈夫克 Relink 设备开机仪式。DSH 内核就绪后：
 *   1. 向 Web 客户端下发【节点入网事件】（SSE），驱动动画与音效；
 *   2. 打印哈夫克 ASCII 横幅（纯终端环境，不渲染图形）；
 *   3. 异步托管执行用户配置的启动脚本（不阻塞 DSH 启动）；
 *   4. 注册遥测工具 haavk_node_status。
 *
 * 卸载 / 热重载时：下发【离线事件】→ 终止托管子进程 → 清理定时器与 SSE 连接。
 *
 * 日志前缀：[HAAVK-CORE] / [HAAVK-AUDIO] / [HAAVK-VISUAL]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-haavk-boot';
/**
 * 与 dsh-haavk / dsh-startup-screen 同款：把 webServer 声明成硬依赖，
 * Loader 会等服务就绪后再 apply —— 否则 apply 时 webServer 还不存在，
 * ctx.inject 的回调永远不触发，启动屏就静默消失。
 * 桌面端若走 file:// + IPC 没有 webServer，本插件仍不炸（下面有兜底 return）。
 */
export const inject = ['webServer', 'connection'];
export const PLUGIN_ID = 'dsh-haavk-boot';
const ENDPOINT_ROOT = '/plugins/dsh-haavk-boot';
export const CONFIG_ENDPOINT = `${ENDPOINT_ROOT}/config`;
export const SPLASH_CSS = `${ENDPOINT_ROOT}/splash.css`;
export const SPLASH_JS = `${ENDPOINT_ROOT}/splash.js`;
export const SPLASH_ASSET = `${ENDPOINT_ROOT}/asset/boot.mp4`;
export const EVENTS_ENDPOINT = `${ENDPOINT_ROOT}/events`;
export const STATUS_ENDPOINT = `${ENDPOINT_ROOT}/status`;
export const LOGS_ENDPOINT = `${ENDPOINT_ROOT}/logs`;
export const PREVIEW_ENDPOINT = `${ENDPOINT_ROOT}/preview`;
export const TASK_ENDPOINT = `${ENDPOINT_ROOT}/task`;
/** 标准开机序列总时长（ms） */
export const SEQUENCE_DURATION_MS = 13700;
/** 标准台词时间轴（ms 为相对 boots 触发起点的偏移） */
export const DEFAULT_CAPTIONS = Object.freeze([
    { at: 1200, text: '信息与你无限，Relink重塑未来。' },
    {
        at: 3800,
        text: '欢迎使用Relink3号体验版本设备，本设备将持续采集上传您的生理体征、精神状态相关数据，请在使用前检阅并签署用户协议。',
    },
    { at: 7200, text: '天空属于哈夫克。' },
]);
export const CONFIG_DEFAULTS = Object.freeze({
    enabled: true,
    bootSplash: true,
    visualEnabled: true,
    glowIntensity: 1,
    replayOnReload: true,
    audioEnabled: true,
    audioVolume: 0.55,
    audioMode: 'synth',
    bootWavPath: '',
    shutdownWavPath: '',
    hostAudioEnabled: false,
    bootScript: '',
    bootScriptTimeoutMs: 0,
    bootDelayMs: 900,
    asciiBanner: true,
    telemetryLogLimit: 200,
});
export const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS);
/** 解开宿主可能传入的 Volatile 引用（`{ get() }`）。 */
export function plainConfig(value) {
    if (value && typeof value === 'object' && typeof value.get === 'function'
        && !Array.isArray(value)) {
        try {
            return plainConfig(value.get());
        }
        catch {
            return value;
        }
    }
    if (Array.isArray(value))
        return value.map(plainConfig);
    return value;
}
function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, value));
}
/** 归一化任意来源（patch / 用户面板 / settings.json）的配置值。 */
export function normalizeConfig(raw) {
    const source = (plainConfig(raw) ?? {});
    const pick = (key) => (source[key] ?? CONFIG_DEFAULTS[key]);
    const text = (value, fallback) => (typeof value === 'string' ? value : fallback);
    return {
        enabled: pick('enabled') !== false,
        bootSplash: pick('bootSplash') !== false,
        visualEnabled: pick('visualEnabled') !== false,
        glowIntensity: clamp(Number(pick('glowIntensity')), 0.2, 2, CONFIG_DEFAULTS.glowIntensity),
        replayOnReload: pick('replayOnReload') !== false,
        audioEnabled: pick('audioEnabled') !== false,
        audioVolume: clamp(Number(pick('audioVolume')), 0, 1, CONFIG_DEFAULTS.audioVolume),
        audioMode: pick('audioMode') === 'file' ? 'file' : 'synth',
        bootWavPath: text(pick('bootWavPath'), ''),
        shutdownWavPath: text(pick('shutdownWavPath'), ''),
        hostAudioEnabled: pick('hostAudioEnabled') === true,
        bootScript: text(pick('bootScript'), ''),
        bootScriptTimeoutMs: clamp(Number(pick('bootScriptTimeoutMs')), 0, 86_400_000, 0),
        bootDelayMs: clamp(Number(pick('bootDelayMs')), 0, 60_000, CONFIG_DEFAULTS.bootDelayMs),
        asciiBanner: pick('asciiBanner') !== false,
        telemetryLogLimit: Math.round(clamp(Number(pick('telemetryLogLimit')), 20, 2000, CONFIG_DEFAULTS.telemetryLogLimit)),
    };
}
/** 面板 PATCH 的字段白名单校验。 */
export function sanitizePatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('patch must be an object');
    const input = raw;
    for (const key of Object.keys(input)) {
        if (!CONFIG_KEYS.includes(key))
            throw new Error(`unknown setting: ${key}`);
    }
    const merged = normalizeConfig({ ...CONFIG_DEFAULTS, ...input });
    const patch = {};
    for (const key of Object.keys(input))
        patch[key] = merged[key];
    return patch;
}
/* ------------------------------------------------------------------ *
 * 持久化配置（面板写入，优先于 patch 初始值）
 * ------------------------------------------------------------------ */
export function resolveDshHome() {
    const explicit = process.env.DSH_HAAVK_HOME;
    if (explicit && explicit.trim())
        return explicit.trim();
    const home = process.env.DSH_HOME;
    if (home && home.trim())
        return home.trim();
    return join(homedir(), '.dsh');
}
export function defaultSettingsPath() {
    return join(resolveDshHome(), PLUGIN_ID, 'settings.json');
}
export class ConfigStore {
    file;
    value;
    watchers = new Set();
    onLog;
    constructor(seed, file = defaultSettingsPath(), onLog = () => { }) {
        this.file = file;
        this.onLog = onLog;
        this.value = normalizeConfig(seed);
        this.load();
    }
    load() {
        try {
            if (!existsSync(this.file))
                return;
            const persisted = JSON.parse(readFileSync(this.file, 'utf8'));
            this.value = normalizeConfig({ ...this.value, ...(persisted && typeof persisted === 'object' ? persisted : {}) });
        }
        catch (error) {
            this.onLog(`settings.json 读取失败，回退到默认配置: ${error?.message ?? String(error)}`);
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            this.onLog(`settings.json 写入失败: ${error?.message ?? String(error)}`);
        }
    }
    get() {
        return this.value;
    }
    update(patch) {
        const next = normalizeConfig({ ...this.value, ...patch });
        const changed = JSON.stringify(next) !== JSON.stringify(this.value);
        this.value = next;
        if (!changed)
            return this.value;
        this.persist();
        for (const watcher of this.watchers) {
            try {
                watcher(next);
            }
            catch (error) {
                this.onLog(`配置监听回调异常: ${error?.message ?? String(error)}`);
            }
        }
        return this.value;
    }
    watch(callback) {
        this.watchers.add(callback);
        return () => this.watchers.delete(callback);
    }
    dispose() {
        this.watchers.clear();
    }
}
function sseFrame(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
}
export class EventHub {
    clients = new Set();
    sequence = null;
    recentLogs = [];
    logLimit;
    statusProvider;
    keepAlive = null;
    logSink;
    constructor(options) {
        this.logLimit = Math.max(20, options.logLimit);
        this.statusProvider = options.status;
        this.logSink = options.onLog ?? (() => { });
    }
    get clientCount() {
        return this.clients.size;
    }
    setStatusProvider(provider) {
        this.statusProvider = provider;
    }
    setLogLimit(limit) {
        this.logLimit = Math.max(20, limit);
        if (this.recentLogs.length > this.logLimit) {
            this.recentLogs = this.recentLogs.slice(-this.logLimit);
        }
    }
    setSequence(sequence) {
        this.sequence = sequence;
    }
    getSequence() {
        return this.sequence;
    }
    getLogs() {
        return [...this.recentLogs];
    }
    pushLog(entry) {
        this.recentLogs.push(entry);
        if (this.recentLogs.length > this.logLimit)
            this.recentLogs.splice(0, this.recentLogs.length - this.logLimit);
        this.logSink(entry);
        this.broadcast({ kind: 'log', entry });
    }
    broadcast(event) {
        if (this.clients.size === 0)
            return;
        const frame = sseFrame(event);
        for (const response of this.clients) {
            try {
                response.write(frame);
            }
            catch {
                this.clients.delete(response);
            }
        }
    }
    /** 新连接：先把快照（状态、序列、近期日志）补齐，再进入增量流。 */
    add(request, response) {
        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        response.write('retry: 2000\n\n');
        const status = this.statusProvider();
        try {
            response.write(sseFrame({
                kind: 'hello',
                plugin: PLUGIN_ID,
                now: Date.now(),
                status,
                sequence: status.online ? this.sequence : null,
                logs: this.recentLogs.slice(-40),
            }));
        }
        catch {
            /* 连接已断开，交给 close 清理 */
        }
        this.clients.add(response);
        this.ensureKeepAlive();
        const remove = () => {
            this.clients.delete(response);
            if (this.clients.size === 0)
                this.stopKeepAlive();
        };
        request.on('close', remove);
        request.on('error', remove);
        return remove;
    }
    ensureKeepAlive() {
        if (this.keepAlive)
            return;
        // 心跳注释行，避免代理 / 浏览器在空闲时断开 SSE。
        this.keepAlive = setInterval(() => {
            for (const response of this.clients) {
                try {
                    response.write(': haavk-ping\n\n');
                }
                catch {
                    this.clients.delete(response);
                }
            }
            if (this.clients.size === 0)
                this.stopKeepAlive();
        }, 15_000);
        this.keepAlive.unref?.();
    }
    stopKeepAlive() {
        if (!this.keepAlive)
            return;
        clearInterval(this.keepAlive);
        this.keepAlive = null;
    }
    /** 卸载前调用：先让浏览器收到离线帧，再断开所有连接。 */
    closeAll(graceMs = 250) {
        for (const response of this.clients) {
            try {
                response.end();
            }
            catch {
                /* ignore */
            }
        }
        this.clients.clear();
        this.stopKeepAlive();
        if (graceMs > 0) {
            const timer = setTimeout(() => { }, graceMs);
            timer.unref?.();
        }
    }
    dispose() {
        this.stopKeepAlive();
        this.clients.clear();
        this.recentLogs = [];
    }
}
export class TaskRunner {
    child = null;
    state = 'idle';
    command = '';
    startedAt = null;
    endedAt = null;
    exitCode = null;
    buffer = [];
    limit;
    timeout = null;
    pendingKill = null;
    log;
    cwd;
    constructor(options) {
        this.limit = Math.max(20, options.limit);
        this.cwd = options.cwd ?? process.cwd();
        this.log = options.log;
    }
    snapshot() {
        return {
            state: this.state,
            command: this.command,
            pid: this.child?.pid ?? null,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            exitCode: this.exitCode,
            lines: [...this.buffer],
        };
    }
    setLogLimit(limit) {
        this.limit = Math.max(20, limit);
        if (this.buffer.length > this.limit)
            this.buffer = this.buffer.slice(-this.limit);
    }
    append(level, message) {
        const stamp = new Date().toISOString().slice(11, 19);
        this.buffer.push(`[${stamp}] ${message}`);
        if (this.buffer.length > this.limit)
            this.buffer.splice(0, this.buffer.length - this.limit);
        this.log(level, message);
    }
    /** 异步启动：立即返回，不阻塞 DSH 内核。 */
    start(command, options = {}) {
        this.stop('restart');
        const trimmed = command.trim();
        if (!trimmed) {
            this.state = 'idle';
            this.command = '';
            this.append('info', '未配置启动脚本，跳过执行');
            return;
        }
        this.command = trimmed;
        this.state = 'running';
        this.startedAt = Date.now();
        this.endedAt = null;
        this.exitCode = null;
        this.buffer = [];
        let child;
        try {
            child = spawn(trimmed, {
                shell: true,
                cwd: this.cwd,
                env: process.env,
                windowsHide: true,
                // POSIX 下建独立进程组，卸载时整组回收；Windows 用 taskkill /T。
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            this.state = 'failed';
            this.endedAt = Date.now();
            this.append('error', `启动失败: ${error?.message ?? String(error)}`);
            return;
        }
        this.child = child;
        this.append('info', `托管进程已拉起 pid=${child.pid ?? '?'} cmd=${trimmed}`);
        const pipe = (stream, level) => {
            if (!stream)
                return;
            stream.setEncoding?.('utf8');
            stream.on('data', (chunk) => {
                for (const line of String(chunk).split(/\r?\n/)) {
                    if (line.trim())
                        this.append(level, line);
                }
            });
        };
        pipe(child.stdout, 'info');
        pipe(child.stderr, 'error');
        child.once('error', (error) => {
            this.state = 'failed';
            this.endedAt = Date.now();
            this.append('error', `进程错误: ${error.message}`);
        });
        child.once('exit', (code, signal) => {
            this.child = null;
            this.exitCode = code;
            this.endedAt = Date.now();
            if (this.state !== 'killed')
                this.state = code === 0 ? 'exited' : 'failed';
            this.append(code === 0 ? 'info' : 'warn', `进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`);
            if (this.timeout) {
                clearTimeout(this.timeout);
                this.timeout = null;
            }
        });
        const timeoutMs = options.timeoutMs ?? 0;
        if (timeoutMs > 0) {
            this.timeout = setTimeout(() => {
                this.append('warn', `启动脚本超过 ${timeoutMs}ms，强制终止`);
                this.stop('timeout');
            }, timeoutMs);
            this.timeout.unref?.();
        }
    }
    /** 强制终止托管进程（含子进程树）。 */
    stop(reason = 'stop') {
        if (this.pendingKill) {
            clearTimeout(this.pendingKill);
            this.pendingKill = null;
        }
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        const child = this.child;
        if (!child || child.pid === undefined) {
            if (this.state === 'running')
                this.state = 'killed';
            return;
        }
        const pid = child.pid;
        this.state = 'killed';
        this.append('warn', `终止托管进程 pid=${pid}（${reason}）`);
        if (process.platform === 'win32') {
            try {
                const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
                killer.on('error', () => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
                        /* ignore */
                    }
                });
            }
            catch {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    /* ignore */
                }
            }
        }
        else {
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch {
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    /* ignore */
                }
            }
            this.pendingKill = setTimeout(() => {
                try {
                    process.kill(-pid, 'SIGKILL');
                }
                catch {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
                        /* ignore */
                    }
                }
                this.pendingKill = null;
            }, 2000);
            this.pendingKill.unref?.();
        }
        this.child = null;
    }
    dispose() {
        this.stop('dispose');
        this.buffer = [];
    }
}
/* ------------------------------------------------------------------ *
 * Host 侧音频（可选分支：node-playsound）
 * ------------------------------------------------------------------ */
export class HostAudio {
    player = null;
    probing = null;
    unavailableReason = null;
    log;
    constructor(log) {
        this.log = log;
    }
    get available() {
        return this.player !== null && this.unavailableReason === null;
    }
    get reason() {
        return this.unavailableReason;
    }
    /** 无音频设备的保守探测：Linux 看 /dev/snd 与 PulseAudio/PipeWire。 */
    static detectDevice() {
        if (process.platform === 'linux') {
            return existsSync('/dev/snd')
                || Boolean(process.env.PULSE_SERVER)
                || Boolean(process.env.PIPEWIRE_RUNTIME_DIR)
                || Boolean(process.env.XDG_RUNTIME_DIR && existsSync(join(process.env.XDG_RUNTIME_DIR, 'pulse')));
        }
        return true;
    }
    async ensure() {
        if (this.player || this.probing) {
            await this.probing;
            return;
        }
        if (!HostAudio.detectDevice()) {
            this.unavailableReason = '未检测到音频设备';
            this.log('warn', '无音频设备，Host 侧静音，主流程继续');
            return;
        }
        this.probing = (async () => {
            try {
                const spec = 'node-playsound';
                const mod = (await import(spec));
                this.player = mod?.default ?? mod;
                this.log('info', 'Host 侧播放器就绪（node-playsound）');
            }
            catch {
                this.unavailableReason = 'node-playsound 不可用';
                this.log('warn', 'node-playsound 不可用，Host 侧音频降级为静音');
            }
            finally {
                this.probing = null;
            }
        })();
        await this.probing;
    }
    async play(filePath) {
        const path = filePath.trim();
        if (!path)
            return;
        if (!existsSync(path)) {
            this.log('warn', `音频文件缺失，已跳过: ${path}`);
            return;
        }
        await this.ensure();
        const player = this.player;
        if (!player || typeof player.play !== 'function')
            return;
        try {
            await Promise.resolve(player.play(path));
            this.log('info', `Host 侧音频已播放: ${path}`);
        }
        catch (error) {
            this.unavailableReason = '播放失败';
            this.player = null;
            this.log('warn', `Host 侧音频播放失败，已静音: ${error?.message ?? String(error)}`);
        }
    }
    dispose() {
        this.player = null;
        this.probing = null;
    }
}
/* ------------------------------------------------------------------ *
 * ASCII 横幅
 * ------------------------------------------------------------------ */
export function renderAsciiBanner(captions = DEFAULT_CAPTIONS) {
    const art = [
        '██╗  ██╗ █████╗  █████╗ ██╗   ██╗██╗  ██╗',
        '██║  ██║██╔══██╗██╔══██╗██║   ██║██║ ██╔╝',
        '███████║███████║███████║██║   ██║█████╔╝ ',
        '██╔══██║██╔══██║██╔══██║╚██╗ ██╔╝██╔═██╗ ',
        '██║  ██║██║  ██║██║  ██║ ╚████╔╝ ██║  ██╗',
        '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝  ╚═╝',
    ];
    const rule = '─'.repeat(48);
    const tail = captions.map((caption) => `    ${caption.text}`).join('\n');
    return [
        '',
        `  ┌${rule}┐`,
        ...art.map((line) => `  │ ${line.padEnd(46).slice(0, 46)} │`),
        `  │ ${'RELINK NODE  ·  HAAVK'.padEnd(46).slice(0, 46)} │`,
        `  └${rule}┘`,
        '',
        tail,
        '',
        '  [HAAVK-CORE] 节点稳定在线，后台任务持续运行。',
        '',
    ].join('\n');
}
/**
 * DSH 没有公开的 `cordis.boot` 单一事件（Cordis 的 core 不 emit boot）。
 * 这里同时监听若干候选信号，取最先到达者：
 *   - `cordis.boot`（兼容旧版 / 自定义启动器）
 *   - `app/ready`、`loader/ready`、`app-boot/ready`（宿主若提供）
 *   - webServer 服务注入成功（HTTP 已 listening 的最强实际信号）
 *   - 兜底超时（headless / CLI，保证序列照常执行）
 */
export function createReadyGate(options) {
    let settled = false;
    let resolveFn = null;
    const disposers = [];
    const promise = new Promise((resolve) => {
        resolveFn = resolve;
    });
    const settle = (source) => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        resolveFn?.(source);
    };
    const timer = setTimeout(() => settle('timeout'), Math.max(200, options.fallbackMs));
    timer.unref?.();
    for (const event of ['cordis.boot', 'app/ready', 'loader/ready', 'app-boot/ready']) {
        try {
            const off = options.on?.(event, () => settle(event), { global: true });
            if (typeof off === 'function')
                disposers.push(off);
        }
        catch {
            /* 未知事件名在部分宿主上会抛错，忽略即可 */
        }
    }
    return {
        promise,
        notify: settle,
        dispose() {
            if (timer)
                clearTimeout(timer);
            for (const off of disposers) {
                try {
                    off();
                }
                catch {
                    /* ignore */
                }
            }
            disposers.length = 0;
        },
    };
}
/* ------------------------------------------------------------------ *
 * HTTP 辅助
 * ------------------------------------------------------------------ */
export function isLocalRequest(request) {
    const address = request.socket?.remoteAddress;
    if (address && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
        return false;
    const host = request.headers?.host;
    if (host) {
        try {
            const parsed = new URL(`http://${host}`);
            if (parsed.username || parsed.password)
                return false;
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
                return false;
        }
        catch {
            return false;
        }
    }
    const origin = request.headers?.origin;
    if (!origin)
        return true;
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.headers?.host;
    }
    catch {
        return false;
    }
}
export function jsonResponse(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
}
async function readJsonBody(request, limit = 32 * 1024) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limit)
            throw new Error('request body is too large');
        chunks.push(buffer);
    }
    if (bytes === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/* ------------------------------------------------------------------ *
 * 序列构造
 * ------------------------------------------------------------------ */
export function buildSequence(config, trigger = 'boot', captions = DEFAULT_CAPTIONS) {
    return {
        id: `${trigger}-${Date.now().toString(36)}`,
        startedAt: Date.now(),
        durationMs: SEQUENCE_DURATION_MS,
        captions: captions.map((caption) => ({ at: caption.at, text: caption.text })),
        audio: {
            mode: config.audioMode,
            volume: config.audioVolume,
            enabled: config.audioEnabled,
            bootWavPath: config.bootWavPath,
        },
        visual: {
            enabled: config.visualEnabled,
            glowIntensity: config.glowIntensity,
        },
        trigger,
    };
}
export function createLogger(base) {
    let sink = () => { };
    const out = {
        log(channel, level, message) {
            const prefix = `[HAAVK-${channel}]`;
            const line = `${prefix} ${message}`;
            try {
                if (level === 'error')
                    (base?.error ?? console.error)(line);
                else if (level === 'warn')
                    (base?.warn ?? console.warn)(line);
                else
                    (base?.info ?? console.log)(line);
            }
            catch {
                /* logger 自身异常不应影响主流程 */
            }
            try {
                sink({ ts: Date.now(), channel, level, message });
            }
            catch {
                /* ignore */
            }
        },
        core(message) {
            out.log('CORE', 'info', message);
        },
        warn(message) {
            out.log('CORE', 'warn', message);
        },
        error(message) {
            out.log('CORE', 'error', message);
        },
        audio(message, level = 'info') {
            out.log('AUDIO', level, message);
        },
        visual(message, level = 'info') {
            out.log('VISUAL', level, message);
        },
        task(message, level = 'info') {
            out.log('TASK', level, message);
        },
        bindSink(next) {
            sink = next;
        },
    };
    return out;
}
export function apply(ctx, config = {}) {
    const logger = createLogger(ctx.logger);
    const trace = (msg) => {
        try {
            const f = join(resolveDshHome(), PLUGIN_ID, 'boot.log');
            mkdirSync(dirname(f), { recursive: true });
            appendFileSync(f, `${new Date().toISOString()} ${msg}\n`, 'utf8');
        }
        catch {
            /* ignore */
        }
    };
    /* 启动诊断：能读到这行就说明插件被 Loader 加载了。
     * 路径：$DSH_HOME/dsh-haavk-boot/boot.log */
    try {
        const bootLog = join(resolveDshHome(), PLUGIN_ID, 'boot.log');
        mkdirSync(dirname(bootLog), { recursive: true });
        const hasWebServer = Boolean((typeof ctx.get === 'function'
            ? ctx.get('webServer')
            : undefined) ?? ctx.webServer);
        appendFileSync(bootLog, `${new Date().toISOString()} apply()  v=${'0.2.0'}  webServer=${hasWebServer ? 'yes' : 'no'}  inject=${JSON.stringify(inject)}\n`, 'utf8');
    }
    catch {
        /* 诊断失败不影响主流程 */
    }
    trace('stage:bootlog-written');
    let store;
    try {
        store = new ConfigStore(config, defaultSettingsPath(), (line) => logger.warn(line));
        trace('stage:store-ok');
    }
    catch (err) {
        trace(`stage:store-FAIL ${err?.message ?? String(err)}`);
        throw err;
    }
    try {
        runApply(ctx, config, { logger, trace, store });
    }
    catch (err) {
        trace(`stage:apply-FAIL ${err?.message ?? String(err)}`);
        trace(`stage:apply-STACK ${(err?.stack ?? '').split('\n').slice(0, 6).join(' | ')}`);
        throw err;
    }
}
function runApply(ctx, config, deps) {
    const { logger, trace, store } = deps;
    trace('stage:runApply-enter');
    let online = false;
    let bootedAt = null;
    let bootSignal = null;
    let lastError = null;
    let startedAt = Date.now();
    let disposed = false;
    const runner = new TaskRunner({
        limit: store.get().telemetryLogLimit,
        log: (level, message) => logger.task(message, level),
    });
    const hub = new EventHub({
        logLimit: store.get().telemetryLogLimit,
        status: () => snapshot(),
        onLog: (entry) => {
            // 日志同时写进 Host 日志（已完成）与 SSE 客户端（由 broadcast 完成）
            void entry;
        },
    });
    const hostAudio = new HostAudio((level, message) => logger.audio(message, level));
    const snapshot = () => ({
        plugin: PLUGIN_ID,
        online,
        bootedAt,
        bootSignal,
        uptimeMs: bootedAt ? Date.now() - bootedAt : 0,
        clients: hub.clientCount,
        task: runner.snapshot().state,
        taskPid: runner.snapshot().pid,
        audioEnabled: store.get().audioEnabled,
        visualEnabled: store.get().visualEnabled,
        lastError,
    });
    logger.bindSink((entry) => hub.pushLog(entry));
    hub.setLogLimit(store.get().telemetryLogLimit);
    logger.core(`哈夫克 Relink 节点固件加载 (${PLUGIN_ID} v0.2.0)`);
    /* ---------- 序列调度 ---------- */
    const timers = new Set();
    const schedule = (fn, delay) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!disposed)
                fn();
        }, Math.max(0, delay));
        timers.add(timer);
    };
    const clearTimers = () => {
        for (const timer of timers)
            clearTimeout(timer);
        timers.clear();
    };
    const fireBoot = (source) => {
        if (disposed)
            return;
        const settings = store.get();
        bootSignal = source;
        if (!settings.enabled) {
            logger.core(`节点总开关关闭，跳过 Relink 序列（信号: ${source}）`);
            return;
        }
        if (online) {
            logger.core('节点已在线，忽略重复的入网触发');
            return;
        }
        online = true;
        bootedAt = Date.now();
        hub.setSequence(buildSequence(settings, 'boot'));
        logger.core(`内核就绪信号: ${source} → 下发【节点入网事件】`);
        if (settings.asciiBanner) {
            const banner = renderAsciiBanner();
            try {
                process.stdout.write(`${banner}\n`);
            }
            catch {
                /* 无 TTY 也不报错 */
            }
        }
        if (settings.visualEnabled)
            logger.visual(`可视化模块已启用（辉光 ${settings.glowIntensity.toFixed(2)}）`);
        else
            logger.visual('可视化模块已关闭，仅执行后台任务');
        if (settings.audioEnabled)
            logger.audio(`入网音效（${settings.audioMode === 'file' ? '自定义 wav' : 'WebAudio 合成'}，音量 ${settings.audioVolume.toFixed(2)}）`);
        else
            logger.audio('音频模块已关闭');
        hub.broadcast({ kind: 'sequence', sequence: hub.getSequence() });
        hub.broadcast({ kind: 'status', status: snapshot() });
        // Host 侧音频（可选分支）
        if (settings.audioEnabled && settings.hostAudioEnabled && settings.audioMode === 'file' && settings.bootWavPath.trim()) {
            void hostAudio.play(settings.bootWavPath);
        }
        // 自定义启动脚本：异步、托管、不阻塞内核
        if (settings.bootScript.trim()) {
            logger.core('拉起自定义启动脚本');
            runner.start(settings.bootScript, { timeoutMs: settings.bootScriptTimeoutMs });
            hub.broadcast({ kind: 'status', status: snapshot() });
        }
        else {
            logger.core('未配置启动脚本，节点仅进入在线待机');
        }
    };
    const fireOffline = (reason) => {
        if (!online)
            return;
        online = false;
        hub.setSequence(null);
        logger.core(`下发【离线事件】（${reason}）`);
        hub.broadcast({ kind: 'offline', reason, at: Date.now() });
        hub.broadcast({ kind: 'status', status: snapshot() });
        const settings = store.get();
        if (settings.audioEnabled && settings.hostAudioEnabled && settings.audioMode === 'file' && settings.shutdownWavPath.trim()) {
            void hostAudio.play(settings.shutdownWavPath);
        }
        runner.stop(`offline:${reason}`);
    };
    /* ---------- 就绪门控 ---------- */
    const gate = createReadyGate({
        on: typeof ctx.on === 'function' ? (event, callback, opts) => ctx.on?.(event, callback, opts) : undefined,
        fallbackMs: 8000,
    });
    void gate.promise.then((source) => {
        if (disposed)
            return;
        const delay = store.get().bootDelayMs;
        if (delay > 0) {
            logger.core(`内核就绪（${source}），${delay}ms 后触发 Relink 序列`);
            schedule(() => fireBoot(source), delay);
        }
        else {
            fireBoot(source);
        }
    });
    /* ---------- 遥测工具 ---------- */
    /* 注意：Cordis 4 中访问未声明 inject 的服务会直接 throw，
     * 因此必须先声明 inject: ['tools']，或整体 try 包裹。 */
    let toolsService = null;
    try {
        toolsService = ctx.tools;
    }
    catch {
        toolsService = null;
    }
    if (toolsService && typeof toolsService.register === 'function') {
        try {
            toolsService.register({
                name: 'haavk_node_status',
                description: '读取 HAAVK Relink 节点运行状态：在线状态、上线时间、链路客户端数、托管任务日志与 PID、音频/画面开关。',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {},
                },
                output: {
                    schema: { type: 'object' },
                    render: (_args, value) => [{
                            type: 'text',
                            text: JSON.stringify(value, null, 2),
                        }],
                },
                async execute() {
                    return {
                        ...snapshot(),
                        node: {
                            name: 'Relink-3',
                            codename: 'HAAVK',
                            status: online ? 'online' : 'standby',
                            bootedAt: bootedAt ? new Date(bootedAt).toISOString() : null,
                            bootSignal,
                        },
                        link: {
                            clients: hub.clientCount,
                            transport: 'sse',
                            endpoint: EVENTS_ENDPOINT,
                        },
                        task: runner.snapshot(),
                        audio: {
                            enabled: store.get().audioEnabled,
                            mode: store.get().audioMode,
                            volume: store.get().audioVolume,
                            hostPlayer: hostAudio.available ? 'ready' : hostAudio.reason ?? 'idle',
                        },
                        visual: {
                            enabled: store.get().visualEnabled,
                            glowIntensity: store.get().glowIntensity,
                        },
                        logs: hub.getLogs().slice(-40),
                        settingsFile: store.file,
                    };
                },
            });
            logger.core('遥测工具 haavk_node_status 已注册');
        }
        catch (error) {
            logger.warn(`遥测工具注册失败: ${error?.message ?? String(error)}`);
        }
    }
    else {
        logger.warn('tools 服务不可用，遥测工具未注册（其他功能照常）');
    }
    /* ---------- 配置热更新 ---------- */
    store.watch((next) => {
        hub.setLogLimit(next.telemetryLogLimit);
        runner.setLogLimit(next.telemetryLogLimit);
        logger.core(`配置已更新（画面 ${next.visualEnabled ? '开' : '关'} / 音频 ${next.audioEnabled ? '开' : '关'} / 脚本 ${next.bootScript.trim() ? '已配置' : '未配置'}）`);
        if (!next.enabled && online)
            fireOffline('settings-disabled');
        hub.broadcast({ kind: 'status', status: snapshot() });
    });
    /* ---------- HTTP 端点 ---------- */
    const registerRoutes = (host) => {
        const resolve = (key) => {
            try {
                const getter = host.get;
                const viaGet = typeof getter === 'function' ? getter.call(host, key) : undefined;
                if (viaGet)
                    return viaGet;
            }
            catch {
                /* 取不到就走属性 */
            }
            return host[key];
        };
        const rawServer = resolve('webServer');
        trace(`registerRoutes: webServer=${rawServer ? typeof rawServer : 'undefined'}`);
        if (!rawServer)
            return () => { };
        const server = rawServer;
        const assetRoot = dirname(fileURLToPath(import.meta.url));
        const readText = (name) => {
            try {
                return readFileSync(join(assetRoot, name), 'utf8');
            }
            catch {
                return '';
            }
        };
        const sendText = (response, type, body) => {
            response.writeHead(200, {
                'content-type': type,
                'cache-control': 'no-store',
                'content-length': Buffer.byteLength(body),
            });
            response.end(body);
        };
        /** 启动屏 HTML：首屏就盖住窗口，DSH 渲染完再溶解。 */
        const bootMarkup = () => {
            const c = store.get();
            if (!c.enabled || !c.bootSplash)
                return '';
            return ('<div id="dsh-startup-root">' +
                '<video class="haavk-boot" src="' + SPLASH_ASSET + '" playsinline preload="auto"></video>' +
                '<div class="haavk-grade"></div><div class="haavk-sweep"></div><canvas class="haavk-fx"></canvas>' +
                '<header><span><b>HAAVK</b> &nbsp;//&nbsp; RELINK NODE · SECURE LINK</span>' +
                '<span>NODE-03 · CN UID 0086</span></header>' +
                '<div class="haavk-cast">' +
                '<p id="haavk-c1">信息与你无限，</p>' +
                '<p id="haavk-c2">Relink 重塑未来。</p>' +
                '<p id="haavk-c3">欢迎使用 Relink 三号体验版。</p>' +
                '<p id="haavk-c4">本设备将持续采集上传您的</p>' +
                '<p id="haavk-c5">生理体征、精神状态相关数据，</p>' +
                '<p id="haavk-c6">请在使用前，检阅并签署用户协议。</p></div>' +
                '<footer><span><b>55 ms</b> &nbsp;·&nbsp; NEURAL SYNC &nbsp;·&nbsp; 天空属于哈夫克</span>' +
                '<span>REAL-TIME TELEMETRY</span></footer>' +
                '<div class="haavk-bar"><i></i></div>' +
                '<script>document.documentElement.classList.add("dsu-lock")</' + 'script>' +
                '<script defer src="' + SPLASH_JS + '"></' + 'script>');
        };
        const injectBoot = (html) => {
            if (!html || !html.includes('<body'))
                return html;
            if (html.includes(SPLASH_JS))
                return html;
            const body = bootMarkup();
            if (!body)
                return html;
            const head = '<link rel="stylesheet" href="' + SPLASH_CSS + '">';
            let out = html.includes('</head>') ? html.replace('</head>', head + '</head>') : head + html;
            out = out.replace('<body>', '<body>' + body);
            return out;
        };
        const offs = [];
        const mount = (path, handler, label) => {
            const guard = async (request, response) => {
                if (!isLocalRequest(request)) {
                    jsonResponse(response, 403, { error: 'local access only' });
                    return;
                }
                try {
                    await handler(request, response);
                }
                catch (error) {
                    lastError = error?.message ?? String(error);
                    try {
                        jsonResponse(response, 500, { error: lastError });
                    }
                    catch {
                        /* 响应已提交 */
                    }
                }
            };
            try {
                const disposer = server.register({ kind: 'exact', path, handler: guard });
                if (typeof disposer === 'function')
                    offs.push(disposer);
                trace(`route ok ${path}`);
            }
            catch (error) {
                trace(`route FAIL ${path}: ${error?.message ?? String(error)}`);
                logger.warn(`路由注册失败 ${path} (${label}): ${error?.message ?? String(error)}`);
            }
        };
        mount(SPLASH_CSS, (request, response) => {
            sendText(response, 'text/css; charset=utf-8', readText('splash.css'));
        }, 'splash-css');
        mount(SPLASH_JS, (request, response) => {
            sendText(response, 'application/javascript; charset=utf-8', readText('splash.js'));
        }, 'splash-js');
        mount(SPLASH_ASSET, (request, response) => {
            let bytes;
            try {
                bytes = readFileSync(join(assetRoot, 'assets', 'boot.mp4'));
            }
            catch {
                jsonResponse(response, 404, { error: 'boot asset missing' });
                return;
            }
            response.writeHead(200, {
                'content-type': 'video/mp4',
                'cache-control': 'public, max-age=86400',
                'content-length': bytes.length,
            });
            response.end(bytes);
        }, 'splash-video');
        mount(CONFIG_ENDPOINT, async (request, response) => {
            if (request.method === 'GET') {
                jsonResponse(response, 200, { config: store.get(), file: store.file, defaults: CONFIG_DEFAULTS });
                return;
            }
            if (request.method !== 'PATCH' && request.method !== 'POST') {
                jsonResponse(response, 405, { error: 'method not allowed' });
                return;
            }
            const patch = sanitizePatch(await readJsonBody(request));
            const next = store.update(patch);
            jsonResponse(response, 200, { config: next });
        }, 'config');
        mount(EVENTS_ENDPOINT, (request, response) => {
            if (request.method !== 'GET') {
                jsonResponse(response, 405, { error: 'method not allowed' });
                return;
            }
            hub.add(request, response);
            logger.visual(`可视化客户端已接入（当前 ${hub.clientCount} 个）`);
        }, 'sse');
        mount(STATUS_ENDPOINT, (request, response) => {
            if (request.method !== 'GET') {
                jsonResponse(response, 405, { error: 'method not allowed' });
                return;
            }
            jsonResponse(response, 200, snapshot());
        }, 'status');
        mount(LOGS_ENDPOINT, (request, response) => {
            if (request.method !== 'GET') {
                jsonResponse(response, 405, { error: 'method not allowed' });
                return;
            }
            jsonResponse(response, 200, { logs: hub.getLogs(), task: runner.snapshot() });
        }, 'logs');
        mount(PREVIEW_ENDPOINT, (request, response) => {
            if (request.method !== 'POST') {
                jsonResponse(response, 405, { error: 'method not allowed' });
                return;
            }
            const settings = store.get();
            if (!settings.enabled) {
                jsonResponse(response, 409, { error: '节点总开关已关闭' });
                return;
            }
            if (!online) {
                online = true;
                bootedAt = Date.now();
                bootSignal = 'preview';
            }
            const sequence = buildSequence(settings, 'preview');
            hub.setSequence(sequence);
            logger.core('手动预览 Relink 序列');
            hub.broadcast({ kind: 'sequence', sequence });
            hub.broadcast({ kind: 'status', status: snapshot() });
            jsonResponse(response, 200, { ok: true, sequence });
        }, 'preview');
        mount(TASK_ENDPOINT, async (request, response) => {
            if (request.method === 'POST') {
                const body = (await readJsonBody(request));
                if (body.action === 'stop') {
                    runner.stop('manual');
                    hub.broadcast({ kind: 'status', status: snapshot() });
                    jsonResponse(response, 200, { ok: true, task: runner.snapshot() });
                    return;
                }
                if (body.action === 'restart') {
                    const settings = store.get();
                    runner.start(settings.bootScript, { timeoutMs: settings.bootScriptTimeoutMs });
                    jsonResponse(response, 200, { ok: true, task: runner.snapshot() });
                    return;
                }
                jsonResponse(response, 400, { error: 'unknown action' });
                return;
            }
            jsonResponse(response, 405, { error: 'method not allowed' });
        }, 'task');
        const tapIndex = server.tapIndex;
        trace(`tapIndex=${typeof tapIndex}`);
        if (typeof tapIndex === 'function') {
            const disposer = tapIndex.call(server, (html) => {
                try {
                    return injectBoot(html);
                }
                catch {
                    return html;
                }
            });
            if (typeof disposer === 'function')
                offs.push(disposer);
            logger.core('启动屏已挂到 index.html（tapIndex）');
        }
        else {
            logger.warn('webServer 不支持 tapIndex，启动屏降级为客户端自举');
        }
        return () => {
            for (const off of offs) {
                try {
                    off();
                }
                catch {
                    /* ignore */
                }
            }
            offs.length = 0;
        };
    };
    /**
     * 与 dsh-haavk 完全一致：
     *   inject 声明 ['webServer','connection'] → apply 时服务必然就绪
     *   resolveWebServer() 先 ctx.get('webServer') 再 ctx.webServer
     *   直接 webServer.register(...)，不套 ctx.inject 回调
     */
    let webReady = false;
    const resolveWebServer = () => {
        try {
            const getter = ctx.get;
            const viaGet = typeof getter === 'function' ? getter.call(ctx, 'webServer') : undefined;
            if (viaGet)
                return viaGet;
        }
        catch {
            /* 取不到当没有 */
        }
        try {
            /* Cordis 4：未 inject 的服务访问会 throw，必须包住 */
            return ctx.webServer;
        }
        catch {
            return undefined;
        }
    };
    const webServer = resolveWebServer();
    trace(`webServer=${typeof webServer} register=${typeof webServer?.register} tapIndex=${typeof webServer?.tapIndex}`);
    if (webServer && typeof webServer.register === 'function') {
        const teardown = registerRoutes(ctx);
        webReady = true;
        logger.core(`Web 端点已挂载（${CONFIG_ENDPOINT} / ${EVENTS_ENDPOINT}）`);
        gate.notify('webServer');
        try {
            ctx.effect?.(() => () => teardown(), 'dsh-haavk-boot: http routes');
        }
        catch {
            /* 宿主不支持 effect 时由 plugin dispose 回收 */
        }
        hub.broadcast({ kind: 'status', status: snapshot() });
    }
    else {
        logger.warn('webServer 不可用：启动屏与面板降级，仅执行后台任务');
    }
    /* ---------- 生命周期回收 ---------- */
    const cleanup = () => {
        if (disposed)
            return;
        disposed = true;
        clearTimers();
        gate.dispose();
        fireOffline('dispose');
        runner.dispose();
        hostAudio.dispose();
        store.dispose();
        hub.broadcast({ kind: 'status', status: snapshot() });
        hub.closeAll();
        hub.dispose();
        logger.core('节点固件已卸载：子进程、定时器、音频与会话资源已释放');
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => cleanup, 'dsh-haavk-boot: lifecycle');
    }
    else {
        process.once('beforeExit', cleanup);
    }
    // 让宿主与测试都能看到运行时状态
    // 注意：Cordis 4 禁止直接向 ctx 写未 provide 的属性（会 throw），必须包住。
    try {
        ctx.haavk = { store, hub, runner, hostAudio, snapshot, fireBoot, fireOffline, webReady: () => webReady };
    }
    catch {
        /* 宿主禁止扩展 ctx 时跳过内省挂载，不影响功能 */
    }
}
/* 便于单元测试与宿主内省 */
export const internals = {
    CONFIG_DEFAULTS,
    DEFAULT_CAPTIONS,
    SEQUENCE_DURATION_MS,
};
