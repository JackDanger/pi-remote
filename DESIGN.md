# pi-remote — Design

A persistent server that hosts many concurrent [Pi](https://github.com/earendil-works/pi)
coding-agent sessions server-side, plus a mobile-first browser frontend connected over
WebSocket. The model is "Claude Code running on a server, remotely driven from an app" —
except the remote client is any browser.

## Decisions

### 1. In-process SDK, not `pi --mode rpc` subprocesses

Pi's SDK (`createAgentSession` from `@earendil-works/pi-coding-agent`) hosts multiple
fully independent `AgentSession`s in one Node process. Verified empirically before any
code was written: two sessions with different `cwd`s, prompted concurrently, each ran a
real `bash` tool call against its own workspace and produced workspace-specific answers,
with both sessions persisted as JSONL under Pi's own session directory.

Consequences:

- No stdio framing layer at all (the `--mode rpc` LF-framing / U+2028 hazard never enters
  the picture).
- Direct typed access to `AgentSession`: `prompt`/`steer`/`followUp`/`abort`,
  `subscribe`, `setModel`, `setThinkingLevel`, `messages`, `getSessionStats`.
- One shared `AuthStorage` + `ModelRegistry` across sessions, so provider auth is
  resolved once.
- Cost: an agent bug can take down all sessions (a subprocess-per-session design would
  isolate crashes). Accepted for v1; the SessionHost API is narrow enough to swap a
  subprocess backend in later without touching the protocol or frontend.

One real gotcha found in the spike: when a provider is registered by an *extension*
(e.g. a custom OpenAI-compatible provider via `pi.registerProvider`), the very first
session in the process resolves its default model **before** its extensions have
registered the provider, and ends up with a placeholder `unknown/unknown` model. The
fix is post-creation model resolution: after `createAgentSession`, if the session's
model is missing or has provider `unknown`, resolve the configured default (or the
first entry from `modelRegistry.getAvailable()`) and call `session.setModel(...)`.

### 2. Purpose-built frontend, not `@earendil-works/pi-web-ui`

`pi-web-ui` (0.75.3) was inspected as a reuse candidate and rejected:

- Its `ChatPanel.setAgent(agent: Agent)` binds directly to a live in-browser
  `pi-agent-core` `Agent` that runs the whole LLM loop client-side ("Direct Mode":
  browser → provider API). Driving it from a server-side session would mean
  implementing a fake `Agent` whose state, event emitter, tool registry, and streaming
  internals are remotely mirrored — a larger and more fragile surface than a chat UI.
- Its tools are browser-sandboxed (JS REPL, artifacts, doc extraction); none of the
  server-filesystem rendering (edit diffs, bash output) exists there anyway.
- It lags the agent package (0.75.x vs 0.80.x) and pulls heavy deps (pdfjs, xlsx,
  ollama, lmstudio, Tailwind v4 beta).

The purpose-built frontend is a small dependency-free TypeScript app (bundled with
esbuild) that renders `AgentMessage`s and live `AgentSessionEvent`s. Total surface: a
session list and a chat view. Events arrive with the *full* in-progress message
attached (`message_update.message`), so streaming rendering is "replace this message's
DOM node" — no client-side delta accounting.

### 3. Standalone SDK app, not an in-session Pi extension

Pi extensions are session-scoped: the extensions doc explicitly forbids starting
background resources (processes, sockets, timers) from an extension factory, because
factories run in invocations that never start a session. A permanent multi-session
server is the opposite lifecycle. So pi-remote ships as a standalone SDK application
with its own `pi-remote` bin, exactly like Pi's own `runRpcMode` consumers.

Pi-native behavior still works *inside* hosted sessions because each session is created
with a `DefaultResourceLoader` pointed at the session's workspace `cwd` and the host's
Pi `agentDir` (`~/.pi/agent` by default). That gives every hosted session the same
extensions, skills, prompt templates, context files (AGENTS.md), custom providers
(`models.json` + extension-registered), and auth (`auth.json`) that the host's `pi` CLI
has.

## Architecture

```
 phone / laptop browser
        │  HTTPS + WSS  (TLS, authn — reverse proxy's job)
        ▼
 reverse proxy (nginx / NPM / caddy)
        │  plain HTTP + WS, localhost
        ▼
 pi-remote server (Node)
 ├── HTTP: serves the built frontend, /healthz
 └── WS  /ws: JSON request/response + event push
        │
 SessionHost ── Map<sessionId, HostedSession>
        │            each: AgentSession (Pi SDK) + attached client set
        ▼
 real workspaces on the server filesystem
 (~/.pi/agent/sessions/**.jsonl persistence, Pi-owned)
```

### SessionHost

- `create({ cwd, model? })` → new persisted `AgentSession` with
  `SessionManager.create(cwd)`, default coding tools, `DefaultResourceLoader(cwd, agentDir)`.
- `resume(path)` → `SessionManager.open(path)`; if that file is already live, returns
  the live instance (sessions are keyed by Pi session id; resume is idempotent).
- `list()` → merge of live sessions and `SessionManager.listAll()` from disk, deduped
  by session file path, live ones marked `active`.
- Fan-out: every `AgentSessionEvent` is forwarded to all WS clients attached to that
  session; any number of clients can watch the same session (open on phone, keep
  watching on laptop).
- Prompting: if the session is streaming, an incoming prompt becomes `steer()`;
  otherwise `prompt()` runs fire-and-forget with errors surfaced as pushed
  `session_error` events (a prompt's promise resolves only when the whole run ends —
  much too late for a request/response cycle).

### WS protocol

Single JSON message per WS frame. Client requests carry an `id`; the server replies
with `{ id, ok, result | error }`. Server pushes are unsolicited:
`{ type: "session_event", sessionId, event }` (raw `AgentSessionEvent`, untranslated),
`{ type: "session_error", sessionId, error }`, and `{ type: "sessions_changed" }`
(broadcast to every connected client on create/delete/rename).

Requests: `sessions.list`, `sessions.create`, `sessions.resume`, `sessions.delete`,
`session.attach` (returns full serialized state: messages, model, thinking level,
streaming flag), `session.detach`, `session.prompt`, `session.steer`,
`session.followup`, `session.abort`, `session.set_model`, `session.set_thinking`,
`session.rename`, `models.list`, `ping`.

`session.prompt` / `session.steer` / `session.followup` take an optional
`images: [{ data, mimeType }]` array (base64, max 8 per message, `image/*` only);
the server converts these to Pi `ImageContent` blocks, and `text` may be empty when
images are present. `ping` exists so mobile clients can keep otherwise-idle
connections alive through reverse-proxy read timeouts.

Forwarding raw Pi events (rather than translating to a bespoke schema) keeps the server
thin and means new Pi event types flow through without server changes; the frontend
ignores types it doesn't know.

### Frontend resilience model (iOS Safari)

The client assumes the connection is unreliable: Safari suspends WebSockets when the
tab or PWA is backgrounded, and mobile networks drop mid-run. The `Rpc` layer
reconnects with exponential backoff (500ms → 8s), retries immediately on
`visibilitychange`/`pageshow`/`online`, times out stuck requests, and pings every 25s.
On reconnect the client re-attaches to the open session and reconciles state from
`session.attach`; if the attach fails because the server itself restarted (live session
gone), it resumes the session by path and re-attaches — a phone user never loses their
place in a conversation. After `agent_end` the client resyncs but keeps its local
not-streaming state, because `session.attach` served immediately after the end event
can still report `isStreaming: true` (Pi keeps it true until end listeners settle).

The keyboard is handled with the VisualViewport API: `#app` is resized to
`visualViewport.height` and translated by `offsetTop` on every viewport change, so the
composer stays pinned above the on-screen keyboard while only the message log scrolls.

## Security / trust boundary

**The server performs no authentication and no sandboxing.** A connected client can run
arbitrary shell commands as the server user in any workspace directory. The design
assumption is a trusted reverse proxy in front (TLS + authn — mTLS, basic auth, OAuth
proxy, VPN…), with pi-remote bound to `127.0.0.1`. Binding to a public interface
without a proxy is equivalent to a public unauthenticated root-ish shell. The README
carries the loud version of this warning; the default bind address enforces it.

Workspace creation is constrained to a configurable `workspaceRoot` to keep session
cwds organized; this is an organizational guard, not a security boundary (the agent's
bash tool is not chrooted).

## Config surface

Precedence: env > config file > defaults. Config file: `~/.config/pi-remote/config.json`
(override path with `PI_REMOTE_CONFIG`).

| env | file key | default | meaning |
|---|---|---|---|
| `PI_REMOTE_HOST` | `host` | `127.0.0.1` | bind address |
| `PI_REMOTE_PORT` | `port` | `3141` | bind port |
| `PI_REMOTE_WORKSPACE_ROOT` | `workspaceRoot` | `~/pi-workspaces` | where new session workspaces are created/resolved |
| `PI_REMOTE_AGENT_DIR` | `agentDir` | Pi's own (`~/.pi/agent`) | Pi config dir: auth, models, settings, sessions, extensions, skills |
| `PI_REMOTE_DEFAULT_MODEL` | `defaultModel` | Pi settings → first available | `provider/model-id` for new sessions |

Provider credentials are Pi's problem, deliberately: `auth.json`, env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), `models.json`, or provider-registering
extensions — whatever the host's `pi` already uses, pi-remote inherits.

## Testing

Unit tests (vitest) cover the pure seams: config precedence and model-string parsing,
protocol request validation, and SessionHost lifecycle/fan-out against a fake session
factory (attach/detach bookkeeping, multi-client event fan-out, prompt-vs-steer
routing). The end-to-end path (real model, real tool calls, real WS) is exercised by
`spike/concurrent-sessions.mjs` and a live checklist in the README, since it requires a
configured provider.
