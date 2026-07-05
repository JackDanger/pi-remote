# Live-verification safety

Automated WS/end-to-end verification MUST run against an isolated agent directory,
never the operator's real `~/.pi/agent`. A scratch session created and deleted during
a test shares the same session store as live human sessions; a stray `sessions.delete`
or workspace cleanup can then destroy a real conversation (this happened once).

Before any scripted `session.*` verification, point the server at a throwaway store:

    PI_REMOTE_AGENT_DIR="$(mktemp -d)/agent" \
    PI_REMOTE_WORKSPACE_ROOT="$(mktemp -d)/ws" \
    node dist/main.js   # or the WS probe's own instance

Never target the production `pi-remote@bixby` instance (it hosts live human sessions)
for create/delete verification. Read-only probes (attach, commands.list) against a
scratch session on an isolated instance are fine; destructive ops stay off the real store.
