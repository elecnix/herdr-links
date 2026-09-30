# Herdr Links

[![Validate marketplace build](https://github.com/elecnix/herdr-links/actions/workflows/package.yml/badge.svg?branch=main)](https://github.com/elecnix/herdr-links/actions/workflows/package.yml)

Herdr Links creates secure, session-bound links to agents, workspaces, tabs, and panes in [Herdr](https://herdr.dev). An agent that renders OSC 8 links can display them, so reports from [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and Claude Code both become navigable.

Beyond upstream, this fork accepts the whole Herdr 0.9 line on protocol 22, versions 0.9.0 through 0.9.3, instead of one runtime pair, so a Herdr patch release does not stop link generation or navigation. It also installs instructions for Claude Code alongside Pi instead of Pi alone.

## Requirements

- macOS
- Herdr 0.7.5, or any 0.9 release from 0.9.0 through 0.9.3
- Node.js 20 or newer, available whenever Herdr, Pi, or Claude Code runs the plugin
- npm, required during installation and updates
- Pi or Claude Code, if you want agents to generate navigation links automatically

The `setup` action writes one managed block to each agent it finds: `~/.pi/agent/AGENTS.md` for Pi, and `~/.claude/CLAUDE.md` for Claude Code (or `<CLAUDE_CONFIG_DIR>/CLAUDE.md` when that variable sets an absolute path). Both blocks contain the same text. `cleanup` removes both.

## Install

Install the plugin from its public GitHub repository:

```bash
herdr plugin install elecnix/herdr-links
```

Then start installation of the managed agent instructions:

```bash
herdr plugin action invoke herdr-links.setup
```

Herdr actions are asynchronous. The invocation returns a `log_id`; before continuing, find that exact entry and require `status: "succeeded"` with `exit_code: 0`:

```bash
herdr plugin log list --plugin herdr-links --limit 20
```

Do not reload an agent after a failed or still-running setup. After setup succeeds, run `/reload` in existing idle Pi sessions, or restart them. Confirm the plugin is enabled and warning-free:

```bash
herdr plugin list --plugin herdr-links --json
```

Herdr clones the repository and runs the locked manifest build: `npm ci` with lifecycle scripts disabled, followed by `npm run build`. Compiled output is generated inside Herdr's managed checkout and is not committed to this repository.

Every command in the manifest runs through a login shell, as in `/bin/sh -lc "node ./dist/cli.js handle"`. Herdr spawns plugin commands with a minimal `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin`, which omits the directories a version manager or Homebrew installs `node` into. A bare `node` argv entry then fails with ENOENT, and every action logs `No such file or directory (os error 2)` while Herdr falls back to its own handling. The login shell reads the user profile, which puts `node` back on `PATH`. `scripts/check-package.mjs` fails the build if a `node` or `npm` command stops going through a login shell.

Re-run the install and setup commands to update the plugin, and wait for the new setup log before reloading an agent. Setup replaces a single managed instruction block in each agent's file and preserves the GitHub-managed plugin registration; it never converts that registration into a local link.

## Use

Ask the agent to reference a live Herdr target. The generated Markdown label becomes navigable when rendered in Pi or Claude Code.

**Hold Control and left-click the link, including on macOS.** On macOS, Command-click belongs to the outer terminal, so it opens a browser while Herdr never sees the click. Herdr must have mouse capture enabled. A fullscreen agent UI may consume the click. Holding Control over a link underlines it, which is a useful way to check that Herdr sees the link before you click it.

| Reference | Accepted target | Focus operation |
|---|---|---|
| Agent | A detected agent's pane ID | Validate agent membership, then focus the exact pane |
| Workspace | Workspace ID | Focus the workspace and its remembered pane |
| Tab | Tab ID | Focus the tab and its remembered pane |
| Pane | Any live pane ID | Focus the exact pane |

Agent names and `terminal_id` values are not accepted. IDs are opaque, case-sensitive, and session-scoped. Always generate a fresh link after a target moves or closes.

Herdr 0.9 links use a private URL scheme:

```text
herdr://navigation/v1/[<session-fingerprint>/]<agent|workspace|tab|pane>/<public-id>
```

Herdr 0.7.5 uses a reserved HTTPS compatibility form because that release rejects custom schemes:

```text
https://herdr.invalid/v1/[<session-fingerprint>/]<agent|workspace|tab|pane>/<public-id>
```

The session fingerprint is optional. When present, it binds the link to the socket which minted it, and the handler refuses the link once Herdr recreates that socket. When absent, the handler skips that comparison, which lets an agent write the link with no tool call. The fingerprint hashes the socket file alone, its path, inode, and change time, so tab, pane, and focus churn leaves it unchanged. Only a socket recreation makes it stale. Omitting it costs the cross-session binding and nothing else, since Herdr never reuses a closed tab or pane ID and every ID includes its workspace prefix, so a stale link fails instead of focusing the wrong place.

## Security model

A link is a narrowly validated focus request, not a command. Before focusing anything, the handler validates:

- the complete URL and target-ID grammar
- the invoking plugin, action, link handler, and source-pane context
- the user-owned Herdr Unix socket, and its lifetime fingerprint when the link carries one
- the supported Herdr version/protocol pair
- the live source pane and requested target
- agent membership for agent links
- the response identity, type, and shape of every socket request

The handler then sends one allowlisted focus API call. It does not invoke a shell, interpolate link content into commands, send terminal input, close panes, move layouts, register agents, or change zoom. Query strings, fragments, credentials, ports, percent encoding, controls, extra path segments, shell punctuation, unknown actions, and terminal IDs are rejected.

The fingerprint is a lifetime marker derived from the resolved socket's path and metadata; it is not an authentication secret. The plugin is not a security boundary against another process running as the same operating-system user, because that process already has access to the user's Herdr socket. The runtime makes no HTTP requests.

Only the 0.9 line on protocol 22, versions 0.9.0 through 0.9.3, and Herdr 0.7.5 on protocol 18 are accepted. A version paired with any other protocol fails closed until it has been reviewed and tested.

## Uninstall

Start cleanup while the plugin is still enabled:

```bash
herdr plugin action invoke herdr-links.cleanup
```

Wait for the returned `log_id` to reach `status: "succeeded"` with `exit_code: 0`:

```bash
herdr plugin log list --plugin herdr-links --limit 20
```

Only after that exact cleanup log succeeds, uninstall the GitHub-managed plugin:

```bash
herdr plugin uninstall herdr-links
```

Do not uninstall after a failed or still-running cleanup: removing the managed checkout first can leave agent instructions pointing to missing files. Reload or restart existing sessions afterward. Cleanup removes only the managed Herdr Links block. Unrelated instructions and its non-overwritten pre-edit backups remain.

### Migrating from the private 0.3 prerelease

The old prerelease used plugin ID `dima.herdr-links` and a local/npm registration. Remove it before installing the public plugin:

```bash
herdr-links uninstall
herdr plugin install elecnix/herdr-links
herdr plugin action invoke herdr-links.setup
```

Do this before replacing the old globally installed package. If the package was already replaced in place, recover with:

```bash
herdr-links migrate
herdr-links uninstall
herdr plugin install elecnix/herdr-links
herdr plugin action invoke herdr-links.setup
```

Migration removes the legacy registry key through Herdr's CLI, links and verifies the renamed local manifest, and refreshes the managed agent instructions. It refuses GitHub-managed or ambiguous registrations.

## Develop locally

```bash
npm ci
npm test
npm run build
npm run check:package
npm run check:github-install
npm run check:public-content
npm run check:public-history
```

Build before linking a development checkout:

```bash
npm run build
./bin/herdr-links install
```

`bin/herdr-links` executes only the compiled TypeScript runtime and fails with a build instruction when `dist/` is absent. Local install/uninstall commands retain compensating rollback behavior and refuse to replace another checkout. Marketplace users should use the setup/cleanup actions instead.

The Python implementation under `reference/python/` is test-only compatibility material. The manifest, wrapper, and package never fall back to Python.

See [CONTRIBUTING.md](CONTRIBUTING.md) for validation expectations and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
