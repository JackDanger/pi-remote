import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface Config {
  host: string;
  port: number;
  workspaceRoot: string;
  agentDir?: string;
  defaultModel?: ModelRef;
}

export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid model reference "${value}" (expected "provider/model-id")`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

interface ConfigFile {
  host?: string;
  port?: number;
  workspaceRoot?: string;
  agentDir?: string;
  defaultModel?: string;
}

function readConfigFile(filePath: string): ConfigFile {
  if (!fs.existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file ${filePath} must contain a JSON object`);
  }
  return parsed as ConfigFile;
}

function parsePort(value: string | number, source: string): number {
  const port = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}" from ${source}`);
  }
  return port;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_REMOTE_CONFIG ?? path.join(os.homedir(), ".config", "pi-remote", "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigFile(defaultConfigPath(env));
  const host = env.PI_REMOTE_HOST ?? file.host ?? "127.0.0.1";
  const port = env.PI_REMOTE_PORT
    ? parsePort(env.PI_REMOTE_PORT, "PI_REMOTE_PORT")
    : file.port !== undefined
      ? parsePort(file.port, "config file")
      : 3141;
  const workspaceRoot = expandTilde(
    env.PI_REMOTE_WORKSPACE_ROOT ?? file.workspaceRoot ?? path.join(os.homedir(), "pi-workspaces"),
  );
  const agentDirRaw = env.PI_REMOTE_AGENT_DIR ?? file.agentDir;
  const defaultModelRaw = env.PI_REMOTE_DEFAULT_MODEL ?? file.defaultModel;
  return {
    host,
    port,
    workspaceRoot,
    agentDir: agentDirRaw ? expandTilde(agentDirRaw) : undefined,
    defaultModel: defaultModelRaw ? parseModelRef(defaultModelRaw) : undefined,
  };
}
