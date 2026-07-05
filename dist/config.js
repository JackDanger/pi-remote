import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const DEFAULT_SHUTDOWN_GRACE_MS = 120_000;
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 1_800_000;
export function parseModelRef(value) {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) {
        throw new Error(`Invalid model reference "${value}" (expected "provider/model-id")`);
    }
    return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
export function expandTilde(p) {
    if (p === "~")
        return os.homedir();
    if (p.startsWith("~/"))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
function readConfigFile(filePath) {
    if (!fs.existsSync(filePath))
        return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Config file ${filePath} must contain a JSON object`);
    }
    return parsed;
}
function parsePort(value, source) {
    const port = typeof value === "number" ? value : Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port "${value}" from ${source}`);
    }
    return port;
}
function parseNonNegativeMs(value, source) {
    const ms = typeof value === "number" ? value : Number.parseInt(value, 10);
    if (!Number.isInteger(ms) || ms < 0) {
        throw new Error(`Invalid milliseconds value "${value}" from ${source}`);
    }
    return ms;
}
export function parseHttpIdleTimeoutMs(value, source) {
    if (typeof value === "string" && value.trim().toLowerCase() === "disabled")
        return 0;
    const ms = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`Invalid HTTP idle timeout "${value}" from ${source} (expected non-negative milliseconds or "disabled")`);
    }
    return Math.floor(ms);
}
function parseBoolean(value, source) {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    throw new Error(`Invalid boolean "${value}" from ${source}`);
}
export function defaultConfigPath(env = process.env) {
    return env.PI_REMOTE_CONFIG ?? path.join(os.homedir(), ".config", "pi-remote", "config.json");
}
export function loadConfig(env = process.env) {
    const file = readConfigFile(defaultConfigPath(env));
    const host = env.PI_REMOTE_HOST ?? file.host ?? "127.0.0.1";
    const port = env.PI_REMOTE_PORT
        ? parsePort(env.PI_REMOTE_PORT, "PI_REMOTE_PORT")
        : file.port !== undefined
            ? parsePort(file.port, "config file")
            : 3141;
    const workspaceRoot = expandTilde(env.PI_REMOTE_WORKSPACE_ROOT ?? file.workspaceRoot ?? path.join(os.homedir(), "pi-workspaces"));
    const agentDirRaw = env.PI_REMOTE_AGENT_DIR ?? file.agentDir;
    const defaultModelRaw = env.PI_REMOTE_DEFAULT_MODEL ?? file.defaultModel;
    const shutdownGraceMs = env.PI_REMOTE_SHUTDOWN_GRACE_MS
        ? parseNonNegativeMs(env.PI_REMOTE_SHUTDOWN_GRACE_MS, "PI_REMOTE_SHUTDOWN_GRACE_MS")
        : file.shutdownGraceMs !== undefined
            ? parseNonNegativeMs(file.shutdownGraceMs, "config file")
            : DEFAULT_SHUTDOWN_GRACE_MS;
    const telemetry = env.PI_REMOTE_TELEMETRY
        ? parseBoolean(env.PI_REMOTE_TELEMETRY, "PI_REMOTE_TELEMETRY")
        : (file.telemetry ?? true);
    const httpIdleTimeoutMs = env.PI_REMOTE_HTTP_IDLE_TIMEOUT_MS
        ? parseHttpIdleTimeoutMs(env.PI_REMOTE_HTTP_IDLE_TIMEOUT_MS, "PI_REMOTE_HTTP_IDLE_TIMEOUT_MS")
        : file.httpIdleTimeoutMs !== undefined
            ? parseHttpIdleTimeoutMs(file.httpIdleTimeoutMs, "config file")
            : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
    return {
        host,
        port,
        workspaceRoot,
        agentDir: agentDirRaw ? expandTilde(agentDirRaw) : undefined,
        defaultModel: defaultModelRaw ? parseModelRef(defaultModelRaw) : undefined,
        shutdownGraceMs,
        telemetry,
        httpIdleTimeoutMs,
    };
}
//# sourceMappingURL=config.js.map