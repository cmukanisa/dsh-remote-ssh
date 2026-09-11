/**
 * `RemoteShellExecutor`: the composed `ctx.shell` provider. It keeps the
 * sandboxed local executor's mechanics — request defaulting, deadlines, output
 * caps, spill files, the managed background-process range — and swaps the
 * program at the execution boundary when the resolved working directory lives
 * in a remote mirror.
 *
 * The swap is exactly the extension point `LocalBashExecutor` documents: `run`
 * and `start` hand an explicit argv to the inherited `runArgv`/`startArgv`
 * ladders, so a remote command keeps local timeout classification, output
 * capping, background handles, job registration, and teardown quiescence for
 * free. The child that actually starts is `ssh`, whose working directory is the
 * (existing) local mirror of the remote directory, and whose single argument is
 * the remote shell source.
 *
 * Remote commands are NOT confined: `danger-full-access` semantics apply on the
 * far side, where the SSH account's own permissions are the boundary. This row
 * therefore reports no sandbox facts for a remote run rather than claiming a
 * confinement it did not apply.
 *
 * @module dsh-remote-ssh/shell
 */
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { ENV_OVERRIDES } from '@deepseek-ai/dsh-bash-local'
import { tmpdir } from 'node:os'
import { shellQuote } from './ssh.js'

/**
 * The working directory of the LOCAL `ssh` child.
 *
 * The remote directory is applied inside the remote command, so the local
 * process needs a directory that merely exists — and it must NOT be the mirror
 * path, because `ctx.subprocess` routes any spawn whose `cwd` is mirrored back
 * over SSH, which would wrap our own transport in a second one.
 */
const LOCAL_SCRATCH_DIRECTORY = tmpdir()

/**
 * The composed shell executor: local (sandboxed) for local directories, SSH for
 * mirrored remote ones.
 */
export class RemoteShellExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'remoteSsh']

  /** The remote registry. */
  get registry() {
    return this.ctx.remoteSsh
  }

  /**
   * Build the `ssh` argv for one remote run at `world`.
   * @param spec - the resolved spec whose `command` runs remotely.
   * @param world - the profile and remote directory the command runs in.
   * @returns the argv handed to the inherited execution ladder.
   */
  sshArgv(spec, world) {
    const transport = this.registry.transport(world.profile.id)
    const environment = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
    const exports = Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join('\n')
    const script = exports === '' ? spec.command : `${exports}\n${spec.command}`
    const prefix = transport.usesPassword ? [transport.sshpassBin, '-e'] : []
    return {
      argv: [...prefix, transport.sshBin, ...transport.baseArgs(), transport.destination, transport.wrap(script, world.remotePath)],
      env: transport.usesPassword ? { SSHPASS: world.profile.password } : {},
    }
  }

  /**
   * Run in the foreground: remote when the spec's directory is mirrored, local
   * through the inherited sandboxed path otherwise.
   */
  async run(spec) {
    const world = this.registry.worldOf(spec.workdir)
    if (world === undefined) return super.run(spec)
    const { argv, env } = this.sshArgv(spec, world)
    return this.runArgv({ ...spec, workdir: LOCAL_SCRATCH_DIRECTORY, env: { ...spec.env, ...env } }, argv)
  }

  /** Start in the background with the same routing rule as {@link run}. */
  start(spec) {
    const world = this.registry.worldOf(spec.workdir)
    if (world === undefined) return super.start(spec)
    const { argv, env } = this.sshArgv(spec, world)
    return this.startArgv({ ...spec, workdir: LOCAL_SCRATCH_DIRECTORY, env: { ...spec.env, ...env } }, argv)
  }
}

export default RemoteShellExecutor
