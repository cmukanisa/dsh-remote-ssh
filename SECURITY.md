# Security policy

## What this plugin does

`dsh-remote-ssh` gives a running DeepSeek Harness process the ability to connect
to SSH hosts and to read, write, and execute on them on a model's behalf. That is
a large capability, and the policy below is written to make it a *predictable*
one.

## Threat model

**In scope**

- A **model-supplied path or command fragment** reaching a remote shell as
  unintended shell syntax. Every interpolation is single-quoted
  (`shellQuote`), and the suite asserts it against embedded quotes, newlines, and
  command substitution.
- A **containment escape on the remote filesystem**: `workspace-write` must
  refuse a remote target whose canonical remote path is not under the per-call
  workspace root, and `read-only` must refuse every remote mutation.
- A **silent trust decision**: an unknown host is accepted once
  (`StrictHostKeyChecking=accept-new`), and a **changed** host key is always
  refused. Nothing in the plugin ever sets `StrictHostKeyChecking=no`.
- **Credential exposure on disk**: a configured password lives only in
  `$DSH_HOME/remotes.json`, created mode `0600`. It is never written to a log, to
  the session, or to the model's context.

**Out of scope**

- **Confining remote code.** `ctx.shell`'s confinement (`bwrap`, Seatbelt) is a
  same-kernel facility. Over SSH the SSH account's own permissions are the
  boundary, and the plugin reports no sandbox facts for a remote run rather than
  claiming a confinement it did not apply.
- **A compromised remote host.** Anything it returns (file contents, directory
  names, command output) is untrusted data by definition.
- **A malicious local user.** SSE/agent-tool privileges are assumed.

## The SSH channel

The plugin does not implement cryptography and does not proxy the protocol: it
drives the **real `ssh` binary**, so the channel is exactly the one your OpenSSH
client negotiates — `sntrup761x25519-sha512` / `curve25519-sha256` key exchange,
`chacha20-poly1305@openssh.com` or AES-GCM, and the server's host key verified
against your `known_hosts`. There is no unencrypted or fallback path, and no
second implementation that could disagree with your client's policy.

What the plugin guarantees about that channel, and how:

| Property | How it holds |
|---|---|
| Host key is verified | `StrictHostKeyChecking=accept-new` by default: a new host is trusted once, and a **changed** key is always refused. `yes` is available; `no` never appears in the source, and the unit suite asserts it. |
| Known hosts are yours | The system `known_hosts` is used unless you pass an explicit `UserKnownHostsFile`. The plugin never points ssh at `/dev/null`. |
| Keys stay yours | Authentication uses your SSH agent and `~/.ssh/config`; the plugin stores no key material. An explicit `-i` is paired with `IdentitiesOnly=yes` so an agent key cannot silently win. |
| No agent forwarding | No `-A`, no `ForwardAgent`, no destination constraints to weaken. The unit suite asserts no forwarding or agent option is ever assembled. |
| No tunnels | The plugin opens only exec channels. No `-L`, `-R`, `-D`, or `-W`, ever. |
| A password never touches an argv vector | `sshpass -e` reads it from the child's environment, so it cannot appear in `ps` output on the host. It is stored only in `remotes.json` (mode `0600`), never in the session, the log, or the model's context. |
| The socket is private | The multiplexing socket lives in a directory created `0700` under the harness home; its path is shortened when the platform limit would be exceeded. |
| Remote commands are not confined | By design, and reported as such: see the threat model. The SSH account's own permissions are the boundary. |

**The one hop this does not protect.** The connect form travels from your browser
to the harness over the harness's own HTTP API. Bind the harness to loopback (the
default, `127.0.0.1`) and prefer keys over passwords: on that hop a password is
plain HTTP, while a key never makes the trip at all. Reaching the harness from
another machine over an untrusted network is a harness-level concern, not
something this plugin can fix.

### Over Tailscale

A tailnet destination adds a second, independent security layer without weakening
the first:

| Property | How it holds |
|---|---|
| Transport encryption | WireGuard, between the two nodes. The plugin does not implement it; Tailscale does. |
| Host key | In `tailscale` mode the client verifies the destination's key against the one the coordination server advertises, **in addition** to OpenSSH's own `known_hosts` policy. Both have to be satisfied. |
| Access control | In `tailscale` mode, tailnet ACLs and node identity decide who may connect — so a profile can work with no SSH key on disk at all. |
| No silent substitution | A MagicDNS name or a `100.64/10` address is only *reported* as a tailnet destination. The transport changes solely because the profile says `transport: tailscale`; the unit suite asserts that distinction. |
| Offline peers | Reported as offline before the attempt, so a downed machine is never read as an SSH or credential failure. |

`tailscale ssh` is invoked as `tailscale ssh -- <ssh options> <destination>
<command>`: the wrapper parses its own flags before `--`, so everything the plugin
configures for ssh is passed after the separator, where it is forwarded unchanged.

## Design rules that keep it honest

1. SSH stays a **transport detail**. Nothing above the provider seams can tell
   whether bytes came from `node:fs` or from a remote shell — which is what lets
   every non-remote session keep the shipped, confined providers untouched.
2. **Fail visibly.** A non-POSIX server, a missing program, or a host-key change
   each produce a message naming the cause and the remedy. A misconfigured host
   must never read as an agent bug.
3. **Minimal durable state.** Two files: the connection profiles and the local
   mirrors. No remote agent, no daemon, no uploaded helper.

## Reporting a vulnerability

Open a **private security advisory** through GitHub
(*Security → Advisories → New draft security advisory*) rather than a public
issue. If you cannot, open an issue that says only that you have a report and how
to reach you.

Please include: affected version, the exact reproduction, the OS and `ssh -V` on
both ends, and whether the issue needs a malicious server, a malicious model
prompt, or only a misconfiguration.

Do **not** include real credentials, private keys, or a `remotes.json` file.
Rotate anything you believe was exposed before reporting.

## Supported versions

The `main` branch and the latest tagged release receive fixes.
