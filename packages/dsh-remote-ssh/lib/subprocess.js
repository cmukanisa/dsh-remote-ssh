/**
 * `RemoteSubprocessRuntime`: the composed `ctx.subprocess` provider. It is the
 * local runtime for every local working directory and an SSH child for every
 * mirrored remote one.
 *
 * Only the argv and the directory change. `spawn` rewrites the spec so the
 * child that starts is `ssh`, still created, capped, spilled, signalled, and
 * torn down by the local runtime's own managed-range mechanics; the remote
 * process is reached through the multiplexed connection. This is the seam the
 * search tools use (`glob`/`grep` spawn a ripgrep binary directly rather than
 * going through `ctx.shell`), so routing it is what makes those two tools work
 * against a remote workspace.
 *
 * A packaged executable path from the harness's own install cannot exist on the
 * far side. `spawn` therefore keeps a BARE program name as-is (the remote
 * `PATH` resolves it), and guards an absolute one with an explicit remote check
 * that fails with an actionable message instead of a bare "not found".
 *
 * @module dsh-remote-ssh/subprocess
 */
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { basename } from 'node:path'
import { ENV_OVERRIDES } from '@deepseek-ai/dsh-bash-local'
import { shellQuote } from './ssh.js'

/** Guidance emitted when a remote host cannot run the requested program. */
function missingProgramScript(program, host) {
  const rg = /^rg(\.exe)?$/.test(basename(program))
  const hint = rg ? `install it on ${host} (for example: apt-get install ripgrep, or dnf install ripgrep)` : `make ${program} available on ${host}, or run the search through the bash tool instead`
  const probe = rg ? 'command -v rg >/dev/null 2>&1' : `[ -x ${shellQuote(program)} ]`
  return `${probe} || { printf '%s\\n' ${shellQuote(`"${basename(program)}" is not available on ${host}: ${hint}`)} >&2; exit 2; }`
}

/**
 * The composed subprocess runtime: local mechanics, remote destination.
 */
export class RemoteSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['remoteSsh']

  /** The remote registry. */
  get registry() {
    return this.ctx.remoteSsh
  }

  /**
   * Spawn one managed process. A spec whose `cwd` is mirrored runs remotely with
   * identical lifecycle semantics; every other spec is untouched.
   * @param spec - the caller's fully-specified spawn request.
   * @returns the live handle from the local runtime.
   */
  spawn(spec) {
    const world = this.registry.worldOf(spec.cwd)
    if (world === undefined) return super.spawn(spec)
    const transport = this.registry.transport(world.profile.id)
    const [program, ...rest] = spec.argv
    const target = program !== undefined && program.includes('/') ? basename(program) : program
    const environment = { ...ENV_OVERRIDES, ...spec.env }
    const exports = Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join('\n')
    const script = [exports, missingProgramScript(program, transport.destination), `cd ${shellQuote(world.remotePath)} || exit 66`, `exec ${[target, ...rest].map(shellQuote).join(' ')}`].filter((line) => line !== '').join('\n')
    return super.spawn({
      ...spec,
      argv: transport.commandArgv(transport.wrap(script)),
      cwd: spec.cwd,
      env: { ...spec.env, ...transport.childEnv() },
    })
  }
}

export default RemoteSubprocessRuntime
