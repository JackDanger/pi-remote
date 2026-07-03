interface SessionSummary {
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

interface ModelSnapshot {
  provider: string;
  id: string;
  name?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  details?: { diff?: string; patch?: string };
}

interface AttachState {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: ModelSnapshot;
  thinkingLevel: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

class Rpc {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private backoffMs = 500;
  onPush: (msg: Record<string, unknown>) => void = () => {};
  onStateChange: (online: boolean) => void = () => {};

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/$/, "")}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = 500;
      this.onStateChange(true);
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(String(msg.error)));
        return;
      }
      this.onPush(msg);
    };
    socket.onclose = () => {
      this.onStateChange(false);
      for (const entry of this.pending.values()) {
        entry.reject(new Error("Connection lost"));
      }
      this.pending.clear();
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 8000);
    };
  }

  request<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected"));
    }
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, type, ...params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }
}

const app = document.getElementById("app")!;
const rpc = new Rpc();

interface ChatState {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: ModelSnapshot;
  thinkingLevel: string;
  streaming: boolean;
  openMessageIndex?: number;
  runningTools: Map<string, string>;
}

let view: "list" | "chat" = "list";
let chat: ChatState | undefined;
let models: ModelSnapshot[] = [];
let workspaceRoot = "";
let online = false;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatText(raw: string): string {
  const segments = raw.split("```");
  let html = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    if (i % 2 === 1) {
      html += `<pre><code>${esc(segment.replace(/^\w*\n?/, ""))}</code></pre>`;
    } else {
      html += esc(segment)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    }
  }
  return html;
}

function contentText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const node = el(`<div class="toast">${esc(message)}</div>`);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

function renderShell(headerContent: HTMLElement[], mainClass = ""): { main: HTMLElement; footer: HTMLElement } {
  app.innerHTML = "";
  const header = el(`<header></header>`);
  const conn = el(`<span class="conn ${online ? "online" : ""}"></span>`);
  header.appendChild(conn);
  for (const node of headerContent) header.appendChild(node);
  const main = el(`<main class="${mainClass}"></main>`);
  const footer = el(`<footer style="display:none"></footer>`);
  app.append(header, main, footer);
  return { main, footer };
}

async function showList(): Promise<void> {
  view = "list";
  chat = undefined;
  const title = el(`<h1>pi-remote</h1>`);
  const newBtn = el(`<button class="primary">New session</button>`);
  const { main } = renderShell([title, newBtn]);

  newBtn.onclick = () => {
    if (main.querySelector(".new-session-form")) return;
    const form = el(`
      <div class="new-session-form">
        <input name="workspace" placeholder="workspace directory (default: ${esc(workspaceRoot)})" autocapitalize="off" autocorrect="off" />
        <select name="model">
          <option value="">default model</option>
          ${models.map((m) => `<option value="${esc(`${m.provider}/${m.id}`)}">${esc(m.name ?? m.id)} (${esc(m.provider)})</option>`).join("")}
        </select>
        <button class="primary">Create</button>
      </div>`);
    main.prepend(form);
    (form.querySelector("button") as HTMLButtonElement).onclick = async () => {
      const workspace = (form.querySelector("input[name=workspace]") as HTMLInputElement).value.trim();
      const model = (form.querySelector("select[name=model]") as HTMLSelectElement).value;
      try {
        const { session } = await rpc.request<{ session: SessionSummary }>("sessions.create", {
          ...(workspace ? { workspace } : {}),
          ...(model ? { model } : {}),
        });
        await openChat(session.sessionId);
      } catch (error) {
        toast(String((error as Error).message));
      }
    };
  };

  try {
    const [listResult, modelsResult] = await Promise.all([
      rpc.request<{ sessions: SessionSummary[]; workspaceRoot: string }>("sessions.list"),
      rpc.request<{ models: ModelSnapshot[] }>("models.list"),
    ]);
    models = modelsResult.models;
    workspaceRoot = listResult.workspaceRoot;
    if (listResult.sessions.length === 0) {
      main.appendChild(el(`<div class="empty">No sessions yet. Create one to get started.</div>`));
      return;
    }
    for (const s of listResult.sessions) {
      const card = el(`
        <div class="session-card">
          <div class="info">
            <div class="title">${esc(s.name || s.firstMessage || "(empty session)")}</div>
            <div class="meta">${esc(s.workspace)} · ${esc(new Date(s.modified).toLocaleString())} · ${s.messageCount} msgs</div>
          </div>
          ${s.active ? `<span class="badge active">${s.streaming ? "running" : "live"}</span>` : ""}
          <button class="icon danger" title="Delete session">✕</button>
        </div>`);
      (card.querySelector("button.danger") as HTMLButtonElement).onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this session?")) return;
        if (s.path) {
          try {
            await rpc.request("sessions.delete", { path: s.path });
          } catch (error) {
            toast(String((error as Error).message));
          }
        }
        void showList();
      };
      card.onclick = async () => {
        try {
          if (s.active) {
            await openChat(s.sessionId);
          } else if (s.path) {
            const { session } = await rpc.request<{ session: SessionSummary }>("sessions.resume", { path: s.path });
            await openChat(session.sessionId);
          }
        } catch (error) {
          toast(String((error as Error).message));
        }
      };
      main.appendChild(card);
    }
  } catch (error) {
    main.appendChild(el(`<div class="empty">${esc(String((error as Error).message))}</div>`));
  }
}

