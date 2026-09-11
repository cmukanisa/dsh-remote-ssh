# Contributing to dsh-remote-ssh

Thanks for wanting to help. This plugin reaches into a running agent's filesystem
and shell, so the bar is not "it works on my machine" — it is "it fails visibly
everywhere else". The guide below is mostly about that.

---

## 1. Set up

```sh
git clone https://github.com/cmukanisa/dsh-remote-ssh
cd dsh-remote-ssh
npm run deps      # symlink the harness packages (see below)
npm test          # parser check + unit suite
```

### Why `npm run deps`

The plugin imports `@deepseek-ai/cordis`, `@deepseek-ai/dsh-fs`, … exactly as the
harness does, but this repository is **not** a harness checkout, so Node has
nothing to resolve. `scripts/link-deps.mjs` symlinks those packages out of an
**installed harness** instead of vendoring a second copy that would let the tests
drift from the runtime they claim to test.

It looks in `$DSH_HOME/profiles/node_modules/@deepseek-ai` first, then at a global
`@deepseek-ai/dsh` install. If neither exists:

```sh
npm install -g @deepseek-ai/dsh
dsh --profile web --help    # creates $DSH_HOME/profiles
npm run deps
```

`npm install` (used only for the template check's one dev dependency) prunes those
symlinks, so re-run `npm run deps` after it.

There is **no build step**. The plugin is plain ES modules and the browser half is
a hand-written bundle, on purpose: a build step is one more thing that can differ
between a contributor's machine and a user's.

## 2. The test suites

| Suite | Command | Needs | What it proves |
|---|---|---|---|
| Parser | `npm run check` | nothing | every shipped file parses; the browser bundles keep the module-table wrapper |
| Template | `npm run test:template` | `npm install` | the composition template parses and replaces every shipped provider it must |
| Unit | `npm run test:unit` | nothing | quoting, path mapping, mirrors, policy containment, the Remote descriptor, the composition template |
| Installer | `node test/install.test.mjs` | nothing | the three durable changes, exactly once, and that the plugin arrives switched **off** |
| Windows client | `node test/windows-client.test.mjs` | nothing | no multiplexing promise on Windows; `ControlPath` shortening holds for Windows-shaped paths |
| Filesystem E2E | `npm run test:e2e` | a real SSH host | read/write/edit/list/stat/byte windows/URI parsing/sandbox fences, the shell executor, subprocess routing, **and local passthrough** |
| Harness E2E | `npm run test:harness` | a running `dsh` + a real SSH host | the composed plugin: browser bundle served, `sshWorkspace` Remote namespace answering, a remote folder becoming a workspace |
| Windows server | `node test/windows-server.expect.mjs` | a Windows SSH host | the refusal is explicit and actionable |

### Running the filesystem suite locally

```sh
npm run ssh:up                 # builds and starts a disposable OpenSSH container
export DSH_SSH_TEST_HOST=127.0.0.1 DSH_SSH_TEST_PORT=2223 DSH_SSH_TEST_USER=dsh \
       DSH_SSH_TEST_KEY=/tmp/dsh-remote-ssh-e2e/id_test \
       DSH_SSH_TEST_KNOWN_HOSTS=/tmp/dsh-remote-ssh-e2e/known_hosts \
       DSH_SSH_TEST_ROOT=/home/dsh/work
npm run test:e2e
npm run ssh:down
```

`ssh:up` prints the exact environment for your shell. **Pick a port nothing else
listens on** — a stray local `sshd` on the same port is the single most confusing
failure mode there is.

The suite creates its own directory per run and never depends on state a previous
run left behind, so it is re-runnable.

## 3. The CI matrix

`.github/workflows/ci.yml` — parser + unit + installer on Linux, macOS, and
Windows across Node 22 and 24 — the range the harness supports, so a green run
means something about a real deployment. This is the baseline; a red here is a
genuine portability regression.

Two portability traps this matrix has already caught, both worth remembering:
a Windows checkout with `core.autocrlf` hands over CRLF (so any line-anchored
check must normalise first), and `ssh -V` prints on **stderr**.

`.github/workflows/e2e.yml` — four jobs, because a remote workspace is only
"portable" if it survives all of these:

| Job | Server | Client | Why it exists |
|---|---|---|---|
| `linux-server` | Alpine and Debian containers | Linux | the two Linux userlands the remote scripts may assume |
| `harness` | Alpine container | Linux | the full product: boot, browser bundle, Remote namespace, workspace adoption |
| `macos-server` | the runner's own sshd | macOS | BSD userland (`stat -f`) and the long `/var/folders` temp path |
| `windows-server` | the runner's own sshd | Windows | asserts the documented refusal, and covers the Windows client path |

`.github/workflows/portability.yml` — POSIX-shell conformance of `install.sh`,
YAML validity of the composition template, a scan for machine-specific absolute
paths, and the Windows transport expectations.

`.github/workflows/release.yml` — on a tag: build the tarball, **prove it installs
into a pristine harness home**, publish it with a checksum.

`.github/workflows/codeql.yml` — security-and-quality analysis. The interesting
class of bug here is untrusted data (a path, a command fragment) reaching a remote
shell, so a review should look for exactly that.

## 4. Changing the code

### Layout

```
packages/dsh-remote-ssh/        host: ssh.js registry.js fs.js shell.js subprocess.js
packages/dsh-remote-ssh-ui/     browser half + the Remote namespace
patch/remote-ssh.patch.yml.tpl  the composition rows the installer writes
install.mjs, install.sh         installation
test/                           the suites above
```

### Rules that are not negotiable

- **Every value that reaches a remote shell goes through `shellQuote`.**
  `ssh host cmd a b` joins its arguments with spaces and the remote login shell
  parses that one string, so an argument is *not* a separate word. A path or a
  command fragment interpolated raw is remote code execution.
- **Parse `stat` permission bits base 8.** They are octal digits; reading `644`
  base 10 gives `420`, and every later `chmod` corrupts the file it meant to
  preserve. This shipped once.
- **Never let a local path take the remote branch**, and never the reverse.
  `registry.worldOf()` is the single decision point; the local passthrough tests
  exist because a regression there breaks every ordinary session.
- **Fail visibly.** A misconfigured host must not read as an agent bug: name what
  is wrong and what to do about it (see the non-POSIX refusal).
- **Keep side effects reversible.** Anything that opens a connection, a timer, a
  slot, or a settings namespace belongs to the plugin's fiber.

### Adding a remote operation

1. Put the remote shell source in the layer that owns it (`fs.js`, `shell.js`, …)
   and quote every interpolation.
2. Map its failures into the seam's own taxonomy (`FsError` with an `FS_*` code),
   never a bare `Error`.
3. Add a unit case for the pure part and an E2E case for the round-trip.
4. If it mutates, invalidate the realpath cache and take the per-target lock.

### Performance notes

Every remote operation is at least one round trip. Connection multiplexing
(`ControlMaster=auto` + `ControlPersist`) makes the *second* call cheap, so the
rule is: **one round trip per user-visible operation**, not one per internal step.
`listDir` is a single NUL-delimited scan for that reason, and realpath results are
cached for two seconds and invalidated on every mutation.

## 5. Pull requests

- One concern per PR; a behaviour change gets a test in the same PR.
- Conventional commit subjects (`feat:`, `fix:`, `test:`, `docs:`, `ci:`).
- Say in the description which suite you ran and against which server, including
  which userland (`Alpine`, `Debian`, `macOS`) when it matters.
- If you touched the transport, say which `ssh` version you tested with.

## 6. Reporting a bug

Include:

- `ssh -V`, `node -v`, the harness version (`dsh -V`), and the OS of both ends;
- the exact error text (the plugin tries to make it actionable — please quote it);
- whether `ssh <host>` works by hand from the same machine;
- the `uname -a` of the server, and whether `rg`, `realpath`, and `stat` exist there.

**Do not paste secrets, private keys, or `remotes.json`.**

## 7. License

By contributing you agree your work is released under the [MIT License](LICENSE).
