# groupmetoolkit

<!-- setup -->
One-time bootstrap: if no environment hook ran it yet, run
`bash .agents/setup`. Its first successful run makes everything in Agent
config automatic and deletes this notice.
<!-- /setup -->

One paragraph: what an agent working in this repo should know before touching `src/ops.ts` — the tool's domain, and anything not obvious from the layout below.

<!-- tf:agents -->
## Commands

- `npx toolfactory introspect` — resnapshot `dev.toolfactory/ops.json` after editing the operations.
- `npx toolfactory build` — regenerate every generated file after a `dev.toolfactory/tool.json` change.
- `npx toolfactory check` — the drift gate: fails when a generated file or the operation snapshot is stale.
- `npx toolfactory validate` — runs every selected surface's upstream validator.
- `npx toolfactory coverage` — operation × surface verdicts.
- Tests: `npm test`.
- Package manager: npm.

## Layout

- `src/ops.ts` — your operations, the only hand-written source. Everything else here is a
  generated projection of it plus `dev.toolfactory/tool.json`.
- `dev.toolfactory/` — the operation snapshot, coverage verdicts and the generation lock;
  never hand-edit (`toolfactory adopt <path>` first if you must).
- `.agents/` — the agent-config canon: `skills/`, `mcp/servers.json`, `setup`, `sync.py`.
- `hosts/<id>/` — the host-native escape hatch for a selected host; nothing else creates it.

## The boundary

Core logic is a pure function of (JSON arguments, environment/config, filesystem). Anything a
host provides that is not one of those three is not available to core; a host-native shim
converts it into one of them before the call.

## Agent config

Skills and MCP servers live once in `.agents/` — `skills/` and `mcp/servers.json` — and sync
to every harness automatically, in both directions; `CLAUDE.md`, `GEMINI.md` and the
per-harness configs are rendered from there by `.agents/sync.py`. `bash .agents/setup` runs it
and installs the git hooks, so pulls, branch switches and commits re-sync on their own, and a
commit cannot leave a generated file stale (pre-commit also runs `npx toolfactory check`).
Personal-only config: gitignored `.agents/local/`, same shape. Details: `.agents/README.md`.

This tool's own kernel is registered there as `groupmetoolkit`, so an agent developing it can call
the operations it is writing; register nothing by hand.

## Installing into the host you are developing in

- **OpenClaw**: `openclaw plugins install --link hosts/openclaw --force` links the
  checkout in place; `openclaw plugins inspect groupmetoolkit --runtime --json` confirms it loaded.
  `openclaw plugins uninstall groupmetoolkit --keep-files` removes the registration and leaves the checkout.

Codex and Cursor read this file as is; Claude Code and Gemini read `CLAUDE.md` / `GEMINI.md`,
each of which `.agents/sync.py` renders as the one line `@AGENTS.md`.

## Listing

Every install line above already works from this repository alone; these are the curated
directories and marketplaces that additionally *list* it. Each is a one-time human-reviewed
portal step or pull request, run at the author's discretion — never generated, never
automated.

- **Docker MCP Catalog** — PR to `docker/mcp-registry` adding `servers/groupmetoolkit/server.yaml` (`--image ghcr.io/<owner>/groupmetoolkit`): https://github.com/docker/mcp-registry
- **GitHub MCP registry** — manual curation, not automated by publishing to the official registry: https://github.com/github/github-mcp-server/discussions/1257
- **Cline marketplace** — issue on https://github.com/cline/mcp-marketplace
- **mcp.so** — issue on https://github.com/chatmcp/mcpso
- **awesome-mcp-servers** — PR to https://github.com/punkpeye/awesome-mcp-servers

## Reload

Registration is automated; reload is not, and only some harnesses have one.

| Harness | MCP config | Skills and `AGENTS.md` |
|---|---|---|
| Claude Code | Reconnect from `/mcp`, or start a new session: stdio servers are not reconnected automatically. A server's own `list_changed` refreshes its tool list without one. | `.claude/skills/`, symlinked by `sync.py`; no documented mid-session reload. |
| OpenClaw | `openclaw gateway restart`: plugins and MCP config load at Gateway start, and `openclaw mcp reload` only refreshes the current CLI process. | Skills refresh mid-session; the watcher's list is picked up on the next agent turn. `AGENTS.md` is read at session start. |
| Hermes | A new invocation: every run is a fresh process. `/reload-mcp` inside an open session; `hermes gateway restart` is the messaging gateway only. | `hermes skills trust` once in this repo, then a new conversation: the resolved skill directories are stable for a conversation. |
| GSD | `python3 .agents/sync.py --all` renders the shared `.mcp.json` even on a GSD-only machine. Refresh with `mcp_servers(refresh=true)`; start a new session after changing a connected server. Approve `mcp_discover` interactively once before unattended stdio use. | Reads `AGENTS.md` and `.agents/skills/` natively; `/reload` refreshes resources. `--bare` omits them. |
| Gemini CLI | `/mcp reload` | `/memory refresh`; `/skills reload` for skills |
| Codex | Restart: `sync.py install-codex` writes the user-level `~/.codex/config.toml`, read at startup, because a project config applies only once the project is trusted. | Reads `AGENTS.md` and `.agents/skills/` natively. |
| Factory (`droid`) | None: it reloads when `.factory/mcp.json` changes. | Reads `AGENTS.md` natively. |
| VS Code | The per-server Restart control, or `chat.mcp.autostart` (experimental). | Reads `AGENTS.md` and `.agents/skills/` natively. |
| Cursor, Qwen, OpenCode, Kilo, Amp, CodeBuddy | No primary-source reload documentation: assume a restart. | Reads `AGENTS.md` and `.agents/skills/` natively. |

## Worktrees

Use the host's own worktree system; toolfactory creates none and writes nothing outside this
repository.

- **OpenClaw**: `openclaw worktrees create <repo> --name <name>` (state-dir owned, outside the repo).
- **Hermes**: `hermes chat -w <name>` (repo-local `.worktrees/`, gitignored for you).
- **Claude Code**: `claude --worktree <name>` (`.claude/worktrees/`).
- **Cursor**: `agent -w <name>` (`~/.cursor/worktrees/`).

Calling toolfactory over MCP from inside one: pass `root` explicitly. A stdio MCP server gets a
static, config-time working directory, so it cannot tell which worktree you are in.

<!-- /tf:agents -->
