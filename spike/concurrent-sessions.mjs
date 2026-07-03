import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const agentDir = getAgentDir();
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

async function makeSession(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd),
  });
  return session;
}

const wsA = path.join(os.tmpdir(), "pi-spike-a");
const wsB = path.join(os.tmpdir(), "pi-spike-b");
fs.writeFileSync(path.join(wsA, "..", ".keep"), "");
fs.mkdirSync(wsA, { recursive: true });
fs.mkdirSync(wsB, { recursive: true });
fs.writeFileSync(path.join(wsA, "marker-alpha.txt"), "alpha workspace\n");
fs.writeFileSync(path.join(wsB, "marker-beta.txt"), "beta workspace\n");

const a = await makeSession(wsA);
const b = await makeSession(wsB);

for (const s of [a, b]) {
  if (!s.model || s.model.provider === "unknown") {
    const fallback = s.modelRegistry.getAvailable()[0];
    if (fallback) await s.setModel(fallback);
  }
}

console.log("A model:", a.model?.provider, a.model?.id, "sessionFile:", a.sessionFile);
console.log("B model:", b.model?.provider, b.model?.id, "sessionFile:", b.sessionFile);
console.log("available models:", modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));

const toolCalls = { a: [], b: [] };
a.subscribe((e) => {
  if (e.type === "tool_execution_start") toolCalls.a.push(`${e.toolName}(${JSON.stringify(e.args)})`);
});
b.subscribe((e) => {
  if (e.type === "tool_execution_start") toolCalls.b.push(`${e.toolName}(${JSON.stringify(e.args)})`);
});

await Promise.all([
  a.prompt("Run `ls` in the current directory with the bash tool and tell me the marker file name."),
  b.prompt("Run `ls` in the current directory with the bash tool and tell me the marker file name."),
]);

console.log("A tools:", toolCalls.a);
console.log("B tools:", toolCalls.b);
console.log("A last:", a.getLastAssistantText());
console.log("B last:", b.getLastAssistantText());

a.dispose();
b.dispose();
process.exit(0);
