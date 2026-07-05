import { gateCompact, parseCompactCommand } from "./compact-command.js";
import {
  COMPACTING_LABEL,
  classifyCompactionEnd,
  compactingElapsed,
  compactionApplied,
  compactionResultTitle,
  type CompactionEndEvent,
} from "./compaction-view.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { ConnectionLostError, Rpc, type ConnState, type SocketLike } from "./rpc.js";
import {
  activityForAssistantEvent,
  finishedTurnStats,
  formatDuration,
  liveTurnStats,
  statusLabel,
  type TelemetrySnapshot,
  type TurnActivity,
} from "./turn-stats.js";

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
  reasoning?: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
}

interface ChatMessage {
  role: string;
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  details?: Record<string, unknown>;
  command?: string;
  output?: string;
  customType?: string;
  display?: boolean;
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface AttachState {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: ModelSnapshot;
  thinkingLevel: string;
  telemetry?: TelemetrySnapshot;
}

interface ImageAttachment {
  data: string;
  mimeType: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const OUTPUT_PREVIEW_CHARS = 3000;
const MAX_IMAGE_DIMENSION = 1568;

interface ChatState {
  summary: SessionSummary;
  messages: ChatMessage[];
  model?: ModelSnapshot;
  thinkingLevel: string;
  streaming: boolean;
  compacting: boolean;
  compactionStartedAt?: number;
  deliverMode: "steer" | "followup";
  attachments: ImageAttachment[];
  queuedNotes: string[];
  telemetry?: TelemetrySnapshot;
  telemetryReceivedAt: number;
  activity: TurnActivity;
  turnStartedAt?: number;
}

const rpc = new Rpc(() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/$/, "")}/ws`) as unknown as SocketLike;
});
let view: "list" | "chat" = "list";
let unconfirmedOutbound: { sessionId: string; text: string; startsTurn: boolean } | undefined;
let chat: ChatState | undefined;
let models: ModelSnapshot[] = [];
let workspaceRoot = "";
let connState: ConnState = "connecting";
let stickToBottom = true;
let listRefreshQueued = false;

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

const ui = buildShell();

function buildShell() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <header>
      <div class="header-row" id="header-row"></div>
    </header>
    <div class="conn-banner" id="conn-banner" hidden>Reconnecting…</div>
    <main id="main"></main>
    <button class="jump-pill" id="jump-pill" hidden aria-label="Jump to latest">↓ Latest</button>
    <footer id="footer" hidden></footer>
    <div class="sheet-host" id="sheet-host" hidden></div>
  `;
  return {
    app,
    headerRow: app.querySelector("#header-row") as HTMLElement,
    connBanner: app.querySelector("#conn-banner") as HTMLElement,
    main: app.querySelector("#main") as HTMLElement,
    jumpPill: app.querySelector("#jump-pill") as HTMLButtonElement,
    footer: app.querySelector("#footer") as HTMLElement,
    sheetHost: app.querySelector("#sheet-host") as HTMLElement,
  };
}

function toast(message: string, kind: "error" | "info" = "error"): void {
  document.querySelector(".toast")?.remove();
  const node = el(`<div class="toast ${kind}">${escapeHtml(message)}</div>`);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), kind === "error" ? 5000 : 2500);
}

function openSheet(build: (body: HTMLElement, close: () => void) => void): void {
  const host = ui.sheetHost;
  host.hidden = false;
  host.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet"><div class="sheet-grip"></div><div class="sheet-body"></div></div>`;
  const close = (): void => {
    host.hidden = true;
    host.innerHTML = "";
  };
  (host.querySelector(".sheet-backdrop") as HTMLElement).onclick = close;
  build(host.querySelector(".sheet-body") as HTMLElement, close);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function contentText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
}

function contentImages(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === "image" && b.data);
}

function modelLabel(model: ModelSnapshot | undefined): string {
  if (!model) return "model";
  const label = model.name ?? model.id;
  return label.length > 20 ? `${label.slice(0, 19)}…` : label;
}

function modelChipLabel(): string {
  if (!chat) return "model";
  const label = modelLabel(chat.model);
  return chat.thinkingLevel && chat.thinkingLevel !== "off" ? `${label} · ${chat.thinkingLevel}` : label;
}

function updateModelChip(): void {
  const chip = document.getElementById("model-chip");
  if (chip) chip.textContent = modelChipLabel();
}

function setConnState(state: ConnState): void {
  connState = state;
  ui.connBanner.hidden = state === "online";
  ui.connBanner.textContent = state === "connecting" ? "Connecting…" : "Offline — reconnecting…";
  document.querySelector(".conn")?.classList.toggle("online", state === "online");
}

async function refreshModels(): Promise<void> {
  const result = await rpc.request<{ models: ModelSnapshot[] }>("models.list");
  models = result.models;
}

function showList(): void {
  view = "list";
  chat = undefined;
  ui.footer.hidden = true;
  ui.jumpPill.hidden = true;
  ui.headerRow.innerHTML = "";
  const conn = el(`<span class="conn ${connState === "online" ? "online" : ""}"></span>`);
  const title = el(`<h1>pi-remote</h1>`);
  const newBtn = el(`<button class="primary" id="new-session">New</button>`);
  ui.headerRow.append(conn, title, newBtn);
  newBtn.onclick = openNewSessionSheet;
  ui.main.className = "list";
  ui.main.onscroll = null;
  ui.main.innerHTML = `<div class="empty">Loading sessions…</div>`;
  void loadList();
}

