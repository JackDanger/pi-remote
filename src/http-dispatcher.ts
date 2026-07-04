import { configureHttpDispatcher } from "@earendil-works/pi-coding-agent";

export type ConfigureHttpDispatcher = (timeoutMs?: number) => void;

export function applyHttpIdleTimeout(
  timeoutMs: number,
  configure: ConfigureHttpDispatcher = configureHttpDispatcher,
): void {
  configure(timeoutMs);
}

export function formatHttpIdleTimeout(timeoutMs: number): string {
  return timeoutMs === 0 ? "disabled" : `${timeoutMs}ms`;
}
