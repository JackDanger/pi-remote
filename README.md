# pi-remote

Run [Pi](https://github.com/earendil-works/pi) coding-agent sessions on a server and
drive them from your phone.

pi-remote is a persistent server that hosts any number of concurrent Pi agent
sessions — each with real tools (`read`, `write`, `edit`, `bash`) executing on the
server against real workspace directories — plus a mobile-first web frontend connected
over WebSocket. It is to Pi what "Claude Code running on a server, remotely connected
from the app" is to Claude Code: the agent lives where the code lives; the client is
just a thin live view.

Open it in a browser → see your sessions → create a new one or resume an old one →
prompt, watch tool calls stream, steer mid-run, switch models — everything a local
`pi` gives you, from anywhere.

```
 phone / laptop browser
        │  HTTPS + WSS          ← TLS + auth happen HERE (reverse proxy)
        ▼
 reverse proxy (nginx / Nginx Proxy Manager / caddy / tailscale serve)
        │  plain HTTP + WS on localhost
        ▼
 pi-remote  ──  SessionHost ── many concurrent Pi AgentSessions (SDK, in-process)
        │
        ▼
 real workspace dirs + ~/.pi/agent/sessions/*.jsonl (Pi's own persistence)
```

## SECURITY — read this first

**pi-remote performs NO authentication and NO sandboxing.** Anyone who can reach its
port can execute arbitrary shell commands as the user running the server. By design it
binds to `127.0.0.1` and trusts an upstream reverse proxy to provide TLS and
authentication (mTLS, OAuth proxy, basic auth, VPN, tailnet — your choice).

**Never bind it to a public interface without an authenticating proxy in front.**
`PI_REMOTE_HOST=0.0.0.0` on an open network is a public unauthenticated remote shell.

## Quickstart

Requires Node 20+ and a working `pi` setup (any provider Pi supports — the sessions
inherit your existing `~/.pi/agent` auth, models, settings, extensions, and skills).

```bash
git clone https://github.com/JackDanger/pi-remote.git
cd pi-remote
npm install
npm run build
npm start
```

Open http://127.0.0.1:3141 — create a session, say hello, watch the agent run tools.

To reach it from your phone, put it behind a reverse proxy with auth (below), or for a
quick personal setup on a tailnet:

```bash
tailscale serve 3141
```

## What works inside a hosted session

Each session is created through Pi's own SDK with Pi's `DefaultResourceLoader`, so a
hosted session behaves like a local `pi` run in that workspace:

- full coding tools executing server-side: `read`, `bash`, `edit`, `write`
- session persistence: Pi's normal JSONL sessions — survive server restarts, resumable
  from the session list (and visible to `pi` on the same machine)
- your global + project extensions (including provider-registering extensions),
  skills, prompt templates, and `AGENTS.md` context files
- model switching and thinking levels, per session, live
- steering: send a message while the agent is running to redirect it
- multiple viewers: attach the same session from several devices at once; every
  client receives the same event stream

## The web app

The bundled frontend is built for one-handed phone use (iOS Safari first):

- installable as a home-screen PWA (standalone display, safe-area aware, keyboard
  avoidance via the VisualViewport API)
- streamed markdown rendering — code blocks with copy buttons, lists, tables — plus
  collapsible thinking blocks and tool calls as expandable cards (args, live output,
  colored diffs, "show all" for long results)
- photo/camera attachments, downscaled client-side and sent with the prompt
- stop / steer-now / queue-after-done controls while the agent runs
- a live status bar above the composer: what the agent is doing right now (waiting /
  thinking / writing / which tool is running), elapsed turn time, live tokens/sec,
  tokens generated, and TTFT while it runs; after the turn, a one-line summary
  (tokens, tok/s, TTFT, prompt size, cache-hit %) — fed by `session_telemetry` pushes
  (see Observability)
- session rename, model picker, and thinking level in a per-session sheet (the header
  chip shows the active model and thinking level at all times)
- aggressive reconnect: exponential backoff, instant retry on foregrounding, and
  automatic session re-resume after a server restart — a dropped connection mid-run
  recovers to the live stream

## Configuration

Environment variables override the config file
(`~/.config/pi-remote/config.json`, or the path in `PI_REMOTE_CONFIG`):

| env var | file key | default | meaning |
|---|---|---|---|
| `PI_REMOTE_HOST` | `host` | `127.0.0.1` | bind address (see SECURITY) |
| `PI_REMOTE_PORT` | `port` | `3141` | bind port |
| `PI_REMOTE_WORKSPACE_ROOT` | `workspaceRoot` | `~/pi-workspaces` | where new session workspaces are created; relative workspace names resolve under it |
| `PI_REMOTE_AGENT_DIR` | `agentDir` | `~/.pi/agent` | Pi config dir (auth.json, models.json, settings.json, sessions/, extensions/, skills/) |
| `PI_REMOTE_DEFAULT_MODEL` | `defaultModel` | Pi settings default, else first available | `provider/model-id` for new sessions |
| `PI_REMOTE_SHUTDOWN_GRACE_MS` | `shutdownGraceMs` | `120000` | on SIGTERM/SIGINT, how long to wait for in-flight agent turns to finish before force-stopping them |
| `PI_REMOTE_TELEMETRY` | `telemetry` | `true` | Prometheus `/metrics` endpoint + structured per-turn JSON logs (see Observability) |

Example `config.json`:

```json
{
  "port": 3141,
  "workspaceRoot": "~/code",
  "defaultModel": "anthropic/claude-sonnet-4-5"
}
```

### Providers

pi-remote adds no provider configuration of its own — it reads whatever the host's Pi
uses, in Pi's normal priority order: `auth.json` credentials, environment variables
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), custom models in `models.json`, and
extensions that call `pi.registerProvider(...)` (self-hosted OpenAI-compatible
endpoints work this way). If `pi` works in a terminal on the server, pi-remote works
with the same models.

