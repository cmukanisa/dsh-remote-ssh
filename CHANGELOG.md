# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-11

### Added

- **Detached remote work**: a command can keep running on the host after you close
  the harness. Work started through the plugin is written as a small launcher on
  the server, detached with `setsid`/`nohup`, and logged there; one durable record
  per run lives in `$DSH_HOME/remotes-sessions.json`. Reopening the harness shows
  every run's **live state** — running, finished with its exit code, or gone — with
  its latest output, and each one can be **stopped** with a process-group signal.
  The Settings card grows a *Remote work* panel: live rows, a Stop per running run,
  Refresh, and Forget-finished.
  - Verified end to end against a real host: start a 150-second command, kill the
    harness process, confirm the remote process is still alive, restart the
    harness, and read it back as *running* — then stop it.
  - The **agent loop** cannot outlive the harness: the model turn runs in-process.
    What survives is the work it started, which is what the panel shows.
- `setsid` capability detection in the host probe, so a run gets its own signalable
  process group when the host can give it one.

### Fixed

- **A row exported without `default` failed the whole composition at boot.** The
  sessions module exported its class only as a named export, so the loader saw a
  module namespace with no `apply`. The installer's verification now imports every
  row from where the loader will and asserts the shape the loader requires — a
  function or an object with `apply` — which catches this before a boot does.

## [Unreleased]

### Fixed

- **The installer said "reload the page" after an upgrade that a running harness
  cannot see.** 0.3.0 renamed the browser package (`@deepseek-ai/dsh-remote-ssh-ui`
  → `dsh-remote-ssh-ui`); a harness started before the re-install keeps the name
  it read at boot in its client-module table and serves the new bundle under the
  old id, so every page load failed with `Failed to load plugins … loaded without
  registering "@deepseek-ai/dsh-remote-ssh-ui"`. Nothing on disk was wrong, and
  the closing line pointed at the one action that could not help. The installer
  now compares the installed copy with what it writes: a renamed package or a
  changed host half (every file but the bundle, `package.json` beyond its
  version included; a `--link` install, being the checkout itself, always
  counts) is reported as a warning, and the closing line says **restart the
  harness**. A bundle-only change still says reload; `--dry-run` previews the
  verdict; an unreadable installed file counts as changed rather than failing
  the install. The installer also knocks on the harness port (`--harness-port`,
  default 3080; no process table is read, the unauthenticated `401` that names
  `dsh web` is the fingerprint, under a hard one-second deadline) so that line
  names the running `dsh web`, says none answered, or says what answers is not
  `dsh web`. Covered by `test/install.test.mjs` with stand-in servers for each
  half of the fingerprint, a silent listener and an endless body; the README and
  the three documentation pages describe the cases, the flag, and the symptom.
- **`--link` on a fresh harness home failed with `ENOENT` on the symlink**: the
  copy path creates `profiles/plugins`, the link path did not. Found by the new
  `--link` test.

### Added

- **The interface is localized in English, French, and Chinese**, following the
  browser's language. Every displayed string is a key in the three dictionaries the
  plugin registers with `ctx.locale`; `scripts/check-syntax.mjs` fails if a key is
  missing from a locale, unused in the bundle, or if a literal reaches the DOM.
- **A documentation site in the same three languages** (`docs/`, published with
  GitHub Pages, no build step): what the plugin does, requirements, installation,
  use, Tailscale, updating, troubleshooting, and the known limits. A landing page
  detects the browser language; every page cross-links to the other two.
- **A documentation gate** (`npm run check:docs`): the three pages exist, declare
  their language, cross-link, keep the install section, have no dead internal link,
  and pull no third-party resource.

### Changed

- **The README leads with Install, then Requirements**, and the reasoning lives
  further down: what a reader needs first is how to get it and what it needs.

## [0.2.1] — 2026-09-11

### Changed

- **Installing activates the plugin.** It used to install dormant and ask you to
  flip the switch in Settings; installing it *is* the decision. `--keep-off`
  installs it dormant for a rollout where activation is audited separately, and
  `--enable` is the only thing that overrides an existing `remote-ssh.enabled`.
