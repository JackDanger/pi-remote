import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const DISPATCHER_RELATIVE_PATH = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js");
export function resolveHttpDispatcherModulePath() {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = path.join(dir, DISPATCHER_RELATIVE_PATH);
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`Could not locate ${DISPATCHER_RELATIVE_PATH} in any parent directory of ${import.meta.url}`);
        }
        dir = parent;
    }
}
export async function loadHttpDispatcherModule() {
    const moduleUrl = pathToFileURL(resolveHttpDispatcherModulePath()).href;
    return (await import(moduleUrl));
}
export async function applyHttpIdleTimeout(timeoutMs, load = loadHttpDispatcherModule) {
    const dispatcherModule = await load();
    dispatcherModule.configureHttpDispatcher(timeoutMs);
}
export function formatHttpIdleTimeout(timeoutMs) {
    return timeoutMs === 0 ? "disabled" : `${timeoutMs}ms`;
}
//# sourceMappingURL=http-dispatcher.js.map