import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:3441/ws";

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const pushes = [];
    ws.on("open", () =>
      resolve({
        ws,
        pushes,
        request(type, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, type, ...params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
      }),
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.ok ? p.res(msg.result) : p.rej(new Error(msg.error));
      } else {
        pushes.push(msg);
      }
    });
    ws.on("error", reject);
  });
}

const clientA = await connect();
const clientB = await connect();

const models = await clientA.request("models.list");
console.log("models:", models.models.map((m) => `${m.provider}/${m.id}`).join(", "));

const { session } = await clientA.request("sessions.create", { workspace: "e2e-demo" });
console.log("created:", session.sessionId, "workspace:", session.workspace, "path:", session.path);

const stateA = await clientA.request("session.attach", { sessionId: session.sessionId });
const stateB = await clientB.request("session.attach", { sessionId: session.sessionId });
console.log("attached A+B, model:", stateA.summary ? JSON.stringify(stateA.model) : "?", "messages:", stateA.messages.length, stateB.messages.length);

await clientA.request("session.prompt", {
  sessionId: session.sessionId,
  text: "Use the write tool to create a file named proof.txt containing exactly 'pi-remote e2e'. Then run `ls -la` with bash and tell me what you see.",
});

const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const done = clientA.pushes.some((p) => p.type === "session_event" && p.event?.type === "agent_end");
  if (done) break;
  await new Promise((r) => setTimeout(r, 300));
}

function summarizeEvents(pushes, label) {
  const counts = {};
  const tools = [];
  for (const p of pushes) {
    if (p.type !== "session_event") continue;
    counts[p.event.type] = (counts[p.event.type] ?? 0) + 1;
    if (p.event.type === "tool_execution_start") tools.push(`${p.event.toolName}(${JSON.stringify(p.event.args)})`);
  }
  console.log(`${label} event counts:`, JSON.stringify(counts));
  console.log(`${label} tool calls:`, tools);
}

summarizeEvents(clientA.pushes, "clientA");
summarizeEvents(clientB.pushes, "clientB");

const finalState = await clientA.request("session.attach", { sessionId: session.sessionId });
const lastAssistant = [...finalState.messages].reverse().find((m) => m.role === "assistant");
const text = (lastAssistant?.content ?? [])
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");
console.log("final assistant text:", text.slice(0, 400));

const list = await clientA.request("sessions.list");
console.log(
  "sessions.list:",
  list.sessions.slice(0, 3).map((s) => `${s.sessionId.slice(0, 8)} active=${s.active} ws=${s.workspace}`),
);

clientA.ws.close();
clientB.ws.close();
