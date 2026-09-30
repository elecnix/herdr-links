# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/elecnix/herdr-links/security/advisories/new). Include the affected version, Herdr version, reproduction steps, and impact when possible.

Do not include credentials, full socket paths, session fingerprints, or unrelated session data. Do not open a public issue until a fix or coordinated disclosure is available.

## Scope

Useful reports include:

- navigation to a target that was not explicitly referenced
- command or shell execution from crafted link content
- bypasses of socket ownership, click-context, source-pane, or target validation
- stale links remaining valid after socket replacement
- unsafe plugin-registration or Pi-instruction mutations
- marketplace build or package-content integrity failures

The plugin runs with the invoking user's permissions and communicates with that user's local Herdr Unix socket. It is not intended to isolate mutually untrusted processes running as the same operating-system user.
