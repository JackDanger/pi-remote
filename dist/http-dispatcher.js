import { configureHttpDispatcher } from "@earendil-works/pi-coding-agent";
export function applyHttpIdleTimeout(timeoutMs, configure = configureHttpDispatcher) {
    configure(timeoutMs);
}
export function formatHttpIdleTimeout(timeoutMs) {
    return timeoutMs === 0 ? "disabled" : `${timeoutMs}ms`;
}
//# sourceMappingURL=http-dispatcher.js.map