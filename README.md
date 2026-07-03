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
`models.list`

Any WebSocket client can drive it — the bundled web app is just one consumer. See
[DESIGN.md](DESIGN.md) for the architecture and the decisions behind it.

## Development

```bash
npm run build   # type-check server + web, bundle frontend
npm test        # vitest: config, protocol, session-host lifecycle/fan-out
```

## License

MIT
