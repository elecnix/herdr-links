# Verification

Herdr Links keeps repeatable verification procedures in the repository and avoids committing live session identifiers, socket fingerprints, machine paths, or plugin logs.

## Automated checks

Run the complete local suite:

```bash
npm test
npm run build
npm run check:package
npm run check:github-install
npm run check:public-content
npm run check:public-history
```

The checks cover:

- strict TypeScript compilation
- navigation URL parsing and malformed-input rejection
- socket ownership, identity, lifetime, framing, and response validation
- exact routing for agents, workspaces, tabs, and panes
- stale source and target rejection before focus
- instruction-file round trips, backups, symlink rejection, and rollback
- GitHub-managed registration provenance
- legacy plugin-ID detection
- exact npm package contents
- a clean GitHub checkout using the manifest's locked build commands
- public-working-tree and reachable-history privacy checks
- Python compatibility-reference tests

GitHub Actions runs the same checks on pull requests and the default branch.

## Manual release checks

A marketplace release should also be tested in an isolated Herdr session:

1. Install from the public GitHub repository with no pre-existing checkout or `dist/` directory.
2. Confirm `herdr-links` is enabled, warning-free, and has `source.kind = "github"`.
3. Invoke `herdr-links.setup`, wait for its exact action log to succeed with exit code 0, and confirm the registration remains GitHub-managed.
4. Reload Pi and generate fresh links for an agent, workspace, tab, and ordinary pane.
5. Control-left-click each rendered link and confirm it focuses the exact target.
6. Confirm stale-session, stale-target, malformed, and wrong-context links do not focus anything.
7. Invoke `herdr-links.cleanup`, wait for its exact action log to succeed with exit code 0, then uninstall the plugin and confirm unrelated Pi instructions are unchanged.
8. Test the documented migration from the legacy `dima.herdr-links` registration when releasing a rename.

The test harness at `tests/live_smoke.py` can exercise focus-changing paths from a detected Pi pane:

```bash
python3 tests/live_smoke.py --run --output /tmp/herdr-links-live-smoke.json
```

Its output may contain session-specific identifiers and should remain outside the repository.

## Compatibility matrix

| Herdr release | Protocol | Link scheme | Status |
|---|---:|---|---|
| 0.9.0 | 22 | `herdr://navigation/v1/...` | Primary supported runtime |
| 0.9.1 through 0.9.3 | 22 | `herdr://navigation/v1/...` | Supported runtime, patch releases of the 0.9 line |
| 0.7.5 | 18 | `https://herdr.invalid/v1/...` | Compatibility runtime |

A version paired with a protocol it was not tested against fails closed until it is reviewed and tested. The 0.9 patch releases share protocol 22 and the same focus methods, so one entry covers them.
