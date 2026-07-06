import type { SessionObserver } from "./telemetry.js";
export interface ModelSnapshot {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
}
export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export interface HostableSession {
    sessionId: string;
    sessionFile: string | undefined;
    sessionName?: string | undefined;
    model: {
        provider: string;
        id: string;
        name?: string;
    } | undefined;
    thinkingLevel: string;
    isStreaming: boolean;
    messages: unknown[];
    subscribe(listener: (event: unknown) => void): () => void;
    prompt(text: string, options?: {
        images?: ImageContent[];
    }): Promise<void>;
    steer(text: string, images?: ImageContent[]): Promise<void>;
    followUp(text: string, images?: ImageContent[]): Promise<void>;
    abort(): Promise<void>;
    compact(instructions?: string): Promise<unknown>;
    abortCompaction(): void;
    setThinkingLevel(level: never): void;
    setSessionName(name: string): void;
    dispose(): void;
}
export interface SessionOpenRequest {
    workspace?: string;
    sessionPath?: string;
    model?: string;
}
export interface OpenedSession {
    session: HostableSession;
    workspace: string;
}
export type SessionFactory = (request: SessionOpenRequest) => Promise<OpenedSession>;
export interface PersistedSessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    modified: Date;
    messageCount: number;
    firstMessage: string;
}
export interface SessionHostDeps {
    factory: SessionFactory;
    listPersisted: () => Promise<PersistedSessionInfo[]>;
    deletePersisted: (path: string) => Promise<void>;
    setSessionModel: (session: HostableSession, provider: string, modelId: string) => Promise<void>;
}
export interface AttachedClient {
    send(payload: unknown): void;
}
export interface SessionSummary {
    sessionId: string;
    path?: string;
    name?: string;
    workspace: string;
    active: boolean;
    streaming: boolean;
    modified: string;
    messageCount: number;
    firstMessage: string;
}
export interface AttachState {
    summary: SessionSummary;
    messages: unknown[];
    model?: ModelSnapshot;
    thinkingLevel: string;
}
export declare class SessionNotFoundError extends Error {
    constructor(sessionId: string);
}
export declare class ServerDrainingError extends Error {
    constructor();
}
export interface DrainResult {
    drained: string[];
    forced: string[];
}
export declare class SessionHost {
    private readonly deps;
    private readonly observer?;
    private readonly live;
    private draining;
    constructor(deps: SessionHostDeps, observer?: SessionObserver | undefined);
    get isDraining(): boolean;
    streamingSessionIds(): string[];
    drain(deadlineMs: number, pollIntervalMs?: number): Promise<DrainResult>;
    createSession(workspace: string | undefined, model: string | undefined): Promise<SessionSummary>;
    resumeSession(path: string): Promise<SessionSummary>;
    listSessions(): Promise<SessionSummary[]>;
    deleteSession(path: string): Promise<void>;
    attach(sessionId: string, client: AttachedClient): AttachState;
    detach(sessionId: string, client: AttachedClient): void;
    detachEverywhere(client: AttachedClient): void;
    pushToAttached(sessionId: string, payload: unknown): void;
    prompt(sessionId: string, text: string, images?: ImageContent[]): void;
    steer(sessionId: string, text: string, images?: ImageContent[]): void;
    followUp(sessionId: string, text: string, images?: ImageContent[]): void;
    abort(sessionId: string): Promise<void>;
    compact(sessionId: string, instructions?: string): void;
    abortCompaction(sessionId: string): void;
    setModel(sessionId: string, provider: string, modelId: string): Promise<ModelSnapshot | undefined>;
    setThinkingLevel(sessionId: string, level: string): string;
    rename(sessionId: string, name: string): string;
    liveSessionIds(): string[];
    disposeAll(): void;
    private adopt;
    private dropLive;
    private rejectNewWorkWhileDraining;
    private mustGetLive;
    private summarizeLive;
    private broadcastError;
}
