# Herdr Links

[![Validate marketplace build](https://github.com/dima-m711/herdr-links/actions/workflows/package.yml/badge.svg?branch=main)](https://github.com/dima-m711/herdr-links/actions/workflows/package.yml)

Herdr Links creates secure, session-bound links to agents, workspaces, tabs, and panes in [Herdr](https://herdr.dev). It is designed for reports produced by [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), but any terminal program that renders OSC 8 links can display its output.

## Requirements

- macOS
- Herdr 0.7.5, or any 0.9 release from 0.9.0 through 0.9.3
- Node.js 20 or newer, available whenever Herdr or Pi runs the plugin
- npm, required during installation and updates
- Pi, if you want agents to generate navigation links automatically

## Install

Install the plugin from its public GitHub repository:

```bash
herdr plugin install dima-m711/herdr-links
```

Then start installation of the managed Pi instructions:

```bash
herdr plugin action invoke herdr-links.setup
```

Herdr actions are asynchronous. The invocation returns a `log_id`; before continuing, find that exact entry and require `status: "succeeded"` with `exit_code: 0`:

```bash
herdr plugin log list --plugin herdr-links --limit 20
```

Do not reload Pi after a failed or still-running setup. After setup succeeds, run `/reload` in existing idle Pi sessions, or restart them. Confirm the plugin is enabled and warning-free:

```bash
herdr plugin list --plugin herdr-links --json
```

Herdr clones the repository and runs the locked manifest build: `npm ci` with lifecycle scripts disabled, followed by `npm run build`. Compiled output is generated inside Herdr's managed checkout and is not committed to this repository.

Re-run the install and setup commands to update the plugin, and wait for the new setup log before reloading Pi. Setup replaces a single managed instruction block and preserves the GitHub-managed plugin registration; it never converts that registration into a local link.

## Use

Ask Pi to reference a live Herdr target. The generated Markdown label becomes navigable when rendered in Pi.

**Hold Control and left-click the link, including on macOS.** Herdr must have mouse capture enabled. Ordinary Pi fullscreen clicks and terminal-native link gestures bypass Herdr navigation.

| Reference | Accepted target | Focus operation |
|---|---|---|
| Agent | A detected agent's pane ID | Validate agent membership, then focus the exact pane |
| Workspace | Workspace ID | Focus the workspace and its remembered pane |
| Tab | Tab ID | Focus the tab and its remembered pane |
| Pane | Any live pane ID | Focus the exact pane |

Agent names and `terminal_id` values are not accepted. IDs are opaque, case-sensitive, and session-scoped. Always generate a fresh link after Herdr restarts or a target moves or closes.

Herdr 0.9 links use a private URL scheme:

```text
herdr://navigation/v1/<session-fingerprint>/<agent|workspace|tab|pane>/<public-id>
```

Herdr 0.7.5 uses a reserved HTTPS compatibility form because that release rejects custom schemes:

```text
https://herdr.invalid/v1/<session-fingerprint>/<agent|workspace|tab|pane>/<public-id>
```

## Security model

A link is a narrowly validated focus request, not a command. Before focusing anything, the handler validates:

- the complete URL and target-ID grammar
- the invoking plugin, action, link handler, and source-pane context
- the user-owned Herdr Unix socket and its current lifetime fingerprint
- the supported Herdr version/protocol pair
- the live source pane and requested target
- agent membership for agent links
- the response identity, type, and shape of every socket request

The handler then sends one allowlisted focus API call. It does not invoke a shell, interpolate link content into commands, send terminal input, close panes, move layouts, register agents, or change zoom. Query strings, fragments, credentials, ports, percent encoding, controls, extra path segments, shell punctuation, unknown actions, and terminal IDs are rejected.

The fingerprint is a lifetime marker derived from the resolved socket's path and metadata; it is not an authentication secret. The plugin is not a security boundary against another process running as the same operating-system user, because that process already has access to the user's Herdr socket. The runtime makes no HTTP requests.

The gate accepts Herdr 0.9.0 through 0.9.3 on protocol 22, and Herdr 0.7.5 on protocol 18. A version paired with any other protocol fails closed until it has been reviewed and tested.

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

Do not uninstall after a failed or still-running cleanup: removing the managed checkout first can leave Pi instructions pointing to missing files. Reload or restart existing Pi sessions afterward. Cleanup removes only the managed Herdr Links block. Unrelated instructions and its non-overwritten pre-edit backups remain.

### Migrating from the private 0.3 prerelease

The old prerelease used plugin ID `dima.herdr-links` and a local/npm registration. Remove it before installing the public plugin:

```bash
herdr-links uninstall
herdr plugin install dima-m711/herdr-links
herdr plugin action invoke herdr-links.setup
```

Do this before replacing the old globally installed package. If the package was already replaced in place, recover with:

```bash
herdr-links migrate
herdr-links uninstall
herdr plugin install dima-m711/herdr-links
herdr plugin action invoke herdr-links.setup
```

Migration removes the legacy registry key through Herdr's CLI, links and verifies the renamed local manifest, and refreshes the managed Pi instructions. It refuses GitHub-managed or ambiguous registrations.

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
