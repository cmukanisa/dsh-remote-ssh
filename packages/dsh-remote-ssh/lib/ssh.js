/**
 * SSH transport for the remote-workspace plugin.
 *
 * Every remote effect in this plugin funnels through {@link SshTransport}: one
 * long-lived OpenSSH child per command, multiplexed onto a shared master
 * connection by `ControlMaster=auto` + `ControlPersist`, so a burst of
 * filesystem round-trips costs one TCP handshake rather than one per call.
 *
 * The remote side is driven as POSIX shell source. A script is handed to the
 * remote login shell already correctly quoted, so no consumer of this module
 * ever has to reason about re-splitting: the login shell parses exactly the
 * source we built, `cd`s to the requested directory, and `exec`s the target
 * interpreter so the working directory and environment survive.
 *
 * @module dsh-remote-ssh/ssh
 */
import { spawn } from 'node:child_process'
import { tailscaleBin } from './tailscale.js'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default socket directory for OpenSSH connection multiplexing. */
const DEFAULT_CONTROL_DIR_SUFFIX = ['ssh-mux']

/**
 * Longest `ControlPath` an `AF_UNIX` address accepts. OpenSSH `fatal()`s rather
 * than truncating, and the limit differs by kernel (104 bytes on macOS and the
 * BSDs, 108 on Linux), so the conservative value is used everywhere.
 */
const MAX_CONTROL_PATH_BYTES = 104

/** Length of OpenSSH's `%C` expansion: a 40-character SHA-1 hex digest. */
const CONTROL_HASH_LENGTH = 40

/**
 * Pick a multiplexing socket directory that cannot overflow the `AF_UNIX` limit.
 *
 * `%C` hashes the connection tuple, so only the directory contributes variable
 * length. A directory too long for the limit is replaced by a short, hash-named
 * one under the OS temp root: the socket still names one connection uniquely, it
 * simply stops advertising where it came from.
 * @param directory - the requested socket directory.
 * @returns a directory whose `ControlPath` always fits.
 */
export function sharedControlDirectory(directory) {
  const budget = MAX_CONTROL_PATH_BYTES - 1 - CONTROL_HASH_LENGTH
  const digest = createHash('sha1').update(String(directory)).digest('hex').slice(0, 12)
  const candidates = [directory, join(tmpdir(), `dsh-ssh-${digest}`), `/tmp/dsh-ssh-${digest}`, '/tmp/dsh-ssh']
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, 'utf8') <= budget) return candidate
  }
  return candidates[candidates.length - 1]
}

/**
 * Quote one value as a single POSIX shell word.
 *
 * Single quotes disable every expansion, and the embedded-quote idiom
 * (`'\''`) closes, escapes, and reopens so the result is always one word.
 * @param value - the raw text to quote.
 * @returns shell source evaluating to exactly `value`.
 */
