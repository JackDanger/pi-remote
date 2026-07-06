import fs from "node:fs";
import path from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager, } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./config.js";
export function createPiEnvironment(config) {
    const agentDir = config.agentDir ?? getAgentDir();
    const authStorage = config.agentDir
        ? AuthStorage.create(path.join(agentDir, "auth.json"))
        : AuthStorage.create();
    const modelRegistry = config.agentDir
        ? ModelRegistry.create(authStorage, path.join(agentDir, "models.json"))
        : ModelRegistry.create(authStorage);
    const resolveWorkspace = (workspace) => {
        if (!workspace) {
            return path.join(config.workspaceRoot, `session-${new Date().toISOString().slice(0, 10)}`);
        }
        if (path.isAbsolute(workspace))
            return workspace;
        return path.join(config.workspaceRoot, workspace);
    };
    const ensureModel = async (session, requested) => {
        if (requested) {
            const model = modelRegistry.find(requested.provider, requested.modelId);
            if (!model) {
                throw new Error(`Model ${requested.provider}/${requested.modelId} not found in registry`);
            }
            await session.setModel(model);
            return;
        }
        if (session.model && session.model.provider !== "unknown")
            return;
        const preferred = config.defaultModel
            ? modelRegistry.find(config.defaultModel.provider, config.defaultModel.modelId)
            : undefined;
        const fallback = preferred ?? modelRegistry.getAvailable()[0];
        if (fallback)
            await session.setModel(fallback);
    };
    const openSession = async (request) => {
        let sessionManager;
        let workspace;
        if (request.sessionPath) {
            sessionManager = SessionManager.open(request.sessionPath);
            workspace = sessionManager.getCwd() || config.workspaceRoot;
        }
        else {
            workspace = resolveWorkspace(request.workspace);
            fs.mkdirSync(workspace, { recursive: true });
            sessionManager = SessionManager.create(workspace);
        }
        const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
            cwd: workspace,
            agentDir,
            authStorage,
            modelRegistry,
            resourceLoader,
            sessionManager,
        });
        await ensureModel(session, request.model ? parseModelRef(request.model) : undefined);
        return { session: session, workspace };
    };
    const sessionsDir = path.join(agentDir, "sessions");
    const listPersisted = async () => {
        if (!fs.existsSync(sessionsDir))
            return [];
        const projectDirs = fs
            .readdirSync(sessionsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(sessionsDir, entry.name));
        const perProject = await Promise.all(projectDirs.map((dir) => SessionManager.listAll(dir)));
        return perProject.flat().map((info) => ({
            path: info.path,
            id: info.id,
            cwd: info.cwd,
            name: info.name,
            modified: info.modified,
            messageCount: info.messageCount,
            firstMessage: info.firstMessage,
        }));
    };
    const deletePersisted = async (sessionPath) => {
        const resolved = path.resolve(sessionPath);
        if (!resolved.startsWith(path.resolve(sessionsDir) + path.sep)) {
            throw new Error(`Refusing to delete "${sessionPath}" outside the session directory`);
        }
        await fs.promises.rm(resolved, { force: true });
    };
    const setSessionModel = async (session, provider, modelId) => {
        const model = modelRegistry.find(provider, modelId);
        if (!model)
            throw new Error(`Model ${provider}/${modelId} not found in registry`);
        await session.setModel(model);
    };
    const listModels = () => modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning }));
    const warmup = async () => {
        fs.mkdirSync(config.workspaceRoot, { recursive: true });
        const resourceLoader = new DefaultResourceLoader({ cwd: config.workspaceRoot, agentDir });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
            cwd: config.workspaceRoot,
            agentDir,
            authStorage,
            modelRegistry,
            resourceLoader,
            sessionManager: SessionManager.inMemory(config.workspaceRoot),
        });
        session.dispose();
    };
    return {
        hostDeps: { factory: openSession, listPersisted, deletePersisted, setSessionModel },
        listModels,
        workspaceRoot: config.workspaceRoot,
        warmup,
    };
}
//# sourceMappingURL=pi.js.map