async function loadList(): Promise<void> {
  if (!rpc.connected) return;
  try {
    const [listResult] = await Promise.all([
      rpc.request<{ sessions: SessionSummary[]; workspaceRoot: string }>("sessions.list"),
      refreshModels(),
    ]);
    workspaceRoot = listResult.workspaceRoot;
    if (view !== "list") return;
    renderSessionCards(listResult.sessions);
  } catch (error) {
    if (view === "list") ui.main.innerHTML = `<div class="empty">${escapeHtml(String((error as Error).message))}</div>`;
  }
}

function renderSessionCards(sessions: SessionSummary[]): void {
  ui.main.innerHTML = "";
  if (sessions.length === 0) {
    ui.main.appendChild(el(`<div class="empty">No sessions yet.<br>Tap <strong>New</strong> to start one.</div>`));
    return;
  }
  for (const s of sessions) {
    const badge = s.active ? `<span class="badge active">${s.streaming ? "running" : "live"}</span>` : "";
    const card = el(`
      <div class="session-card" role="button">
        <div class="info">
          <div class="title">${escapeHtml(s.name || s.firstMessage || "(empty session)")}</div>
          <div class="meta">${escapeHtml(shortWorkspace(s.workspace))} · ${escapeHtml(relativeTime(s.modified))} · ${s.messageCount} msgs</div>
        </div>
        ${badge}
        <button class="icon danger" aria-label="Delete session">✕</button>
      </div>`);
    (card.querySelector("button.danger") as HTMLButtonElement).onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${s.name || s.firstMessage || "this session"}"?`)) return;
      try {
        if (s.path) await rpc.request("sessions.delete", { path: s.path });
        card.remove();
      } catch (error) {
        toast(String((error as Error).message));
      }
    };
    card.onclick = async () => {
      card.classList.add("busy");
      try {
        if (s.active) {
          await openChat(s.sessionId);
        } else if (s.path) {
          const { session } = await rpc.request<{ session: SessionSummary }>("sessions.resume", { path: s.path });
          await openChat(session.sessionId);
        }
      } catch (error) {
        card.classList.remove("busy");
        toast(String((error as Error).message));
      }
    };
    ui.main.appendChild(card);
  }
}

function shortWorkspace(workspace: string): string {
  const parts = workspace.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || workspace;
}

function openNewSessionSheet(): void {
  openSheet((body, close) => {
    body.innerHTML = `
      <h2>New session</h2>
      <label>Workspace directory</label>
      <input name="workspace" placeholder="${escapeHtml(workspaceRoot ? `${workspaceRoot}/…` : "directory")}"
             autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
      <label>Model</label>
      <select name="model">
        <option value="">default</option>
        ${models
          .map((m) => `<option value="${escapeHtml(`${m.provider}/${m.id}`)}">${escapeHtml(m.name ?? m.id)} · ${escapeHtml(m.provider)}</option>`)
          .join("")}
      </select>
      <button class="primary wide">Create</button>
    `;
    const createBtn = body.querySelector("button.primary") as HTMLButtonElement;
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      const workspace = (body.querySelector("input[name=workspace]") as HTMLInputElement).value.trim();
      const model = (body.querySelector("select[name=model]") as HTMLSelectElement).value;
      try {
        const { session } = await rpc.request<{ session: SessionSummary }>("sessions.create", {
          ...(workspace ? { workspace } : {}),
          ...(model ? { model } : {}),
        });
        close();
        await openChat(session.sessionId);
      } catch (error) {
        createBtn.disabled = false;
        createBtn.textContent = "Create";
        toast(String((error as Error).message));
      }
    };
  });
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
    compacting: false,
    deliverMode: "steer",
    attachments: [],
    queuedNotes: [],
    telemetry: state.telemetry,
    telemetryReceivedAt: Date.now(),
    activity: { kind: state.summary.streaming ? "waiting" : "idle" },
    turnStartedAt: state.summary.streaming ? Date.now() : undefined,
  };
  stickToBottom = true;
  renderChatShell();
  renderLog();
  scrollLogToBottom(true);
}

function renderChatShell(): void {
  if (!chat) return;
  ui.headerRow.innerHTML = "";
  const backBtn = el(`<button class="icon" aria-label="Back">‹</button>`);
  const conn = el(`<span class="conn ${connState === "online" ? "online" : ""}"></span>`);
  const titleBox = el(`
    <div class="title-box" role="button">
      <h1 id="chat-title">${escapeHtml(chatTitle())}</h1>
      <div class="subtitle">${escapeHtml(shortWorkspace(chat.summary.workspace))}</div>
    </div>`);
  const settingsBtn = el(`<button class="chip" id="model-chip">${escapeHtml(modelChipLabel())}</button>`);
  ui.headerRow.append(backBtn, conn, titleBox, settingsBtn);

  backBtn.onclick = () => {
    if (chat) void rpc.request("session.detach", { sessionId: chat.summary.sessionId }).catch(() => {});
    showList();
  };
  titleBox.onclick = openSessionSheet;
  settingsBtn.onclick = openSessionSheet;

  ui.main.className = "chat";
  ui.main.innerHTML = "";
  ui.main.onscroll = onLogScroll;

  buildComposer();
  updateStreamingUi();
  updateSendEnabled();
}

function chatTitle(): string {
  if (!chat) return "session";
  return chat.summary.name || chat.summary.workspace.split("/").pop() || "session";
}