export function shellQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`
}

/**
 * Quote an argv vector as one POSIX shell word sequence.
 * @param argv - the argument vector to render.
 * @returns shell source evaluating to those words.
 */
export function quoteArgv(argv) {
  return argv.map(shellQuote).join(' ')
}

/** Whether this host's OpenSSH client lacks connection multiplexing (Windows). */
const MULTIPLEXING_UNSUPPORTED = process.platform === 'win32'



/**
 * The probe script this transport runs on a candidate host.
 *
 * Exported because the classification below is the plugin's one decision about
 * whether a host can be driven at all, and it is worth testing against the output
 * a real non-POSIX shell produces without needing a wire to produce it.
 */
export const PROBE_SCRIPT = [
  'printf "uname=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
  'if command -v bash >/dev/null 2>&1; then printf "shell=%s\\n" "$(command -v bash)"; else printf "shell=%s\\n" "$(command -v sh || echo sh)"; fi',
  'if command -v rg >/dev/null 2>&1; then printf "rg=%s\\n" "$(command -v rg)"; fi',
  'if command -v realpath >/dev/null 2>&1; then printf "realpath=1\\n"; else printf "realpath=0\\n"; fi',
  'if command -v setsid >/dev/null 2>&1; then printf "setsid=1\\n"; else printf "setsid=0\\n"; fi',
  'if stat -Lc %s . >/dev/null 2>&1; then printf "stat=gnu\\n"; elif stat -Lf %z . >/dev/null 2>&1; then printf "stat=bsd\\n"; else printf "stat=none\\n"; fi',
  'if printf aGk= | base64 -d >/dev/null 2>&1; then printf "base64d=-d\\n"; elif printf aGk= | base64 -D >/dev/null 2>&1; then printf "base64d=-D\\n"; fi',
  'printf "home=%s\\n" "$HOME"',
  'printf "user=%s\\n" "$(id -un 2>/dev/null || echo unknown)"',
].join('\n')

/**
 * Classify one probe transcript into the host facts later operations branch on.
 *
 * An answer with no `uname` line is NOT a host with unknown facts; it is a host
 * that did not answer the question, which is what {@link nonPosixHost} reports.
 * @param text - the remote shell's stdout.
 * @returns the discovered facts, `platform: 'unknown'` when the shell answered nothing usable.
 */
export function parseProbeOutput(text) {
  const facts = { platform: 'unknown', shell: 'sh', rg: undefined, realpath: false, setsid: false, stat: 'none', base64d: undefined, home: undefined, user: undefined }
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index)
    const value = line.slice(index + 1)
    if (key === 'uname') facts.platform = value === 'Darwin' ? 'darwin' : value === 'Linux' ? 'linux' : value.toLowerCase()
    else if (key === 'shell') facts.shell = value
    else if (key === 'rg') facts.rg = value
    else if (key === 'realpath') facts.realpath = value === '1'
    else if (key === 'setsid') facts.setsid = value === '1'
    else if (key === 'stat') facts.stat = value
    else if (key === 'base64d') facts.base64d = value
    else if (key === 'home') facts.home = value
    else if (key === 'user') facts.user = value
  }
  return facts
}


/**
 * Signatures of a failure that happened BEFORE the remote shell could run the
 * probe.
 *
 * The distinction matters because the two failures look identical from here — a
 * non-zero exit — while the remedies have nothing in common. Reporting "this host
 * is not POSIX" for a typo in a hostname, a rejected key, or an unreachable
 * network sends the reader after the wrong problem.
 */
const TRANSPORT_FAILURE_SIGNATURES = [
  /could not resolve hostname/i,
  /name or service not known/i,
  /nodename nor servname/i,
  /permission denied/i,
  /too many authentication failures/i,
  /host key verification failed/i,
  /remote host identification has changed/i,
  /connection refused/i,
  /connection (timed out|closed|reset)/i,
  /operation timed out/i,
  /network is unreachable|no route to host/i,
  /kex_exchange_identification/i,
  /no matching (host key|key exchange|mac|cipher)/i,
  /connection to .* closed by/i,
]

/**
 * Turn one probe failure into the error that names its real cause.
 *
 * A transport failure keeps its own message (host resolution, authentication,
 * network, host key). Everything else means the connection worked and the far
 * side's shell could not answer a POSIX question, which is what
 * {@link nonPosixHost} reports.
 * @param destination - `user@host` for the message.
 * @param error - the caught failure.
 * @returns the error to throw.
 */
export function classifyProbeFailure(destination, error) {
  const stderr = error?.stderr ?? ''
  if (TRANSPORT_FAILURE_SIGNATURES.some((pattern) => pattern.test(stderr))) return error
  return nonPosixHost(destination, error)
}

/**
 * The refusal a non-POSIX SSH server earns.
 *
 * Remote workspaces drive the far side with POSIX shell source — `sh -c`, `stat`,
 * `realpath`, `mv`, `head`/`tail` byte windows — so a Windows OpenSSH server
 * (cmd.exe or PowerShell) cannot be driven at all. Saying so plainly keeps a
 * configuration mistake from reading as an agent bug.
 * @param destination - `user@host` for the message.
 * @param cause - the underlying transport failure, when there was one.
 * @returns the error to throw.
 */
export function nonPosixHost(destination, cause) {
  return new SshTransportError(
    `${destination} does not answer as a POSIX host. Remote workspaces drive the far side with a POSIX shell (Linux, macOS, BSD); a Windows OpenSSH server answers with cmd.exe or PowerShell, and WSL is not reached by default. Point the plugin at a POSIX machine, or expose that machine's WSL sshd on its own port.`,
    cause === undefined ? {} : { cause },
  )
}

