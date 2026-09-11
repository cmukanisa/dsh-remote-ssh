# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-09-11

### Added

- **Tailscale transport.** A profile may set `transport: tailscale`, which runs
  `tailscale ssh -- <ssh options> <destination> <command>` instead of plain `ssh`:
  MagicDNS resolution, reachability through `tailscaled` (so it works in
  userspace-networking mode), and host-key verification against the key the
  coordination server advertises. Access is then governed by tailnet ACLs rather
  than by SSH keys on disk.
- **Tailnet peer picker.** The connect form lists the tailnet's peers from
  `tailscale status --json`; one click fills the MagicDNS name, the tailnet user,
  and the Tailscale transport when the peer runs the Tailscale SSH server.
- **Honest transport reporting.** A MagicDNS name or `100.64/10` address is shown
  as a tailnet destination (🌐) but connects through plain OpenSSH unless the
  profile asks otherwise (⚡). Deployment over the tailnet was already possible and
  is unchanged.
- **Preflight for offline peers.** A peer Tailscale reports as offline is named
  before the attempt, instead of surfacing as a connect timeout.

### Fixed

- **A failed probe no longer blames the wrong thing.** Every probe failure used to
  be reported as "this host does not answer as a POSIX system", including a DNS
  typo, a rejected key, or an unreachable network. Transport failures now keep
  their own message, and only a shell-dialect failure earns the POSIX refusal.
- **The Tailscale client was invoked as an argument of `ssh`.** In Tailscale mode
  the connector binary is the Tailscale client; a password wraps it (`sshpass -e
  tailscale ssh -- …`), never the other way round.
- **One argv builder.** `ctx.shell` and `ctx.subprocess` no longer assemble the
  wrapper prefix themselves, so a second transport does not mean a second copy of
  that logic.

## [0.1.0] — 2026-09-11

First working release.

### Added

- **Host capability** — `ctx.fs`, `ctx.shell`, and `ctx.subprocess` providers that
  serve local paths with the shipped sandboxed implementations and mirrored
  remote paths over SSH.
  - filesystem: `resolve`, `stat`, `lstat`, `readText`, `streamText`, `readBytes`,
    `readByteRange`, `listDir`, `writeText`, `editText`, `fileUrl`, `contains`,
    with the local backend's error taxonomy and version guards;
  - shell: foreground and background execution through the shipped executor's
    `runArgv`/`startArgv` extension points, so timeouts, output caps, spill files,
    and managed-range teardown are unchanged;
  - subprocess: the same managed range, routed, which is what makes `glob` and
    `grep` work remotely.
- **Connection registry** (`ctx.remoteSsh`) — durable profiles, several hosts at
  once, per-host local mirrors, and a remote directory browser.
- **Browser surface** — the workspace chooser (local machine or SSH), a sidebar
  launcher, and the Settings → Plugins card that switches the subsystem on.
- **Remote namespace** — the `sshWorkspace` Typert Remote service
  (`status`, `setEnabled`, `connect`, `test`, `disconnect`, `list`,
  `makeDirectory`, `adopt`).
- **Installer** — `install.sh` / `install.mjs`, idempotent, leaving the plugin
  switched off so the harness asks to be activated.
- **Tests and CI** — parser, unit, installer, Windows-client, filesystem E2E,
  harness E2E, and Windows-server-refusal suites; workflows for CI, E2E across
  Linux/macOS/Windows servers, portability, CodeQL, and release.

### Fixed during development

- **Remote files were written write-only.** `chmod` received the permission bits
  as a decimal number (`chmod 420` instead of `chmod 644`), because `stat` prints
  them as octal *digits*. Both the parse and the emission are now octal.
- **`ControlPath too long`.** OpenSSH `fatal()`s rather than truncating at the
  `AF_UNIX` limit (104 bytes). A too-long socket directory now falls back to a
  short hash-named one under the temp root.
- **Double routing.** The shell executor's own `ssh` child was intercepted by the
  subprocess router, which wrapped the transport in a second transport. The local
  child now runs from a scratch directory outside every mirror.

### Known limitations

- POSIX servers only; a Windows OpenSSH server is refused with an explicit message.
- Remote commands are unconfined (the SSH account is the boundary). The remote
  *filesystem* fence is enforced.
- `glob` and `grep` require `ripgrep` on the server.
- No remote file watching.
