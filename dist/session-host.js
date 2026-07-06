export class SessionNotFoundError extends Error {
    constructor(sessionId) {
        super(`No live session "${sessionId}" — attach after sessions.create or sessions.resume`);
    }
}
export class ServerDrainingError extends Error {
    constructor() {
        super("Server is shutting down — not accepting new work");
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class SessionHost {
    deps;
    observer;
    live = new Map();
    draining = false;
    constructor(deps, observer) {
        this.deps = deps;
        this.observer = observer;
    }
    get isDraining() {
        return this.draining;
    }
    streamingSessionIds() {
        return [...this.live.entries()].filter(([, entry]) => entry.session.isStreaming).map(([id]) => id);
    }
    async drain(deadlineMs, pollIntervalMs = 250) {
        this.draining = true;
        const pending = new Set(this.streamingSessionIds());
        const drained = [];
        const deadline = Date.now() + deadlineMs;
        while (pending.size > 0) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
                break;
            await sleep(Math.min(pollIntervalMs, remainingMs));
            for (const id of [...pending]) {
                const entry = this.live.get(id);
                if (!entry || !entry.session.isStreaming) {
                    pending.delete(id);
                    drained.push(id);
                }
            }
        }
        return { drained, forced: [...pending] };
    }
    async createSession(workspace, model) {
        this.rejectNewWorkWhileDraining();
        const opened = await this.deps.factory({ workspace, model });
        return this.adopt(opened);
    }
    async resumeSession(path) {
        this.rejectNewWorkWhileDraining();
        for (const entry of this.live.values()) {
            if (entry.session.sessionFile === path) {
                return this.summarizeLive(entry);
            }
        }
        const opened = await this.deps.factory({ sessionPath: path });
        return this.adopt(opened);
    }
    async listSessions() {
        const persisted = await this.deps.listPersisted();
        const byPath = new Map();
        for (const info of persisted) {
            byPath.set(info.path, {
                sessionId: info.id,
                path: info.path,
                name: info.name,
                workspace: info.cwd,
                active: false,
                streaming: false,
                modified: info.modified.toISOString(),
                messageCount: info.messageCount,
                firstMessage: info.firstMessage,
            });
        }
        for (const entry of this.live.values()) {
            const summary = this.summarizeLive(entry);
            if (summary.path)
                byPath.set(summary.path, summary);
            else
                byPath.set(`live:${summary.sessionId}`, summary);
        }
        return [...byPath.values()].sort((a, b) => b.modified.localeCompare(a.modified));
    }
    async deleteSession(path) {
        for (const [id, entry] of this.live) {
            if (entry.session.sessionFile === path) {
                this.dropLive(id, entry);
            }
        }
        await this.deps.deletePersisted(path);
    }
    attach(sessionId, client) {
        const entry = this.mustGetLive(sessionId);
        entry.clients.add(client);
        return {
            summary: this.summarizeLive(entry),
            messages: entry.session.messages,
            model: toModelSnapshot(entry.session.model),
            thinkingLevel: entry.session.thinkingLevel,
        };
    }
    detach(sessionId, client) {
        this.live.get(sessionId)?.clients.delete(client);
    }
    detachEverywhere(client) {
        for (const entry of this.live.values()) {
            entry.clients.delete(client);
        }
    }
    pushToAttached(sessionId, payload) {
        const entry = this.live.get(sessionId);
        if (!entry)
            return;
        for (const client of entry.clients) {
            client.send(payload);
        }
    }
    prompt(sessionId, text, images) {
        this.rejectNewWorkWhileDraining();
        const entry = this.mustGetLive(sessionId);
        const steering = entry.session.isStreaming;
        this.observer?.promptSent(sessionId, steering ? "steer" : "prompt", formatModel(entry.session.model));
        const run = steering
            ? entry.session.steer(text, images)
            : entry.session.prompt(text, images?.length ? { images } : undefined);
        run.catch((error) => this.broadcastError(sessionId, error));
    }
    steer(sessionId, text, images) {
        this.rejectNewWorkWhileDraining();
        const entry = this.mustGetLive(sessionId);
        this.observer?.promptSent(sessionId, "steer", formatModel(entry.session.model));
        entry.session.steer(text, images).catch((error) => this.broadcastError(sessionId, error));
    }
    followUp(sessionId, text, images) {
        this.rejectNewWorkWhileDraining();
        const entry = this.mustGetLive(sessionId);
        this.observer?.promptSent(sessionId, "followup", formatModel(entry.session.model));
        entry.session.followUp(text, images).catch((error) => this.broadcastError(sessionId, error));
    }
    async abort(sessionId) {
        await this.mustGetLive(sessionId).session.abort();
    }
    compact(sessionId, instructions) {
        this.rejectNewWorkWhileDraining();
        const entry = this.mustGetLive(sessionId);
        entry.session.compact(instructions).catch((error) => this.broadcastError(sessionId, error));
    }
    abortCompaction(sessionId) {
        this.mustGetLive(sessionId).session.abortCompaction();
    }
    async setModel(sessionId, provider, modelId) {
        const entry = this.mustGetLive(sessionId);
        const before = formatModel(entry.session.model);
        await this.deps.setSessionModel(entry.session, provider, modelId);
        const after = formatModel(entry.session.model);
        if (after !== before)
            this.observer?.modelSwitched(sessionId, before, after);
        return toModelSnapshot(entry.session.model);
    }
    setThinkingLevel(sessionId, level) {
        const entry = this.mustGetLive(sessionId);
        entry.session.setThinkingLevel(level);
        return entry.session.thinkingLevel;
    }
    rename(sessionId, name) {
        const entry = this.mustGetLive(sessionId);
        entry.session.setSessionName(name);
        return entry.session.sessionName ?? name;
    }
    liveSessionIds() {
        return [...this.live.keys()];
    }
    disposeAll() {
        for (const [id, entry] of this.live) {
            this.dropLive(id, entry);
        }
    }
    adopt(opened) {
        const { session, workspace } = opened;
        const existing = this.live.get(session.sessionId);
        if (existing)
            return this.summarizeLive(existing);
        const entry = {
            session,
            workspace,
            clients: new Set(),
            unsubscribe: () => { },
        };
        entry.unsubscribe = session.subscribe((event) => {
            this.observer?.sessionEvent(session.sessionId, event);
            const payload = { type: "session_event", sessionId: session.sessionId, event };
            for (const client of entry.clients) {
                client.send(payload);
            }
        });
        this.live.set(session.sessionId, entry);
        return this.summarizeLive(entry);
    }
    dropLive(id, entry) {
        entry.unsubscribe();
        entry.session.dispose();
        entry.clients.clear();
        this.live.delete(id);
    }
    rejectNewWorkWhileDraining() {
        if (this.draining)
            throw new ServerDrainingError();
    }
    mustGetLive(sessionId) {
        const entry = this.live.get(sessionId);
        if (!entry)
            throw new SessionNotFoundError(sessionId);
        return entry;
    }
    summarizeLive(entry) {
        const { session } = entry;
        const messages = session.messages;
        const firstUser = messages.find((m) => typeof m === "object" && m !== null && m.role === "user");
        return {
            sessionId: session.sessionId,
            path: session.sessionFile,
            name: session.sessionName ?? undefined,
            workspace: entry.workspace,
            active: true,
            streaming: session.isStreaming,
            modified: new Date().toISOString(),
            messageCount: messages.length,
            firstMessage: extractText(firstUser?.content),
        };
    }
    broadcastError(sessionId, error) {
        const entry = this.live.get(sessionId);
        if (!entry)
            return;
        const payload = {
            type: "session_error",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
        };
        for (const client of entry.clients) {
            client.send(payload);
        }
    }
}
function formatModel(model) {
    return model ? `${model.provider}/${model.id}` : "unknown";
}
function toModelSnapshot(model) {
    return model
        ? { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning }
        : undefined;
}
function extractText(content) {
    if (typeof content === "string")
        return content.slice(0, 200);
    if (Array.isArray(content)) {
        const texts = content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text);
        return texts.join(" ").slice(0, 200);
    }
    return "";
}
//# sourceMappingURL=session-host.js.map