/** A transport-level failure: the connection or the `ssh` binary failed, not the remote command. */
export class SshTransportError extends Error {
  /**
   * @param message - operator-facing description.
   * @param options - optional cause and the remote exit status when one exists.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SshTransportError'
    this.exitCode = options.exitCode
    this.stderr = options.stderr
  }
}

/** ssh exit status meaning "the connection itself failed"; the remote command never ran. */
const SSH_CONNECTION_FAILURE = 255

/**
 * One resolved remote execution world: where to connect, how to authenticate,
 * and the host facts discovered by {@link SshTransport.probe} that let the
 * filesystem and shell layers emit portable POSIX instead of assuming GNU.
 */
export class SshTransport {
  /**
   * @param profile - the connection profile (host, port, user, credentials).
   * @param options - control-socket directory, timeouts, and the `ssh` binary override.
   */
  constructor(profile, options = {}) {
    this.profile = profile
    this.controlDir = sharedControlDirectory(options.controlDir ?? `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/${DEFAULT_CONTROL_DIR_SUFFIX[0]}`)
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000
    this.sshBin = options.sshBin ?? process.env.DSH_SSH_BIN ?? 'ssh'
    /**
     * Which transport carries the connection. `openssh` is the default and is
     * never inferred: a MagicDNS name or a `100.64/10` address connects through
     * plain OpenSSH unless the profile explicitly asks for Tailscale SSH, because
     * the two differ in who verifies the host key and who grants access.
     */
    this.transport = profile.transport === 'tailscale' ? 'tailscale' : 'openssh'
    /** The binary that performs the connection; the Tailscale client replaces ssh. */
    this.tailscaleBin = tailscaleBin()
    this.sshpassBin = options.sshpassBin ?? process.env.DSH_SSHPASS_BIN ?? 'sshpass'
    /** Cached host facts; undefined until {@link probe} succeeds. */
    this.facts = undefined
    /** In-flight probe, so concurrent callers share one round-trip. */
    this.probing = undefined
  }

  /** `user@host` as OpenSSH spells the destination. */
  get destination() {
    const { user, host } = this.profile
    return user === undefined || user === '' ? host : `${user}@${host}`
  }

  /** Whether password authentication was requested (which needs `sshpass`). */
  get usesPassword() {
    return typeof this.profile.password === 'string' && this.profile.password.length > 0
  }