function openSessionSheet(): void {
  if (!chat) return;
  openSheet((body, close) => {
    const findSelectedModel = () =>
      models.find((m) => chat!.model && m.provider === chat!.model.provider && m.id === chat!.model.id);
    const canThink = findSelectedModel()?.reasoning !== false;
    body.innerHTML = `
      <h2>Session</h2>
      <label>Name</label>
      <div class="row">
        <input name="name" value="${escapeHtml(chat!.summary.name ?? "")}" placeholder="Session name" autocomplete="off" />
        <button name="save">Save</button>
      </div>
      <label>Model</label>
      <select name="model">
        ${models
          .map((m) => {
            const value = `${m.provider}/${m.id}`;
            const selected = chat!.model && chat!.model.provider === m.provider && chat!.model.id === m.id;
            return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(m.name ?? m.id)} · ${escapeHtml(m.provider)}</option>`;
          })
          .join("")}
      </select>
      <label>Thinking</label>
      <div class="thinking-row">
        ${THINKING_LEVELS.map(
          (l) =>
            `<button class="seg ${l === chat!.thinkingLevel ? "on" : ""}" data-level="${l}" ${canThink ? "" : "disabled"}>${l}</button>`,
        ).join("")}
      </div>
      <div class="sheet-meta" id="thinking-note" ${canThink ? "hidden" : ""}>Thinking isn't available for this model.</div>
      <div class="sheet-meta">${escapeHtml(chat!.summary.workspace)}</div>
    `;
    const nameInput = body.querySelector("input[name=name]") as HTMLInputElement;
    (body.querySelector("button[name=save]") as HTMLButtonElement).onclick = async () => {
      const name = nameInput.value.trim();
      if (!name || !chat) return;
      try {
        const result = await rpc.request<{ name: string }>("session.rename", {
          sessionId: chat.summary.sessionId,
          name,
        });
        chat.summary.name = result.name;
        const titleEl = document.getElementById("chat-title");
        if (titleEl) titleEl.textContent = chatTitle();
        close();
      } catch (error) {
        toast(String((error as Error).message));
      }
    };
    const modelSelect = body.querySelector("select[name=model]") as HTMLSelectElement;
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
        updateModelChip();
        toast(`Switched to ${modelLabel(model)} · loads on your next message`);
        const nowCanThink = model?.reasoning !== false;
        for (const b of body.querySelectorAll<HTMLButtonElement>(".thinking-row .seg")) b.disabled = !nowCanThink;
        const note = body.querySelector("#thinking-note") as HTMLElement | null;
        if (note) note.hidden = nowCanThink;
      } catch (error) {
        toast(String((error as Error).message));
      }
    };
    for (const btn of body.querySelectorAll<HTMLButtonElement>(".thinking-row .seg")) {
      btn.onclick = async () => {
        if (!chat) return;
        try {
          const { thinkingLevel } = await rpc.request<{ thinkingLevel: string }>("session.set_thinking", {
            sessionId: chat.summary.sessionId,
            level: btn.dataset.level ?? "off",
          });
          chat.thinkingLevel = thinkingLevel;
          updateModelChip();
          for (const b of body.querySelectorAll(".thinking-row .seg")) {
            b.classList.toggle("on", (b as HTMLElement).dataset.level === thinkingLevel);
          }
        } catch (error) {
          toast(String((error as Error).message));
        }
      };
    }
  });
}

function buildComposer(): void {
  ui.footer.hidden = false;
  ui.footer.innerHTML = `
    <div class="status-bar" id="status-bar" hidden>
      <span class="status-state" id="status-state"></span>
      <span class="status-stats" id="status-stats"></span>
      <button class="cancel-compact" id="compact-cancel" hidden>Cancel</button>
    </div>
    <div class="queue-note" id="queue-note" hidden></div>
    <div class="attach-strip" id="attach-strip" hidden></div>
    <div class="deliver-row" id="deliver-row" hidden>
      <button class="seg on" data-mode="steer">Steer now</button>
      <button class="seg" data-mode="followup">After done</button>
      <button class="stop" id="stop-btn">■ Stop</button>
    </div>
    <div class="composer">
      <button class="icon" id="attach-btn" aria-label="Attach image">+</button>
      <textarea id="prompt-input" placeholder="Message the agent…" rows="1" enterkeyhint="send"></textarea>
      <button class="send" id="send-btn" aria-label="Send">↑</button>
    </div>
    <input type="file" id="file-input" accept="image/*" multiple hidden />
  `;
  const textarea = ui.footer.querySelector("#prompt-input") as HTMLTextAreaElement;
  const sendBtn = ui.footer.querySelector("#send-btn") as HTMLButtonElement;
  const attachBtn = ui.footer.querySelector("#attach-btn") as HTMLButtonElement;
  const fileInput = ui.footer.querySelector("#file-input") as HTMLInputElement;
  const stopBtn = ui.footer.querySelector("#stop-btn") as HTMLButtonElement;

  textarea.oninput = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
    updateSendEnabled();
  };
  textarea.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      ev.preventDefault();
      void sendPrompt();
    }
  };
  sendBtn.onclick = () => void sendPrompt();
  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    void addAttachments(fileInput.files);
    fileInput.value = "";
  };
  stopBtn.onclick = () => {
    if (!chat) return;
    void rpc.request("session.abort", { sessionId: chat.summary.sessionId }).catch((e: Error) => toast(e.message));
  };
  (ui.footer.querySelector("#compact-cancel") as HTMLButtonElement).onclick = () => void cancelCompaction();
  for (const seg of ui.footer.querySelectorAll<HTMLButtonElement>(".deliver-row .seg")) {
    seg.onclick = () => {
      if (!chat) return;
      chat.deliverMode = (seg.dataset.mode as "steer" | "followup") ?? "steer";
      for (const b of ui.footer.querySelectorAll(".deliver-row .seg")) {
        b.classList.toggle("on", b === seg);
      }
      textarea.placeholder = chat.deliverMode === "steer" ? "Steer the agent…" : "Queue a follow-up…";
    };
  }
}

async function addAttachments(files: FileList | null): Promise<void> {
  if (!chat || !files) return;
  for (const file of Array.from(files)) {
    if (chat.attachments.length >= 8) {
      toast("Max 8 images per message");
      break;
    }
    try {
      chat.attachments.push(await fileToAttachment(file));
    } catch {
      toast(`Could not read ${file.name}`);
    }
  }
  renderAttachStrip();
}

async function fileToAttachment(file: File): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" };
}

function renderAttachStrip(): void {
  const strip = document.getElementById("attach-strip");
  if (!strip || !chat) return;
  strip.hidden = chat.attachments.length === 0;
  strip.innerHTML = "";
  chat.attachments.forEach((attachment, index) => {
    const thumb = el(`
      <span class="thumb">
        <img src="data:${escapeHtml(attachment.mimeType)};base64,${attachment.data}" alt="attachment" />
        <button aria-label="Remove image">✕</button>
      </span>`);
    (thumb.querySelector("button") as HTMLButtonElement).onclick = () => {
      chat?.attachments.splice(index, 1);
      renderAttachStrip();
    };
    strip.appendChild(thumb);
  });
  updateSendEnabled();
}

function updateSendEnabled(): void {
  const textarea = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("send-btn") as HTMLButtonElement | null;
  if (!textarea || !sendBtn || !chat) return;
  sendBtn.disabled = textarea.value.trim() === "" && chat.attachments.length === 0;
}

async function sendPrompt(): Promise<void> {
  if (!chat) return;
  const textarea = document.getElementById("prompt-input") as HTMLTextAreaElement;
  const text = textarea.value.trim();
  const images = chat.attachments.slice();
  if (!text && images.length === 0) return;
  const compactCommand = parseCompactCommand(text);
  if (compactCommand) {
    textarea.value = "";
    textarea.style.height = "auto";
    updateSendEnabled();
    await sendCompact(compactCommand.instructions);
    return;
  }
  textarea.value = "";
  textarea.style.height = "auto";
  chat.attachments = [];
  renderAttachStrip();
  updateSendEnabled();

  const type = chat.streaming ? (chat.deliverMode === "followup" ? "session.followup" : "session.steer") : "session.prompt";
  const freshRun = type === "session.prompt";
  const optimistic: ChatMessage = {
    role: "user",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
    ],
  };
  const optimisticNode = messageNode(optimistic, -1);
  appendNode(optimisticNode, { optimistic: true });
  if (freshRun) {
    statusRow("awaiting", "Waiting for the model — big local models can take several minutes before the first token.");
    chat.turnStartedAt = Date.now();
  }
  scrollLogToBottom(true);
  const sessionId = chat.summary.sessionId;
  try {
    await rpc.request(type, {
      sessionId,
      text,
      ...(images.length ? { images } : {}),
    });
  } catch (error) {
    if (error instanceof ConnectionLostError && error.sentBeforeLoss) {
      unconfirmedOutbound = { sessionId, text, startsTurn: freshRun };
      return;
    }
    optimisticNode?.remove();
    if (freshRun) removeStatusRow("awaiting");
    const input = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
    if (input && !input.value) input.value = text;
    if (chat && chat.attachments.length === 0 && images.length) {
      chat.attachments = images;
      renderAttachStrip();
    }
    if (error instanceof ConnectionLostError) {
      toast("Offline — your message wasn't sent; it's back in the composer", "info");
    } else {
      toast(String((error as Error).message));
    }
  }
}

async function sendCompact(instructions?: string): Promise<void> {
  if (!chat) return;
  const gate = gateCompact(chat.streaming, chat.compacting);
  if (!gate.allowed) {
    toast(gate.reason, "info");
    return;
  }
  chat.compacting = true;
  chat.compactionStartedAt = Date.now();
  renderStatusBar();
  try {
    await rpc.request("session.compact", {
      sessionId: chat.summary.sessionId,
      ...(instructions ? { instructions } : {}),
    });
  } catch (error) {
    clearCompactingState();
    toast(String((error as Error).message));
  }
}

function clearCompactingState(): void {
  if (!chat) return;
  chat.compacting = false;
  chat.compactionStartedAt = undefined;
  renderStatusBar();
}

async function cancelCompaction(): Promise<void> {
  if (!chat || !chat.compacting) return;
  try {
    await rpc.request("session.compact_abort", { sessionId: chat.summary.sessionId });
  } catch (error) {
    toast(String((error as Error).message));
    return;
  }
  clearCompactingState();
}

function updateStreamingUi(): void {
  if (!chat) return;
  const deliverRow = document.getElementById("deliver-row");
  const textarea = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
  if (deliverRow) deliverRow.hidden = !chat.streaming;
  if (textarea) {
    textarea.placeholder = chat.streaming
      ? chat.deliverMode === "followup"
        ? "Queue a follow-up…"
        : "Steer the agent…"
      : "Message the agent…";
  }
  const badgeTarget = document.getElementById("chat-title");
  badgeTarget?.classList.toggle("streaming", chat.streaming);
  renderStatusBar();
}

function statusStats(): string {
  if (!chat) return "";
  const snapshot = chat.telemetry;
  if (!snapshot) {
    return chat.streaming && chat.turnStartedAt !== undefined ? formatDuration(Date.now() - chat.turnStartedAt) : "";
  }
  if (chat.streaming && snapshot.phase !== "idle") return liveTurnStats(snapshot, Date.now() - chat.telemetryReceivedAt);
  return finishedTurnStats(snapshot);
}

function renderStatusBar(): void {
  if (!chat) return;
  const bar = document.getElementById("status-bar");
  const stateEl = document.getElementById("status-state");
  const statsEl = document.getElementById("status-stats");
  const cancelBtn = document.getElementById("compact-cancel") as HTMLButtonElement | null;
  if (!bar || !stateEl || !statsEl) return;
  if (chat.compacting) {
    bar.hidden = false;
    stateEl.innerHTML = `<span class="work-spin"></span>${escapeHtml(COMPACTING_LABEL)}`;
    stateEl.classList.remove("idle", "err");
    statsEl.textContent = compactingElapsed(chat.compactionStartedAt, Date.now());
    if (cancelBtn) cancelBtn.hidden = false;
    return;
  }
  if (cancelBtn) cancelBtn.hidden = true;
  if (!chat.streaming && !chat.telemetry) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = statusLabel(chat.streaming, chat.activity, chat.telemetry?.outcome);
  stateEl.innerHTML = `${chat.streaming ? '<span class="work-spin"></span>' : ""}${escapeHtml(label)}`;
  stateEl.classList.toggle("idle", !chat.streaming);
  stateEl.classList.toggle("err", !chat.streaming && chat.telemetry?.outcome === "error");
  statsEl.textContent = statusStats();
}

function setActivity(activity: TurnActivity): void {
  if (!chat) return;
  if (chat.activity.kind === activity.kind && chat.activity.toolName === activity.toolName) return;
  chat.activity = activity;
  renderStatusBar();
}

window.setInterval(() => {
  if (view === "chat" && (chat?.streaming || chat?.compacting)) renderStatusBar();
}, 1000);

function onLogScroll(): void {
  const main = ui.main;
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 60;
  stickToBottom = nearBottom;
  ui.jumpPill.hidden = nearBottom;
}

function scrollLogToBottom(force = false): void {
  if (!force && !stickToBottom) return;
  ui.main.scrollTop = ui.main.scrollHeight;
  ui.jumpPill.hidden = true;
  stickToBottom = true;
}

ui.jumpPill.onclick = () => scrollLogToBottom(true);

function renderLog(): void {
  if (!chat) return;
  ui.main.innerHTML = "";
  toolCards.clear();
  chat.messages.forEach((message, index) => {
    const node = messageNode(message, index);
    if (node) ui.main.appendChild(node);
  });
}

const toolCards = new Map<string, HTMLElement>();

function messageNode(message: ChatMessage, index: number): HTMLElement | undefined {
  const node = buildMessageNode(message, index);
  if (node) addCopyButtons(node);
  return node;
}

function addCopyButtons(node: HTMLElement): void {
  for (const block of node.querySelectorAll(".codeblock")) {
    const code = block.querySelector("code");
    if (!code) continue;
    const btn = el(`<button class="copy-btn" aria-label="Copy code">copy</button>`) as HTMLButtonElement;
    btn.onclick = (ev) => {
      ev.stopPropagation();
      void navigator.clipboard
        .writeText(code.textContent ?? "")
        .then(() => {
          btn.textContent = "copied";
          setTimeout(() => (btn.textContent = "copy"), 1500);
        })
        .catch(() => toast("Copy failed"));
    };
    block.appendChild(btn);
  }
}

function buildMessageNode(message: ChatMessage, index: number): HTMLElement | undefined {
  switch (message.role) {
    case "user":
      return userNode(message, index);
    case "assistant":
      return assistantNode(message, index);
    case "toolResult":
      return toolResultNode(message, index);
    case "bashExecution":
      return el(`
        <details class="tool" data-mi="${index}">
          <summary><span class="tool-status ok"></span><span class="tool-title">!</span><span class="tool-digest">${escapeHtml(message.command ?? "")}</span></summary>
          <div class="tool-body"><pre class="tool-pre">${escapeHtml(message.output ?? "")}</pre></div>
        </details>`);
    case "compactionSummary":
      return compactionSummaryNode(message, index);
    case "branchSummary":
      return el(`<div class="sys-row" data-mi="${index}">returned from branch</div>`);
    case "custom": {
      if (message.display === false) return el(`<div hidden data-mi="${index}"></div>`);
      const text = contentText(message.content);
      if (!text) return el(`<div hidden data-mi="${index}"></div>`);
      return el(`<div class="sys-row" data-mi="${index}">${renderMarkdown(text)}</div>`);
    }
    default: {
      const text = contentText(message.content);
      if (!text) return el(`<div hidden data-mi="${index}"></div>`);
      return el(`<div class="msg" data-mi="${index}">${renderMarkdown(text)}</div>`);
    }
  }
}

const compactionAfterTokens = new Map<string, number>();

function compactionAfterKey(sessionId: string, tokensBefore: number): string {
  return `${sessionId}:${tokensBefore}`;
}

function compactionSummaryNode(message: ChatMessage, index: number): HTMLElement {
  const before = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
  const after =
    message.estimatedTokensAfter ??
    (before !== undefined && chat ? compactionAfterTokens.get(compactionAfterKey(chat.summary.sessionId, before)) : undefined);
  return el(`
    <details class="compaction-result" data-mi="${index}">
      <summary>${escapeHtml(compactionResultTitle(before, after))}</summary>
      <div class="compaction-summary">${renderMarkdown(message.summary ?? "")}</div>
    </details>`);
}

function userNode(message: ChatMessage, index: number): HTMLElement {
  const text = contentText(message.content);
  const images = contentImages(message.content);
  const thumbs = images
    .map((img) => `<img class="user-img" src="data:${escapeHtml(img.mimeType ?? "image/jpeg")};base64,${img.data}" alt="attached" />`)
    .join("");
  return el(`<div class="msg user" data-mi="${index}">${thumbs}${text ? renderMarkdown(text) : ""}</div>`);
}

function assistantNode(message: ChatMessage, index: number): HTMLElement {
  const node = el(`<div class="msg assistant" data-mi="${index}"></div>`);
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      node.appendChild(el(`<div class="text">${renderMarkdown(block.text)}</div>`));
    } else if (block.type === "thinking" && block.thinking) {
      node.appendChild(
        el(`<details class="thinking"><summary>Thinking</summary><div class="body">${renderMarkdown(block.thinking)}</div></details>`),
      );
    } else if (block.type === "toolCall") {
      const card = toolCallCard(block);
      node.appendChild(card);
      if (block.id) toolCards.set(block.id, card);
    }
  }
  if (message.stopReason === "aborted") {
    node.appendChild(el(`<div class="error-note">stopped</div>`));
  } else if (message.errorMessage) {
    node.appendChild(el(`<div class="error-note">${escapeHtml(message.errorMessage)}</div>`));
  }
  return node;
}

function toolDigest(name: string | undefined, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const first = (keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  switch (name) {
    case "bash":
      return first(["command"]);
    case "read":
    case "write":
    case "edit":
      return shortPath(first(["path", "file_path", "filePath"]));
    case "grep":
    case "find":
    case "glob":
      return first(["pattern", "query"]);
    case "ls":
      return shortPath(first(["path"])) || ".";
    default: {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json;
    }
  }
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 3 ? p : `…/${parts.slice(-3).join("/")}`;
}

function toolCallCard(block: ContentBlock): HTMLElement {
  const digest = toolDigest(block.name, block.arguments);
  const card = el(`
    <details class="tool" ${block.id ? `data-tool-id="${escapeHtml(block.id)}"` : ""}>
      <summary>
        <span class="tool-status pending"></span>
        <span class="tool-title">${escapeHtml(block.name ?? "tool")}</span>
        <span class="tool-digest">${escapeHtml(digest)}</span>
      </summary>
      <div class="tool-body">
        <pre class="tool-args">${escapeHtml(JSON.stringify(block.arguments ?? {}, null, 2))}</pre>
        <div class="tool-out"></div>
      </div>
    </details>`);
  return card;
}

function toolResultNode(message: ChatMessage, index: number): HTMLElement {
  const card = message.toolCallId ? toolCards.get(message.toolCallId) : undefined;
  if (card) {
    fillToolResult(card, message);
    return el(`<div hidden data-mi="${index}"></div>`);
  }
  const orphan = el(`
    <details class="tool" data-mi="${index}">
      <summary>
        <span class="tool-status ${message.isError ? "err" : "ok"}"></span>
        <span class="tool-title">${escapeHtml(message.toolName ?? "tool")}</span>
        <span class="tool-digest">result</span>
      </summary>
      <div class="tool-body"><div class="tool-out"></div></div>
    </details>`);
  fillToolResult(orphan, message);
  return orphan;
}

function fillToolResult(card: HTMLElement, message: ChatMessage): void {
  const status = card.querySelector(".tool-status");
  status?.classList.remove("pending", "running");
  status?.classList.add(message.isError ? "err" : "ok");
  const out = card.querySelector(".tool-out") as HTMLElement | null;
  if (!out) return;
  out.innerHTML = "";
  const diff = typeof message.details?.diff === "string" ? message.details.diff : undefined;
  if (diff) {
    out.appendChild(diffNode(diff));
    return;
  }
  const text = contentText(message.content);
  if (text) out.appendChild(expandableOutput(text));
  for (const img of contentImages(message.content)) {
    out.appendChild(el(`<img class="tool-img" src="data:${escapeHtml(img.mimeType ?? "image/png")};base64,${img.data}" alt="tool output" />`));
  }
  const truncation = message.details?.truncation as { truncated?: boolean; totalLines?: number } | undefined;
  if (truncation?.truncated) {
    out.appendChild(el(`<div class="trunc-note">output truncated by Pi (${truncation.totalLines ?? "?"} lines total)</div>`));
  }
  if (!out.hasChildNodes()) out.appendChild(el(`<em class="no-out">(no output)</em>`));
}

function expandableOutput(text: string): HTMLElement {
  if (text.length <= OUTPUT_PREVIEW_CHARS) {
    return el(`<pre class="tool-pre">${escapeHtml(text)}</pre>`);
  }
  const wrap = el(`<div class="expandable"></div>`);
  const pre = el(`<pre class="tool-pre">${escapeHtml(text.slice(0, OUTPUT_PREVIEW_CHARS))}\n…</pre>`);
  const kb = (text.length / 1024).toFixed(0);
  const more = el(`<button class="show-more">Show all (${kb} KB)</button>`) as HTMLButtonElement;
  more.onclick = () => {
    pre.textContent = text;
    more.remove();
  };
  wrap.append(pre, more);
  return wrap;
}

function diffNode(diff: string): HTMLElement {
  const lines = diff.split("\n").map((line) => {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@") ? "hunk" : "";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  });
  return el(`<pre class="tool-pre diff">${lines.join("\n")}</pre>`);
}

interface AppendOptions {
  optimistic?: boolean;
}

function appendNode(node: HTMLElement | undefined, options: AppendOptions = {}): void {
  if (!node) return;
  if (options.optimistic) node.dataset.optimistic = "1";
  ui.main.appendChild(node);
  scrollLogToBottom();
}

function replaceMessageNode(index: number, message: ChatMessage): void {
  const existing = ui.main.querySelector(`[data-mi="${index}"]`) as HTMLElement | null;
  const openDetails = existing
    ? [...existing.querySelectorAll("details")].map((d) => (d as HTMLDetailsElement).open)
    : [];
  const node = messageNode(message, index);
  if (!node) return;
  const fresh = [...node.querySelectorAll("details")];
  openDetails.forEach((wasOpen, i) => {
    const target = fresh[i] as HTMLDetailsElement | undefined;
    if (target && wasOpen) target.open = true;
  });
  if (existing) existing.replaceWith(node);
  else ui.main.appendChild(node);
  scrollLogToBottom();
}

let pendingReplace: { index: number; message: ChatMessage } | undefined;
let replaceScheduled = false;

function scheduleReplace(index: number, message: ChatMessage): void {
  pendingReplace = { index, message };
  if (replaceScheduled) return;
  replaceScheduled = true;
  requestAnimationFrame(() => {
    replaceScheduled = false;
    if (pendingReplace) replaceMessageNode(pendingReplace.index, pendingReplace.message);
    pendingReplace = undefined;
  });
}

function cancelScheduledReplace(): void {
  pendingReplace = undefined;
}

function statusRow(id: string, html: string): void {
  removeStatusRow(id);
  const node = el(`<div class="sys-row status" data-status="${escapeHtml(id)}">${html}</div>`);
  ui.main.appendChild(node);
  scrollLogToBottom();
}

function removeStatusRow(id: string): void {
  ui.main.querySelector(`[data-status="${CSS.escape(id)}"]`)?.remove();
}

function handleSessionEvent(sessionId: string, event: Record<string, unknown>): void {
  if (!chat || view !== "chat" || chat.summary.sessionId !== sessionId) return;
  switch (event.type) {
    case "agent_start":
      chat.streaming = true;
      chat.turnStartedAt ??= Date.now();
      chat.activity = { kind: "waiting" };
      removeStatusRow("retry");
      removeStatusRow("awaiting");
      updateStreamingUi();
      break;
    case "agent_end": {
      const willRetry = event.willRetry === true;
      chat.streaming = willRetry;
      if (!willRetry) {
        chat.turnStartedAt = undefined;
        chat.activity = { kind: "idle" };
        for (const status of ui.main.querySelectorAll(".sys-row.status")) status.remove();
        for (const spin of ui.main.querySelectorAll(".tool-status.running")) {
          spin.classList.remove("running");
          spin.classList.add("ok");
        }
      }
      updateStreamingUi();
      void resyncChat(sessionId, { trustServerStreaming: false });
      break;
    }
    case "message_start": {
      const message = event.message as ChatMessage;
      if (message.role === "user") {
        ui.main.querySelector('[data-optimistic="1"]')?.remove();
      }
      chat.messages.push(message);
      appendNode(messageNode(message, chat.messages.length - 1));
      break;
    }
    case "message_update": {
      const message = event.message as ChatMessage;
      if (chat.messages.length === 0) chat.messages.push(message);
      else chat.messages[chat.messages.length - 1] = message;
      scheduleReplace(chat.messages.length - 1, message);
      const streamEvent = event.assistantMessageEvent as { type?: string } | undefined;
      const activity = activityForAssistantEvent(streamEvent?.type ?? "");
      if (activity) setActivity(activity);
      break;
    }
    case "message_end": {
      const message = event.message as ChatMessage;
      if (chat.messages.length === 0) chat.messages.push(message);
      else chat.messages[chat.messages.length - 1] = message;
      cancelScheduledReplace();
      replaceMessageNode(chat.messages.length - 1, message);
      break;
    }
    case "tool_execution_start": {
      const card = toolCards.get(String(event.toolCallId));
      const status = card?.querySelector(".tool-status");
      status?.classList.remove("pending", "ok", "err");
      status?.classList.add("running");
      setActivity({ kind: "tool", toolName: String(event.toolName ?? "tool") });
      break;
    }
    case "tool_execution_update": {
      const card = toolCards.get(String(event.toolCallId));
      if (!card) break;
      const partial = event.partialResult as { content?: ContentBlock[] } | undefined;
      const text = contentText(partial?.content);
      if (!text) break;
      const out = card.querySelector(".tool-out") as HTMLElement | null;
      if (!out) break;
      const tail = text.length > OUTPUT_PREVIEW_CHARS ? `…\n${text.slice(-OUTPUT_PREVIEW_CHARS)}` : text;
      out.innerHTML = `<pre class="tool-pre live">${escapeHtml(tail)}</pre>`;
      break;
    }
    case "tool_execution_end": {
      const card = toolCards.get(String(event.toolCallId));
      const status = card?.querySelector(".tool-status");
      status?.classList.remove("running", "pending");
      status?.classList.add(event.isError ? "err" : "ok");
      setActivity({ kind: "waiting" });
      break;
    }
    case "queue_update": {
      const steering = (event.steering as string[] | undefined) ?? [];
      const followUp = (event.followUp as string[] | undefined) ?? [];
      const note = document.getElementById("queue-note");
      if (!note) break;
      const total = steering.length + followUp.length;
      note.hidden = total === 0;
      note.textContent =
        total === 0
          ? ""
          : [
              steering.length ? `${steering.length} steering` : "",
              followUp.length ? `${followUp.length} follow-up` : "",
            ]
              .filter(Boolean)
              .join(" · ") + " queued";
      break;
    }
    case "session_info_changed": {
      chat.summary.name = typeof event.name === "string" ? event.name : chat.summary.name;
      const titleEl = document.getElementById("chat-title");
      if (titleEl) titleEl.textContent = chatTitle();
      break;
    }
    case "thinking_level_changed":
      chat.thinkingLevel = String(event.level ?? chat.thinkingLevel);
      updateModelChip();
      break;
    case "auto_retry_start":
      statusRow("retry", `retrying after error (attempt ${Number(event.attempt)}/${Number(event.maxAttempts)})…`);
      break;
    case "auto_retry_end":
      if (event.success !== true) {
        removeStatusRow("retry");
        if (event.finalError) toast(String(event.finalError));
      }
      break;
    case "compaction_start":
      chat.compacting = true;
      chat.compactionStartedAt ??= Date.now();
      renderStatusBar();
      break;
    case "compaction_end": {
      chat.compacting = false;
      chat.compactionStartedAt = undefined;
      const outcome = classifyCompactionEnd(event as unknown as CompactionEndEvent);
      if (outcome.kind === "done") {
        if (outcome.result.estimatedTokensAfter !== undefined) {
          compactionAfterTokens.set(
            compactionAfterKey(sessionId, outcome.result.tokensBefore),
            outcome.result.estimatedTokensAfter,
          );
        }
        const message: ChatMessage = {
          role: "compactionSummary",
          summary: outcome.result.summary,
          tokensBefore: outcome.result.tokensBefore,
          estimatedTokensAfter: outcome.result.estimatedTokensAfter,
        };
        chat.messages.push(message);
        appendNode(messageNode(message, chat.messages.length - 1));
      } else if (outcome.kind === "canceled") {
        appendNode(el(`<div class="sys-row">Compaction canceled</div>`));
      } else if (outcome.kind === "empty") {
        appendNode(el(`<div class="sys-row">${escapeHtml(outcome.message)}</div>`));
      } else {
        appendNode(el(`<div class="sys-row err">${escapeHtml(outcome.message)}</div>`));
      }
      renderStatusBar();
      scrollLogToBottom();
      break;
    }
    default:
      break;
  }
}

async function attachWithResume(sessionId: string, path: string | undefined): Promise<AttachState> {
  try {
    return await rpc.request<AttachState>("session.attach", { sessionId });
  } catch (error) {
    if (!path) throw error;
    const { session } = await rpc.request<{ session: SessionSummary }>("sessions.resume", { path });
    return await rpc.request<AttachState>("session.attach", { sessionId: session.sessionId });
  }
}

function recentUserMessageMatches(messages: ChatMessage[], text: string): boolean {
  return messages.slice(-10).some((m) => m.role === "user" && contentText(m.content).trim() === text.trim());
}

function reconcileUnconfirmedOutbound(sessionId: string, state: AttachState): void {
  if (!unconfirmedOutbound || unconfirmedOutbound.sessionId !== sessionId) return;
  const pending = unconfirmedOutbound;
  unconfirmedOutbound = undefined;
  const delivered =
    (pending.startsTurn && state.summary.streaming) || recentUserMessageMatches(state.messages, pending.text);
  if (delivered) return;
  ui.main.querySelector('[data-optimistic="1"]')?.remove();
  removeStatusRow("awaiting");
  const input = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
  if (input && !input.value) input.value = pending.text;
  toast(
    pending.startsTurn
      ? "Reconnected — your message didn't reach the server; it's back in the composer"
      : "Reconnected — couldn't confirm your note was delivered; it's back in the composer just in case",
    "info",
  );
}

async function resyncChat(sessionId: string, options: { trustServerStreaming?: boolean } = {}): Promise<void> {
  if (!chat || chat.summary.sessionId !== sessionId || !rpc.connected) return;
  try {
    const state = await attachWithResume(sessionId, chat.summary.path);
    if (!chat || view !== "chat" || chat.summary.sessionId !== sessionId) return;
    const drifted = state.messages.length !== chat.messages.length;
    chat.compacting = chat.compacting && !compactionApplied(chat.messages, state.messages);
    if (!chat.compacting) chat.compactionStartedAt = undefined;
    chat.summary = state.summary;
    chat.messages = state.messages;
    chat.model = state.model;
    chat.thinkingLevel = state.thinkingLevel;
    if (options.trustServerStreaming !== false) chat.streaming = state.summary.streaming;
    if (state.telemetry) {
      chat.telemetry = state.telemetry;
      chat.telemetryReceivedAt = Date.now();
    }
    reconcileUnconfirmedOutbound(sessionId, state);
    if (!chat.streaming) {
      chat.turnStartedAt = undefined;
      chat.activity = { kind: "idle" };
    }
    updateModelChip();
    const titleEl = document.getElementById("chat-title");
    if (titleEl) titleEl.textContent = chatTitle();
    if (drifted) {
      renderLog();
      scrollLogToBottom();
    }
    updateStreamingUi();
  } catch {
    if (rpc.connected && view === "chat" && chat?.summary.sessionId === sessionId) {
      toast("Session is no longer available");
      showList();
    }
  }
}

rpc.onPush = (msg) => {
  if (msg.type === "session_event") {
    handleSessionEvent(String(msg.sessionId), msg.event as Record<string, unknown>);
  } else if (msg.type === "session_telemetry") {
    if (chat && view === "chat" && chat.summary.sessionId === msg.sessionId) {
      chat.telemetry = msg.telemetry as TelemetrySnapshot;
      chat.telemetryReceivedAt = Date.now();
      renderStatusBar();
    }
  } else if (msg.type === "session_error") {
    toast(String(msg.error));
    if (chat && view === "chat" && chat.summary.sessionId === msg.sessionId) {
      chat.streaming = false;
      updateStreamingUi();
    }
  } else if (msg.type === "sessions_changed") {
    if (view === "list" && !listRefreshQueued) {
      listRefreshQueued = true;
      setTimeout(() => {
        listRefreshQueued = false;
        if (view === "list") void loadList();
      }, 200);
    }
  }
};

rpc.onStateChange = (state) => {
  setConnState(state);
  if (state === "online") {
    if (view === "chat" && chat) {
      void resyncChat(chat.summary.sessionId);
    } else {
      void loadList();
    }
  }
};

function initViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = (): void => {
    ui.app.style.height = `${vv.height}px`;
    ui.app.style.transform = `translateY(${vv.offsetTop}px)`;
    if (view === "chat") scrollLogToBottom();
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("focusin", () => setTimeout(sync, 50));
  sync();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") rpc.kick();
});
window.addEventListener("pageshow", () => rpc.kick());
window.addEventListener("online", () => rpc.kick());

initViewport();
showList();
rpc.connect();