## Observability

### `GET /metrics` — Prometheus

Plaintext Prometheus exposition, no auth (like `/healthz` — the reverse proxy gates
external access; scrape it from inside the trust boundary). A "turn" is one full agent
run: prompt accepted → `agent_end`, which may span several model calls when tools run.
Token figures come from the Pi SDK's per-assistant-message `usage`
(`input` = fresh prompt tokens, `cacheRead` = prompt tokens served from the provider
cache, `output` = generated tokens), summed across the turn.

| metric | type | labels | meaning |
|---|---|---|---|
| `pi_remote_turn_prompt_tokens_total` | counter | `model` | fresh (uncached) prompt tokens processed |
| `pi_remote_turn_cached_tokens_total` | counter | `model` | prompt tokens served from the provider cache |
| `pi_remote_turn_completion_tokens_total` | counter | `model` | tokens generated |
| `pi_remote_turn_ttft_seconds` | histogram | `model` | prompt accepted → first streamed assistant content event |
| `pi_remote_turn_duration_seconds` | histogram | `model` | prompt accepted → `agent_end` |
| `pi_remote_turn_cache_hit_ratio` | histogram | `model` | per turn: `cacheRead / (cacheRead + input)` — 1.0 = whole prompt cached |
| `pi_remote_turns_total` | counter | `model`, `outcome` | completed turns; `outcome` ∈ `ok` \| `error` \| `aborted` |
| `pi_remote_live_sessions` | gauge | — | sessions hosted in-process |
| `pi_remote_streaming_sessions` | gauge | — | sessions currently running a turn |

`model` is `provider/model-id` as reported by the model that actually answered, so
label cardinality is bounded by the models you use; session ids never become labels.

### Structured per-turn logs

One JSON object per line on stdout (journald-friendly, ready to ship to Loki).
High-cardinality values (session ids) live in the log body, never in metric labels.

```json
{"ts":"…","event":"prompt","session_id":"…","model":"solvency/qwen-fast","kind":"prompt|steer|followup"}
{"ts":"…","event":"first_token","session_id":"…","model":"…","turn_seq":1,"ttft_ms":87919}
{"ts":"…","event":"model_switch","session_id":"…","from":"a/b","to":"c/d"}
{"ts":"…","event":"turn","session_id":"…","model":"…","turn_seq":1,"prompt_tokens":5438,"cached_tokens":0,"completion_tokens":27,"ttft_ms":87919,"duration_ms":88831,"tokens_per_sec":29.61,"outcome":"ok"}
```

