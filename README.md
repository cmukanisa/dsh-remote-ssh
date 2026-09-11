# dsh-remote-ssh

**Remote SSH workspaces for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

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

---

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

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/cmukanisa/dsh-remote-ssh/main/install.sh | sh
```

Or from a clone:

```sh
git clone https://github.com/cmukanisa/dsh-remote-ssh
cd dsh-remote-ssh
node install.mjs            # installs, switched OFF
node install.mjs --enable   # installs and activates
```

The installer is idempotent and makes exactly three changes:

1. copies the packages into `$DSH_HOME/profiles/plugins/`;
2. replaces its own managed block in `$DSH_HOME/cordis.patch.yml` (the
   home-level layer, so **every** profile gets the rows);
3. seeds `$DSH_HOME/settings.yaml` with `remote-ssh.enabled: false`.

| Flag | Effect |
|---|---|
| `--enable` | activate immediately instead of waiting for the Settings toggle |
| `--link` | symlink the packages instead of copying (development) |
| `--dry-run` | report what would change, touch nothing |
| `--uninstall` | remove the packages and the composition rows |
| `--dsh-home DIR` | target a different harness home |

## Activate

The installer deliberately leaves the plugin **off**, so a harness never gains SSH
access silently:

> **Settings → Plugins → “Workspaces distants (SSH)” → click “Désactivé”.**

The switch gates *offering* remote workspaces (the chooser and the sidebar
launcher). It never gates *routing*: a session already living in a mirror keeps
reaching its server, because silently falling back to the empty local mirror would
be worse than any error.

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

## License

[MIT](LICENSE).