async function openChat(sessionId: string): Promise<void> {
  const state = await rpc.request<AttachState>("session.attach", { sessionId });
  view = "chat";
  chat = {
    summary: state.summary,
    messages: state.messages,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    streaming: state.summary.streaming,
    runningTools: new Map(),
  };
  renderChat();
}

function renderChat(): void {
  if (!chat) return;
  const backBtn = el(`<button class="icon">←</button>`);
  const title = el(`<h1>${esc(chat.summary.name || chat.summary.workspace.split("/").pop() || "session")}</h1>`);
  const modelSelect = el(`
    <select title="Model">
      ${models
        .map((m) => {
          const value = `${m.provider}/${m.id}`;
          const selected = chat!.model && chat!.model.provider === m.provider && chat!.model.id === m.id;
          return `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(m.name ?? m.id)}</option>`;
        })
        .join("")}
    </select>`) as HTMLSelectElement;
  const thinkingSelect = el(`
    <select title="Thinking level">
      ${THINKING_LEVELS.map(
        (l) => `<option value="${l}" ${l === chat!.thinkingLevel ? "selected" : ""}>${l === "off" ? "no thinking" : `think: ${l}`}</option>`,
      ).join("")}
    </select>`) as HTMLSelectElement;

  const { main, footer } = renderShell([backBtn, title, modelSelect, thinkingSelect]);
  main.id = "chat-log";

  backBtn.onclick = () => {
    if (chat) void rpc.request("session.detach", { sessionId: chat.summary.sessionId }).catch(() => {});
    void showList();
  };

  modelSelect.onchange = async () => {
    if (!chat) return;
    const [provider, ...rest] = modelSelect.value.split("/");
    try {
      const { model } = await rpc.request<{ model?: ModelSnapshot }>("session.set_model", {
        sessionId: chat.summary.sessionId,
        provider,
        modelId: rest.join("/"),
      });
      chat.model = model;
    } catch (error) {
      toast(String((error as Error).message));
    }
  };

  thinkingSelect.onchange = async () => {
    if (!chat) return;
    try {
      const { thinkingLevel } = await rpc.request<{ thinkingLevel: string }>("session.set_thinking", {
        sessionId: chat.summary.sessionId,
        level: thinkingSelect.value,
      });
      chat.thinkingLevel = thinkingLevel;
      thinkingSelect.value = thinkingLevel;
    } catch (error) {
      toast(String((error as Error).message));
    }
  };

  footer.style.display = "flex";
  const textarea = el(`<textarea placeholder="Message the agent…" rows="1"></textarea>`) as HTMLTextAreaElement;
  const sendBtn = el(`<button class="primary">Send</button>`) as HTMLButtonElement;
  const stopBtn = el(`<button class="danger" style="display:none">Stop</button>`) as HTMLButtonElement;
  footer.append(textarea, stopBtn, sendBtn);

  const send = async () => {
    if (!chat) return;
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    appendMessage({ role: "user", content: text }, { optimistic: true });
    try {
      await rpc.request("session.prompt", { sessionId: chat.summary.sessionId, text });
    } catch (error) {
      toast(String((error as Error).message));
    }
  };

  sendBtn.onclick = () => void send();
  textarea.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !isTouchDevice()) {
      ev.preventDefault();
      void send();
    }
  };

  stopBtn.onclick = () => {
    if (!chat) return;
    void rpc.request("session.abort", { sessionId: chat.summary.sessionId }).catch((e: Error) => toast(e.message));
  };

  for (const message of chat.messages) {
    appendMessage(message, { skipScroll: true });
  }
  updateStreamingUi();
  main.scrollTop = main.scrollHeight;
}