  /**
   * The complete `ssh` option vector for this profile.
   *
   * `BatchMode=yes` is dropped for password profiles because it suppresses the
   * prompt `sshpass` exists to answer; `IdentitiesOnly=yes` accompanies an
   * explicit key so an agent key cannot silently win over the configured one.
   * @returns argv elements placed before the destination.
   */
  baseArgs() {
    const profile = this.profile
    const args = ['-T', '-o', 'LogLevel=ERROR', '-o', `ConnectTimeout=${Math.ceil(this.connectTimeoutMs / 1000)}`, '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']
    // Windows OpenSSH ships no connection multiplexing: naming a ControlPath
    // there fails the connection rather than degrading, so the options are
    // omitted and every call costs its own handshake. Tailscale mode keeps them:
    // the wrapper execs the system ssh with these options after `--`, so the
    // data plane still rides one multiplexed connection.
    if (!MULTIPLEXING_UNSUPPORTED) {
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 })
      args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(this.controlDir, '%C')}`, '-o', 'ControlPersist=60s')
    }
    args.push('-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'accept-new'}`)
    if (this.usesPassword) args.push('-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive')
    else args.push('-o', 'BatchMode=yes')
    if (profile.identityFile !== undefined && profile.identityFile !== '') args.push('-i', profile.identityFile, '-o', 'IdentitiesOnly=yes')
    if (profile.port !== undefined) args.push('-p', String(profile.port))
    if (profile.extraOptions !== undefined) args.push(...profile.extraOptions)
    return args
  }

  /**
   * Spawn one `ssh` child carrying `remoteSource` as the remote shell command.
   * @param remoteSource - POSIX shell source for the remote login shell to evaluate.
   * @param options - stdin bytes, cancellation, and an output cap.
   * @returns the child's collected stdout, stderr, and exit status.
   */
  /**
   * The wrapper argv that precedes the ssh options.
   *
   * `sshpass` answers an interactive prompt, so it must wrap whatever ends up
   * talking to the terminal. The Tailscale client is a wrapper around the system
   * `ssh` and only accepts its own flags before `--`; everything after the
   * separator reaches ssh unchanged.
   * @returns zero or more argv elements placed before the ssh options.
   */
  prefixArgv() {
    // The Tailscale client is a wrapper around the system ssh and parses its own
    // flags first, so everything meant for ssh has to follow `--`.
    return this.transport === 'tailscale' ? ['ssh', '--'] : []
  }

  /** The binary that talks to the far side, before any wrapper is applied. */
  connectorBin() {
    return this.transport === 'tailscale' ? this.tailscaleBin : this.sshBin
  }

  /** The environment the child needs (the password for `sshpass -e`). */
  childEnv() {
    return this.usesPassword ? { SSHPASS: this.profile.password } : {}
  }

  /**
   * The complete argv that runs one remote shell source.
   * @param remoteSource - POSIX shell source for the remote login shell.
   * @returns argv for `spawn`.
   */
  commandArgv(remoteSource) {
    const connector = [this.connectorBin(), ...this.prefixArgv(), ...this.baseArgs(), this.destination, remoteSource]
    // sshpass answers the prompt for whatever it wraps, so it takes the leading
    // position and the connector becomes its argument.
    return this.usesPassword ? [this.sshpassBin, '-e', ...connector] : connector
  }

  /**
   * Spawn one transport child carrying `remoteSource` as the remote command.
   * @param remoteSource - POSIX shell source for the remote login shell to evaluate.
   * @param options - cancellation.
   * @returns the live child process.
   */
  spawnRaw(remoteSource, options = {}) {
    const argv = this.commandArgv(remoteSource)
    return spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.childEnv() },
      signal: options.signal,
    })
  }

  /**
   * Run one remote shell script and collect its output.
   * @param script - POSIX shell source, already unquoted; it is transported safely.
   * @param options - working directory, stdin, cancellation, and capture caps.
   * @returns the exit status, stdout bytes, and stderr text.
   * @throws {SshTransportError} when the transport itself fails (exit 255, spawn error, signal).
   */
  async run(script, options = {}) {
    const source = this.wrap(script, options.workdir)
    const child = this.spawnRaw(source, options)
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maxBytes) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 64 * 1024) stderr.push(chunk)
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }).catch((error) => {
      throw new SshTransportError(`ssh could not start (${this.sshBin}): ${error.message}`, { cause: error })
    })
    const stderrText = Buffer.concat(stderr).toString('utf8')
    if (outcome.code === SSH_CONNECTION_FAILURE || (outcome.code === null && outcome.signal !== null)) {
      throw new SshTransportError(`ssh to ${this.destination} failed: ${stderrText.trim() || `terminated by ${outcome.signal}`}`, { exitCode: outcome.code, stderr: stderrText })
    }
    if (stdoutBytes > maxBytes) throw new SshTransportError(`remote output exceeded the ${maxBytes}-byte cap (${stdoutBytes} bytes)`)
    return { code: outcome.code ?? 0, stdout: Buffer.concat(stdout), stderr: stderrText, stdoutBytes }
  }

  /**
   * Run a remote script and decode stdout as UTF-8 text, rejecting a non-zero status.
   * @param script - POSIX shell source.
   * @param options - working directory, stdin, and cancellation.
   * @returns the decoded stdout.
   * @throws {SshTransportError} on a non-zero exit, carrying the remote stderr.
   */
  async runChecked(script, options = {}) {
    const result = await this.run(script, options)
    if (result.code !== 0) throw new SshTransportError(`remote command exited ${result.code}: ${result.stderr.trim() || '(no stderr)'}`, { exitCode: result.code, stderr: result.stderr })
    return result.stdout.toString('utf8')
  }

  /**
   * Wrap a script so it runs in `workdir`.
   *
   * The remote login shell evaluates `cd <dir> && exec <shell> -c <script>`:
   * the interpreter is `exec`ed so the child keeps the changed directory and
   * inherits the login environment, and the script reaches it as one quoted
   * word rather than being re-split by the login shell.
   * @param script - POSIX shell source.
   * @param workdir - absolute remote directory; omitted starts in the login directory.
   * @returns the source handed to the remote login shell.
   */
  wrap(script, workdir) {
    const shell = this.facts?.shell ?? 'sh'
    const source = workdir === undefined || workdir === '' ? script : `cd ${shellQuote(workdir)} || exit 66\n${script}`
    return `exec ${shell} -c ${shellQuote(source)}`
  }

  /**
   * Discover the host facts every later operation branches on, once per transport.
   * @param options - cancellation.
   * @returns the cached facts.
   * @throws {SshTransportError} when the host cannot be reached.
   */
  async probe(options = {}) {
    if (this.facts !== undefined) return this.facts
    if (this.probing === undefined) {
      this.probing = this.probeOnce(options).finally(() => {
        this.probing = undefined
      })
    }
    return this.probing
  }

  /**
   * Perform the single discovery round-trip behind {@link probe}.
   * @param options - cancellation.
   * @returns the discovered facts.
   */
  async probeOnce(options) {
    const script = PROBE_SCRIPT
    let text
    try {
      text = await this.runChecked(script, options)
    } catch (error) {
      throw classifyProbeFailure(this.destination, error)
    }
    const facts = parseProbeOutput(text)
    if (facts.platform === 'unknown') throw nonPosixHost(this.destination)
    if (facts.stat === 'none') {
      throw new SshTransportError(`${this.destination}: this host has no usable \`stat\`; a POSIX shell with coreutils or BSD userland is required`)
    }
    this.facts = facts
    return facts
  }

  /**
   * The remote-interpreter prefix that makes `argv` runnable as a remote command.
   *
   * `argv[0]` is resolved through the remote login `PATH` when it is a bare
   * name; an absolute path is passed through untouched so the caller's own
   * resolution rules stay visible in the error the remote shell reports.
   * @param argv - the command and its arguments.
   * @returns POSIX shell source invoking `argv`.
   */
  argvSource(argv) {
    return `exec ${quoteArgv(argv)}`
  }

  /** Close the multiplexed master connection; best-effort and never throws. */
  async close() {
    try {
      await new Promise((resolve) => {
        const child = spawn(this.connectorBin(), [...this.prefixArgv(), ...this.baseArgs(), '-O', 'exit', this.destination], { stdio: 'ignore' })
        child.once('close', resolve)
        child.once('error', resolve)
      })
    } catch {
      /* the master socket is already gone; nothing to close */
    }
  }
}
