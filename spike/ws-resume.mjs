import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:3441/ws";

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();
const pushes = [];
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
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
const request = (type, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, type, ...params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

const { models } = await request("models.list");
console.log("models after warmup:", models.map((m) => `${m.provider}/${m.id}`));

const { sessions } = await request("sessions.list");
const target = sessions.find((s) => s.workspace === "/tmp/pi-remote-e2e/e2e-demo");
console.log("found persisted session:", target?.sessionId, "active:", target?.active, "msgs:", target?.messageCount);

const { session } = await request("sessions.resume", { path: target.path });
const state = await request("session.attach", { sessionId: session.sessionId });
console.log("resumed, history messages:", state.messages.length, "model:", JSON.stringify(state.model));

await request("session.prompt", {
  sessionId: session.sessionId,
  text: "Without using any tools: what was the exact content you wrote into proof.txt earlier?",
});
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (pushes.some((p) => p.event?.type === "agent_end")) break;
  await new Promise((r) => setTimeout(r, 300));
}
const final = await request("session.attach", { sessionId: session.sessionId });
const last = [...final.messages].reverse().find((m) => m.role === "assistant");
console.log(
  "recall answer:",
  (last?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .slice(0, 200),
);
ws.close();
