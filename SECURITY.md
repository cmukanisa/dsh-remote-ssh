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