- **The run is a transaction, and anything short of a fully verified install is
  rolled back.** The composition layer, the settings document, and any package
  already installed are snapshotted before the first write; a failed copy, a failed
  write, or a failed check restores every path and says *Installation cancelled.
  Nothing was left half-applied.* A half-installed plugin is worse than none: the
  loader would boot a profile whose composition disables the shipped providers
  without registering the replacements.
- **The output is a report, in four visible phases** — `checking`, `installing`,
  `verifying`, `done` — with one aligned row per check and a dotted leader to its
  result, a header that credits the author, and a closing line that says what to do
  next. Colour and box-drawing are used only when the terminal supports them:
  `NO_COLOR`, `TERM=dumb`, `--no-color`, and a non-terminal stdout all fall back to
  plain text and an ASCII glyph set. `install.sh` prints one compact line and
  leaves the banner to `install.mjs`, so `curl | sh` shows one header, not two.

### Added

- **Requirement checks before any write**, each with the command that fixes it:
  Node in the harness's range, an OpenSSH client, a harness home, a writable
  destination, and the harness module tree reachable from where the packages will
  sit. Tailscale is reported as available or absent.
- **Post-install verification**, including a real `import()` of `registry.js` from
  the installed path — exactly what the Cordis loader does at the next boot. A
  truncated copy, a lost export, or an unreachable `@deepseek-ai/dsh-*` dependency
  now fails in the installer, where the message can still be actionable.
- `--no-color`, a `tailscale` row in the prerequisites, and an **Author** section
  in the README crediting Christian Kasse (@cmukanisa).

### Fixed

- **A re-install claimed to be waiting for an activation it already had.** Once
  `remote-ssh.enabled` existed, every later run printed "waiting for activation"
  regardless of its value, so a working installation read as broken. The installer
  reads the stored value and reports it.
- **`--help` printed the harness line**, which belongs to a real run.

### Fixed (0.2.1, continued)

- **The plugin failed to load, blanking the whole UI.** A `single` slot refuses a
  second registration at the *same* priority instead of shadowing it, and the
  refusal propagates out of `apply()` — so the browser showed
  *"Failed to load plugins"* and none of this plugin's surface, or any other
  plugin's, appeared. The shipped directory picker registers into the workspace
  holes at the default priority 0; the chooser now asks for -1, which is what the
  slot system's own message asks for ("register at a different priority to shadow
  it, lowest renders").
- **One contested slot can no longer unload the plugin.** Every registration goes
  through a guarded helper, so a hole occupied at an unexpected priority leaves the
  sidebar launcher and the Settings card working instead of taking the rest of the
  plugin down with it.
- **The local half of the workspace flow is now the plugin's own.** Occupying the
  hole means owning the whole dialog, so there is an in-app local browser built on
  `directoryPicker.list`/`createDirectory`, beside a "Système…" button for the OS
  chooser. A deployment that composes only one of the two backends still gets a
  working local flow.

### Verified

- **The browser half hot-reloads without restarting or refreshing.** Replacing the
  installed `client.js` changes the revision `dsh-client-modules` serves — asserted
  against a running harness, not assumed — because `dsh-client-hmr` polls the
  bundle artifacts. A page reload is still needed for the *page*, but the plugin
  does not need a process restart. (The host half is ESM-cached by Node, so a
  change to `lib/*.js` other than the bundle still needs a restart.)

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

### Security

- **Polynomial backtracking in profile-id generation (CodeQL `js/polynomial-redos`, high).**
  `slugify` stripped leading and trailing dashes with `/^-+|-+$/`, an alternation
  of two quantified patterns. The run-collapsing replace immediately before it
  guarantees at most one dash on each side, so the quantifiers bought nothing and
  cost a backtracking hazard on a hostile profile label. It is now `/^-|-$/`.
- **Check-then-use on the two documents the installer edits (CodeQL
  `js/file-system-race`, high, four sites).** Reading and writing a path after
  `existsSync` is a race against any concurrent edit. The installer now reads
  through `readIfPresent`, which catches `ENOENT` instead of probing first.
- **A predictable temporary directory in the Docker helper (CodeQL
  `js/insecure-temporary-file`, high).** `test/docker/up.mjs` wrote into a fixed
  path under the temp root, where a symlink planted by another local user would be
  followed. It uses `mkdtempSync` now. The Tailscale suite also refuses to be the
  place a real MagicDNS suffix or tailnet name gets committed.

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