function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

function updateStreamingUi(): void {
  const stopBtn = document.querySelector("footer button.danger") as HTMLButtonElement | null;
  const sendBtn = document.querySelector("footer button.primary") as HTMLButtonElement | null;
  const textarea = document.querySelector("footer textarea") as HTMLTextAreaElement | null;
  if (!chat || !stopBtn || !sendBtn || !textarea) return;
  stopBtn.style.display = chat.streaming ? "" : "none";
  sendBtn.textContent = chat.streaming ? "Steer" : "Send";
  textarea.placeholder = chat.streaming ? "Steer the agent…" : "Message the agent…";
}

function messageNode(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return el(`<div class="msg user">${formatText(contentText(message.content))}</div>`);
  }
  if (message.role === "toolResult") {
    const text = contentText(message.content);
    const diff = message.details?.diff ?? message.details?.patch;
    const body = diff ? `<pre><code>${esc(diff)}</code></pre>` : text ? `<pre><code>${esc(text.slice(0, 8000))}</code></pre>` : "<em>(no output)</em>";
    return el(`
      <details class="block ${message.isError ? "tool-error" : ""}">
        <summary><span class="tool-name">${esc(message.toolName ?? "tool")}</span> ${message.isError ? "failed" : "result"}</summary>
        <div class="body">${body}</div>
      </details>`);
  }
  if (message.role === "assistant") {
    const node = el(`<div class="msg assistant"></div>`);
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        node.appendChild(el(`<div class="text">${formatText(block.text)}</div>`));
      } else if (block.type === "thinking" && block.thinking) {
        node.appendChild(
          el(`<details class="block"><summary>thinking</summary><div class="body">${formatText(block.thinking)}</div></details>`),
        );
      } else if (block.type === "toolCall") {
        const args = block.arguments ? JSON.stringify(block.arguments) : "";
        node.appendChild(
          el(`
            <details class="block">
              <summary><span class="tool-name">${esc(block.name ?? "tool")}</span> ${esc(truncate(args, 80))}</summary>
              <div class="body"><pre><code>${esc(JSON.stringify(block.arguments ?? {}, null, 2))}</code></pre></div>
            </details>`),
        );
      }
    }
    if (message.errorMessage) {
      node.appendChild(el(`<div class="error-note">${esc(message.errorMessage)}</div>`));
    }
    return node;
  }
  const fallbackText = contentText(message.content);
  return el(`<div class="msg">${fallbackText ? formatText(fallbackText) : ""}</div>`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface AppendOptions {
  optimistic?: boolean;
  skipScroll?: boolean;
}

function appendMessage(message: ChatMessage, options: AppendOptions = {}): void {
  const main = document.getElementById("chat-log");
  if (!main || !chat) return;
  const node = messageNode(message);
  node.dataset.optimistic = options.optimistic ? "1" : "";
  main.appendChild(node);
  if (!options.skipScroll) scrollToBottom(main);
}

function scrollToBottom(main: HTMLElement): void {
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 240;
  if (nearBottom) main.scrollTop = main.scrollHeight;
}

function replaceLastMessageNode(message: ChatMessage): void {
  const main = document.getElementById("chat-log");
  if (!main) return;
  const last = main.lastElementChild;
  const node = messageNode(message);
  if (last && !(last as HTMLElement).classList.contains("spinner-row")) {
    last.replaceWith(node);
  } else {
    main.appendChild(node);
  }
  scrollToBottom(main);
}

function handleSessionEvent(sessionId: string, event: Record<string, unknown>): void {
  if (!chat || view !== "chat" || chat.summary.sessionId !== sessionId) return;
  const main = document.getElementById("chat-log");
  if (!main) return;
  switch (event.type) {
    case "agent_start":
      chat.streaming = true;
      updateStreamingUi();
      break;
    case "agent_end":
      chat.streaming = false;
      chat.runningTools.clear();
      for (const row of main.querySelectorAll(".spinner-row")) row.remove();
      updateStreamingUi();
      void resyncChat(sessionId);
      break;
    case "message_start": {
      const message = event.message as ChatMessage;
      const lastNode = main.lastElementChild as HTMLElement | null;
      if (message.role === "user" && lastNode?.dataset.optimistic === "1") {
        lastNode.remove();
      }
      chat.messages.push(message);
      appendMessage(message);
      break;
    }
    case "message_update":
      chat.messages[chat.messages.length - 1] = event.message as ChatMessage;
      replaceLastMessageNode(event.message as ChatMessage);
      break;
    case "message_end":
      chat.messages[chat.messages.length - 1] = event.message as ChatMessage;
      replaceLastMessageNode(event.message as ChatMessage);
      break;
    case "tool_execution_start": {
      const row = el(
        `<div class="spinner-row" data-tool="${esc(String(event.toolCallId))}">running <span class="tool-name">${esc(String(event.toolName))}</span>…</div>`,
      );
      main.appendChild(row);
      scrollToBottom(main);
      break;
    }
    case "tool_execution_end":
      main.querySelector(`.spinner-row[data-tool="${CSS.escape(String(event.toolCallId))}"]`)?.remove();
      break;
    default:
      break;
  }
}

async function resyncChat(sessionId: string): Promise<void> {
  if (!chat || chat.summary.sessionId !== sessionId) return;
  try {
    const state = await rpc.request<AttachState>("session.attach", { sessionId });
    if (!chat || view !== "chat" || chat.summary.sessionId !== sessionId) return;
    chat.summary = state.summary;
    chat.messages = state.messages;
    chat.model = state.model;
    chat.thinkingLevel = state.thinkingLevel;
    chat.streaming = state.summary.streaming;
    renderChat();
  } catch {
    return;
  }
}

rpc.onPush = (msg) => {
  if (msg.type === "session_event") {
    handleSessionEvent(String(msg.sessionId), msg.event as Record<string, unknown>);
  } else if (msg.type === "session_error") {
    toast(String(msg.error));
    if (chat) {
      chat.streaming = false;
      updateStreamingUi();
    }
  }
};

rpc.onStateChange = (isOnline) => {
  online = isOnline;
  document.querySelector(".conn")?.classList.toggle("online", isOnline);
  if (isOnline) {
    if (view === "chat" && chat) {
      void resyncChat(chat.summary.sessionId);
    } else {
      void showList();
    }
  }
};

rpc.connect();
void showList();
