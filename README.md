# dsh-remote-ssh plugin

**A community plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
remote SSH workspaces.**

Not affiliated with, endorsed by, or supported by DeepSeek. "DeepSeek Harness" is a trademark of
DeepSeek, used here only to describe what this plugin is built on.

Connect a server once, pick a folder there, and work in it: the agent reads, writes,
edits, lists, searches, and runs shell commands on the far side with every tool it
already has. The connection is shared by every session, several servers can be
connected at once, and the whole thing is switched on from **Settings → Plugins**.

```
┌──────────────────────── your machine ────────────────────────┐
│  dsh (web UI, agent, tools)                                  │
│    ctx.fs ─┐                                                 │
│    ctx.shell ├──► remote-ssh router ──► ssh (ControlMaster) ──┼──► server
│    ctx.subprocess ┘        │                                 │
│                            └─ local paths keep the shipped   │
│                               sandboxed providers, verbatim  │
└──────────────────────────────────────────────────────────────┘
```

The interface is available in **English, French, and Chinese**, and follows your browser's
language. The [user guide](https://cmukanisa.github.io/dsh-remote-ssh/) is published in the same
three languages.

---

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/cmukanisa/dsh-remote-ssh/main/install.sh | sh
```

Or from a clone:

```sh
git clone https://github.com/cmukanisa/dsh-remote-ssh
cd dsh-remote-ssh
node install.mjs            # checks, installs, verifies, activates
```

**Installing activates the plugin**, and the run is a transaction: it checks every
requirement first, installs, verifies, and **rolls back to the exact previous state
if anything does not pass**. A half-installed plugin is worse than none — the loader
would either fail to boot the profile or boot it with a composition that disables
the shipped providers and never registers the replacements.

```
  checking
  ✓ node        ·························· v24.14.0 (the harness requires >= 22.19)
  ✓ ssh         ···································· OpenSSH_10.3p1, LibreSSL 3.3.6
  ✓ tailscale   ················ 1.102.3 — the Tailscale SSH transport is available
  ✓ harness     ················································· /Users/you/.dsh
  ✓ writable    ··································· profiles/plugins accepts writes
  ✓ modules     ················· profiles/node_modules/@deepseek-ai/cordis present

  installing
  ✓ copied      ········ dsh-remote-ssh → profiles/plugins/dsh-remote-ssh (8 files)
  ✓ copied      ·· dsh-remote-ssh-ui → profiles/plugins/dsh-remote-ssh-ui (4 files)
  ✓ patched     ···································· cordis.patch.yml (8 rows)
  ✓ enabled     ····························· settings.yaml remote-ssh.enabled = true

  verifying
  ✓ files       ······················································ 12 files in place
  ✓ composition ·············································· 8 expected rows
  ✓ setting     ····································· remote-ssh.enabled = true
  ✓ module      ············· registry.js imports and exports RemoteRegistry

  ──────────────────────────────────────────────────────────────────────────────
  Done in 0.1s. Reload the harness page, then workspace "+" → "Serveur distant (SSH)".
```

Three durable changes, idempotent on every re-run:

1. copies the packages into `$DSH_HOME/profiles/plugins/`;
2. replaces its own managed block in `$DSH_HOME/cordis.patch.yml` (the
   home-level layer, so **every** profile gets the rows);
3. writes `$DSH_HOME/settings.yaml` with `remote-ssh.enabled: true`.

| Flag | Effect |
|---|---|
| `--keep-off` | install dormant — for a rollout where activation is audited separately |
| `--enable` | activate even if a previous run left it switched off |
| `--link` | symlink the packages instead of copying them (development) |
| `--dry-run` | run the checks, report the changes, write nothing |
| `--no-color` | plain output (also honours `NO_COLOR`) |
| `--uninstall` | remove the packages, the composition rows, and the setting |
| `--dsh-home DIR` | target a different harness home |

A re-install never flips an existing `remote-ssh.enabled` on its own: that value is
your answer, and `--enable` is the only thing that overrides it.

## Requirements

- **dsh** installed (`npm install -g @deepseek-ai/dsh`), any profile.
- **Node 22.19+ or 24+** — the same range the harness itself requires.
- An **OpenSSH client** on the machine running dsh (`ssh -V`). Windows OpenSSH
  works as a *client*, but without connection multiplexing.
- A **POSIX SSH server** (Linux, macOS, BSD). A Windows OpenSSH server is refused
  with an explicit message — see [Limitations](#limitations).
- Key-based authentication is recommended. `sshpass` is required only if you
  configure a password.
- Optional: `ripgrep` on the server, for the `glob` and `grep` tools.

## Documentation

The user guide is published in three languages — **English**, **Français**, **中文** — and the page
follows your browser's language:

> **<https://cmukanisa.github.io/dsh-remote-ssh/>**

The same content lives in [`docs/`](docs/) in this repository, as plain HTML with no build step.
[CONTRIBUTING.md](CONTRIBUTING.md) covers how to work on the plugin itself.

## Activate

It is already active after installing. The switch stays useful for turning it
**off**: **Settings → Plugins → “Workspaces distants (SSH)”**.

It gates *offering* remote workspaces (the chooser and the sidebar launcher). It
never gates *routing*: a session already living in a mirror keeps reaching its
server, because silently falling back to the empty local mirror would be worse than
any error.

Then reload the page.

## Use

1. Click **+** in the sidebar's workspace header (or the 🖥 button in the sidebar
   foot, which always opens the same dialog).
2. Choose **Serveur distant (SSH)**.
3. **＋ Serveur** and fill in the connection: name, host, port, user, private key
   path, or a password. Your `~/.ssh/config` aliases, `ProxyJump`, and SSH agent
   all work, because the plugin drives the real `ssh` binary.
4. Browse to the folder, then **Utiliser ce dossier**.

The folder appears as a normal workspace. A session opened there reads, writes,
edits, lists, searches, and runs commands on the server.

Several servers can be connected at once; each gets its own mirror, and the
profile chips switch between them in the same dialog.

## Work that outlives the harness

The agent loop runs inside the harness, so closing it ends the turn. What **can** keep working is the
command, and detaching it is the whole trick: the plugin writes a small launcher on the server, starts
it under its own session (`setsid`, or `nohup` where that is unavailable), and sends its output to a log
file there.

- **Close the harness whenever you like.** The remote process keeps running.
- **Come back and see it.** Settings → Plugins lists every run with its live state — running, finished
  with its exit code, or gone — and its latest output.
- **Stop it when you want.** A running entry has a **Stop** button; the whole process group is
  signalled, so children stop with it. *Forget finished* clears the records.

One durable record per run lives in `$DSH_HOME/remotes-sessions.json`, shared by every session, so a
harness that restarts re-attaches to work it never watched.

```sh
# what the panel reads, from the server's point of view
ls ~/.dsh-remote/run/          # one .sh, .pid, .started, .log, .status per run
```

## Updating

Re-run the installer. It rewrites its own composition block, which is enough to
pick up a new version **without restarting the harness**:

- the **browser half** is served from bytes that `dsh-client-hmr` polls, so
  replacing the installed bundle changes the revision the page is served and the
  plugin reloads;
- a change to the **host half** (`lib/*.js`) is cached by Node's ESM loader, so
  that one does need a harness restart.

```sh
node install.mjs       # or the curl one-liner again
```

## Configuration

### Settings (`$DSH_HOME/settings.yaml`)

```yaml
remote-ssh:
  enabled: true            # the Settings → Plugins switch
  connectTimeoutMs: 20000  # per `ssh` invocation
  strictHostKeyChecking: accept-new   # accept-new | yes | no
```

`accept-new` is the default: a new host is trusted on first use, and a **changed**
host key is always refused.

### Profiles (`$DSH_HOME/remotes.json`, mode 0600)

Written by the installer's dialog. It holds the connection details, including a
password if you gave one — which is why the file is created `0600`.

### Mirrors (`$DSH_HOME/remotes/<profile>/…`)

Real, empty local directories. Delete one and the remote folder is untouched; the
mirror is recreated on the next listing or adoption.

### Composition rows

See [`patch/remote-ssh.patch.yml.tpl`](patch/remote-ssh.patch.yml.tpl). They point
at absolute paths because a row's relative specifier resolves against the profile
directory, and this layer is shared by every profile.

## Tailscale

Two different things are called "connecting over Tailscale", and the plugin keeps
them apart on purpose.

**OpenSSH over the tailnet — nothing to configure.** Point a profile at a MagicDNS
name (`build-a.example-tailnet.ts.net`) or a `100.x.y.z` address and the real `ssh`
binary connects over WireGuard. Your keys, your `~/.ssh/config`, and your
`known_hosts` remain the authority. This is the default and it is unchanged.

**`tailscale ssh` — opt-in per profile.** Choose *Tailscale SSH* in the connect
form. The Tailscale client then wraps the system `ssh`, which buys three things:

- MagicDNS resolution even with `--accept-dns=false`;
- reachability through `tailscaled`, so it works in userspace-networking mode;
- the destination's host key verified against the one the **coordination server**
  advertises for that node, on top of your normal host-key policy.

Access is then governed by tailnet ACLs and identity rather than by SSH keys on
disk. The adapter never switches transports on its own: a MagicDNS-looking host is
*reported* as a tailnet destination (🌐 on the profile chip) but connects through
plain OpenSSH unless the profile says `tailscale` (⚡).

The connect form also lists your tailnet's peers, read from
`tailscale status --json`: click one to fill in the MagicDNS name, the tailnet user,
and — when the peer advertises SSH host keys and therefore runs the Tailscale SSH
server — the Tailscale SSH transport. A peer Tailscale reports as **offline** is
named before the attempt, instead of surfacing twenty seconds later as a connect
timeout.

```sh
# what the plugin reads, if you want to see it yourself
tailscale status --json | jq '.Peer[] | {HostName, DNSName, Online, sshHostKeys}'
```

Requirements: the `tailscale` CLI on the machine running dsh (override with
`DSH_TAILSCALE_BIN`). A machine without Tailscale reports the tailnet as
unavailable and everything else keeps working.

## How a path is routed

| Input | World | Notes |
|---|---|---|
| `<mirror>/srv/app/x.ts` | remote | the everyday case: the session `cwd` and its files |
| `ssh://<profile>/srv/app/x.ts` | remote | explicit URI, accepted anywhere a path is |
| `/srv/app/x.ts` | local | a remote path is never guessed from its shape |
| anything else | local | the shipped providers, untouched |

Containment follows the local sandbox: `read-only` refuses every remote mutation,
and `workspace-write` refuses any remote target whose canonical mirror path is not
under the per-call workspace root. The check is canonicalize-then-contain over the
**remote** `realpath`, so it keeps the same guarantee the local fence does.

## Why it is built this way

A workspace in dsh is a real local directory: session headers carry a canonical
local `cwd`, the workspace registry `realpath`s the path at creation, and the
sidebar resolves sessions by that canonical path. Rather than teach all of that a
second path vocabulary, a remote folder gets a **local mirror** — a real but empty
directory at `$DSH_HOME/remotes/<profile>/<remote/path>` — and the filesystem
provider translates every path under it into the remote path it mirrors.

Everything above the filesystem therefore keeps working unchanged, including the
parts that bypass `ctx.fs`.

The plugin replaces three capability providers, each with a subclass that keeps
the shipped behaviour verbatim for local paths:

| Provider | Local behaviour | Remote behaviour |
|---|---|---|
| `ctx.fs` | `dsh-fs-sandbox` (read/write/edit/list/stat, policy fence) | reads, atomic writes, literal edits, listings, byte windows over SSH |
| `ctx.shell` | `dsh-bash-sandbox` (timeouts, output caps, spill files, background ranges) | the same lifecycle, with `ssh` as the program |
| `ctx.subprocess` | `dsh-subprocess-local` | the same managed range, routed — this is what makes `glob`/`grep` work remotely |

---

## Limitations

- **POSIX servers only.** The far side is driven with POSIX shell source (`sh -c`,
  `stat`, `realpath`, `mv`, `head`/`tail`). A Windows OpenSSH server is refused
  with a message that says so, rather than half-working.
- **Remote commands are not confined.** `ctx.shell` confinement (`bwrap`,
  Seatbelt) is a same-kernel facility; over SSH the account's own permissions are
  the boundary. No sandbox facts are reported for a remote run, because none were
  applied. The filesystem fence described above *is* enforced.
- **`glob` and `grep` need `ripgrep` on the server.** When it is missing, the tool
  fails with an actionable message instead of returning wrong results.
- **No file watching.** The sidebar's file tree refreshes on navigation, not on
  remote changes.
- **Mirror directories can shadow a same-named local path.** A path under
  `$DSH_HOME/remotes/` always belongs to its profile.
- **`process.cwd()`-relative tooling** inside the agent's shell works, but tools
  that hard-code local filesystem access outside `ctx.fs` (for example a hook that
  reads a file) see the empty mirror.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `does not answer as a POSIX host` | A Windows SSH server. Use a Linux/macOS host, or expose that machine's WSL sshd on its own port. |
| `ControlPath too long` | Cannot happen through the plugin (it shortens the path), but a hand-written `ControlPath` in `~/.ssh/config` can still hit the 104-byte `AF_UNIX` limit. |
| `Permission denied (publickey)` | Run `ssh <host>` by hand first; the plugin uses the same client, agent, and config. |
| Host key changed | The plugin refuses, correctly. Remove the stale line from `known_hosts` once you are sure. |
| `glob`/`grep` say a program is not available | Install ripgrep on the server (`apt-get install ripgrep`, `dnf install ripgrep`, `apk add ripgrep`). |
| The workspace shows no files in a local-only tool | That tool bypasses `ctx.fs`, so it sees the empty mirror. |

## Testing

```sh
npm run deps          # symlink the harness packages (once)
npm run check         # parser + bundle-wrapper check
npm run test:unit     # no SSH needed
npm run test:harness  # against a running harness

npm run ssh:up        # docker OpenSSH target on 127.0.0.1:2223
npm run test:e2e      # filesystem, shell, and subprocess over real SSH
npm run ssh:down
```

The CI matrix runs the unit suites on Linux, macOS, and Windows across the
supported Node range (22.19+ and 24+; the harness does not support Node 20); the end-to-end suites against an Alpine server, a Debian server, a
macOS server, and a Windows server (whose refusal is asserted); and a full harness
boot where the browser bundle and the Remote namespace are exercised. See
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Guide rapide (français)

**Installer** — `curl -fsSL .../install.sh | sh`, ou `node install.mjs`.

**Activer** — Paramètres → Plugins → « Workspaces distants (SSH) » → cliquer
« Désactivé ». Puis rechargez la page.

**Utiliser** — bouton **+** de la barre latérale → « Serveur distant (SSH) » →
**＋ Serveur** (hôte, port, utilisateur, clé privée ou mot de passe) → parcourir →
**Utiliser ce dossier**. Le dossier devient un workspace normal : lecture,
écriture, édition, recherche et commandes shell s'exécutent sur le serveur.

Plusieurs serveurs peuvent être connectés en même temps et restent disponibles
pour toutes les sessions.

---

## Author

Built by **Christian Kasse** ([@cmukanisa](https://github.com/cmukanisa)) — see the
[contributors](https://github.com/cmukanisa/dsh-remote-ssh/graphs/contributors)
for everyone who has helped. Contributions are welcome; start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
