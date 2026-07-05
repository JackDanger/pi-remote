# Running pi-remote against the JackDanger/pi fork

pi-remote depends on the `@earendil-works/pi-coding-agent` engine. Two engine
features live only in the fork (`JackDanger/pi`, branch `jackdanger/working`)
and are not yet published to npm:

- **`compaction_progress` session event + `AgentSession.compactionState`** — live
  compaction progress (`{ reason, tokensSoFar, elapsedMs }`) and a queryable
  in-flight state for clients that reattach mid-compaction. Also surfaced in the
  RPC `get_state` snapshot as `compactionState`.
- **Root re-export of `configureHttpDispatcher`** (and `DEFAULT_HTTP_IDLE_TIMEOUT_MS`,
  `parseHttpIdleTimeoutMs`, `formatHttpIdleTimeoutMs`, `HTTP_IDLE_TIMEOUT_CHOICES`,
  `applyHttpProxySettings`) from the package public API, so `src/http-dispatcher.ts`
  no longer needs the `node_modules`-walking `createRequire` hack.

## Why the wiring is on a branch, not on `main`

`main` keeps the registry dependency `@earendil-works/pi-coding-agent@^0.80.3`, and
prod (`/opt/pi-remote`) deploys `main` via `npm ci && npm run build`. The published
0.80.3 does **not** export `configureHttpDispatcher` from the package root, so the
simplified `src/http-dispatcher.ts` only builds/runs against the fork. Putting the
fork dependency (or the simplified source) on `main` would break a fresh prod
`npm ci` build. The integrated stack therefore lives on the
**`jackdanger/fork-integration`** branch until the engine change ships.

## Building the fork engine and packing it

```bash
cd /home/bixby/src/pi
git checkout jackdanger/working
npm install --ignore-scripts        # first time only
npm run build                       # builds tui, ai, agent, coding-agent, orchestrator
cd packages/coding-agent
npm pack --ignore-scripts           # -> earendil-works-pi-coding-agent-0.80.3.tgz
```

## Wiring pi-remote to the packed fork (already done on the branch)

The `jackdanger/fork-integration` branch vendors that tarball at
`vendor/earendil-works-pi-coding-agent-0.80.3.tgz` and points the dependency at it:

```json
"@earendil-works/pi-coding-agent": "file:vendor/earendil-works-pi-coding-agent-0.80.3.tgz"
```

To refresh the vendored engine after changing the fork:

```bash
cd /home/bixby/src/pi/packages/coding-agent && npm pack --ignore-scripts
cp earendil-works-pi-coding-agent-0.80.3.tgz \
   /home/bixby/src/pi-remote/vendor/earendil-works-pi-coding-agent-0.80.3.tgz
cd /home/bixby/src/pi-remote
npm install    # re-hydrates node_modules from the tarball, updates package-lock
npm run build && npm test
```

Because the tarball is committed, a fresh `npm ci` on the branch is reproducible
(no sibling checkout of the fork required).

## Deploying the integrated stack to prod (do this later, deliberately)

Prod is intentionally left on the npm-based 0.80.3 build. When ready to deploy the
integrated stack:

1. Publish the fork engine (preferred long-term): bump the fork version to a
   distinguishable tag (e.g. a prerelease or a scoped package), publish it, then set
   pi-remote `main`'s dependency to that version and drop the vendored tarball. This
   restores a clean registry-based `npm ci` everywhere.
2. Or deploy the branch as-is: on `/opt/pi-remote`, check out
   `jackdanger/fork-integration`, `npm ci && npm run build`, then restart the
   `pi-remote@bixby` service. The vendored tarball makes this self-contained.

Either way, coordinate the restart — a live session runs on the current prod build.
