# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