`tokens_per_sec` is `completion_tokens` over the time from first token to `agent_end`
(tool execution time included, so it understates pure decode speed on tool-heavy
turns); it is `null` when no tokens streamed. Set `PI_REMOTE_TELEMETRY=false` to
disable both the endpoint and the logs.

### Live telemetry in the UI

The same turn accounting feeds the browser status bar. Clients attached to a session
receive `{ "type": "session_telemetry", "sessionId", "telemetry" }` pushes carrying a
compact snapshot: `phase` (`waiting` | `responding` | `idle`), `turnSeq`, `model`,
`elapsedMs`, `ttftMs`, `promptTokens`, `cachedTokens`, `completionTokens`,
`tokensPerSec`, `cacheHitRatio`, and `outcome` (set once the turn ends). Snapshots are
pushed on turn start, first token, each assistant `message_end`, turn end, and at most
every 500 ms during streaming. Between usage reports, `completionTokens` includes an
estimate from streamed characters (~4 chars/token) that snaps to the provider-reported
count at each `message_end`. `session.attach` returns the latest snapshot as a
`telemetry` field, so a reconnecting client shows stats immediately. Disabling
telemetry also disables these pushes — the status bar then falls back to activity
labels without numbers.

## Deployment

### systemd

`deploy/pi-remote.service` is a template (adjust paths, user, and environment):

```bash
sudo cp deploy/pi-remote.service /etc/systemd/system/pi-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-remote
```

Put provider API keys in `~/.config/pi-remote/env` (referenced via `EnvironmentFile=`)
rather than in the unit file.

### Graceful restarts

On `SIGTERM`/`SIGINT` (what `systemctl restart`/`stop` sends) pi-remote drains instead
of dying: it immediately stops accepting new connections and new work
(`sessions.create`/`prompt`/`steer`/`followup` get a "server is shutting down" error),
waits for every in-flight agent turn to finish — clients already attached keep
receiving events through the end of their turn — then exits. If a turn is still
running after `PI_REMOTE_SHUTDOWN_GRACE_MS` (default 2 minutes) it is force-stopped
and the session id logged; sessions persist as JSONL either way and are resumable
after restart. A second signal forces immediate exit.

The unit ships with `TimeoutStopSec=150`; keep it **greater than the grace period**
(grace + margin), otherwise systemd SIGKILLs the process mid-drain and running turns
are lost anyway. If you raise `PI_REMOTE_SHUTDOWN_GRACE_MS`, raise `TimeoutStopSec`
to match.

### Reverse proxy

Any proxy works; it must terminate TLS, enforce auth, and pass WebSocket upgrades for
`/ws`. Notes for Nginx Proxy Manager (and raw nginx) including mTLS and subpath
hosting: [deploy/reverse-proxy.md](deploy/reverse-proxy.md).

## Protocol

One WebSocket at `/ws`. Client sends `{ id, type, ...params }`, server answers
`{ id, ok, result | error }`; agent activity is pushed as
`{ type: "session_event", sessionId, event }` where `event` is Pi's own
`AgentSessionEvent`, unmodified. Requests:

`sessions.list` · `sessions.create` · `sessions.resume` · `sessions.delete` ·
`session.attach` · `session.detach` · `session.prompt` · `session.steer` ·
`session.followup` · `session.abort` · `session.set_model` · `session.set_thinking` ·
`session.rename` · `models.list` · `ping`

`session.prompt`/`steer`/`followup` accept an optional
`images: [{ data, mimeType }]` array (base64, `image/*`, max 8 per message) for
photo attachments; `sessions_changed` is broadcast to every client when a session
is created, deleted, or renamed; `session_telemetry` pushes a live turn snapshot to
attached clients (see Observability → Live telemetry in the UI).

Any WebSocket client can drive it — the bundled web app is just one consumer. See
[DESIGN.md](DESIGN.md) for the architecture and the decisions behind it.

## Development

```bash
npm run build   # type-check server + web, bundle frontend
npm test        # vitest: config, protocol, session-host lifecycle/fan-out
```

## License

MIT
