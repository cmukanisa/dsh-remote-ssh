/**
 * Detached remote work (`ctx.remoteSessions`): commands that keep running on the
 * far side after the harness closes.
 *
 * ## What can and cannot outlive the harness
 *
 * The agent loop runs in the harness process, so closing the harness ends the
 * conversation's turn. What CAN survive is the WORK: a command launched on the
 * remote host is a process there, and if it is detached from the SSH channel it
 * keeps running while nothing is watching.
 *
 * Detaching is therefore the whole trick, and it is done explicitly rather than
 * relied upon:
 *
 *  - the command is wrapped in a small script the plugin writes to a private
 *    directory on the server, which records its own pid, its start time, and its
 *    exit status;
 *  - it is started under `setsid` when available, so it owns a process group that
 *    can be signalled as a whole, and under `nohup` otherwise — both survive the
 *    SSH channel closing;
 *  - stdout and stderr go to a log file on the server, which is what makes a
 *    re-attached view live rather than a guess.
 *
 * The records live in one durable document under the harness home, so every
 * session sees the same work, and a reconnecting user reads its current state from
 * the server rather than from memory the harness no longer has.
 *
 * @module dsh-remote-ssh/sessions
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { shellQuote } from './ssh.js'

/** Directory on the remote host holding the wrapper, pid, status, and log. */
const REMOTE_RUN_DIR = '.dsh-remote/run'

/** How much of a session's log a status read returns by default. */
export const DEFAULT_TAIL_BYTES = 16384

/** A session operation that cannot be honoured as asked. */
export class RemoteSessionError extends Error {
  /**
   * @param message - operator-facing description.
   * @param code - stable machine-routable code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'RemoteSessionError'
    this.code = code
  }
}

/** A filesystem-safe id for one run. */
function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Validated configuration of the sessions row. */
export const Config = z.object({
  /** Durable document listing the detached work this harness home has started. */
  path: z.string().required(),
})

/**
 * The durable registry of detached remote work (`ctx.remoteSessions`).
 *
 * One document for the whole harness home: work belongs to the machine, not to a
 * session, which is exactly what makes it visible again after a restart.
 */
export class RemoteSessionStore extends Service {
  static Config = Config
  static inject = ['remoteSsh']

  /**
   * @param ctx - the host context, whose registry provides the transports.
   * @param config - the durable document path.
   */
  constructor(ctx, config) {
    super(ctx, 'remoteSessions')
    this.path = config.path
    this.records = []
    this.load()
  }

  /** The remote registry, resolved lazily so construction order does not matter. */
  get registry() {
    return this.ctx.remoteSsh
  }

  /** Read the durable document, tolerating absence and ignoring a corrupt one. */
  load() {
    if (!existsSync(this.path)) {
      this.records = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      this.records = Array.isArray(parsed.sessions) ? parsed.sessions.filter((entry) => typeof entry?.id === 'string' && typeof entry?.profileId === 'string') : []
    } catch (error) {
      this.ctx.logger?.warn?.(`remote-ssh: ignoring unreadable ${this.path}: ${error.message}`)
      this.records = []
    }
  }

  /** Persist atomically, mode 0600: commands and paths are the operator's. */
  save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: this.records }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
  }

  /** One record by id. */
  require(id) {
    const record = this.records.find((entry) => entry.id === id)
    if (record === undefined) throw new RemoteSessionError(`unknown remote session "${id}"`, 'unknown-session')
    return record
  }

  /** The absolute remote directory holding one run's files. */
  remoteRunDir(record) {
    return `${record.remoteRoot}/${REMOTE_RUN_DIR}`
  }

  /**
   * Start one detached command on a host.
   * @param profileId - which connected host to run on.
   * @param request - the shell source, its remote working directory, and a label.
   * @returns the durable record with its pid.
   */
  async start(profileId, request) {
    const profile = this.registry.require(profileId)
    const transport = this.registry.transport(profileId)
    const facts = await transport.probe()
    const remoteRoot = (profile.remoteRoot === '' ? facts.home : profile.remoteRoot) ?? facts.home ?? '/tmp'
    const workingDirectory = request.cwd === undefined || request.cwd === '' ? remoteRoot : request.cwd
    const command = String(request.command ?? '')
    if (command.trim() === '') throw new RemoteSessionError('a command is required', 'invalid-request')
    const id = newSessionId()
    const record = {
      id,
      profileId,
      label: String(request.label ?? '').trim() || command.split('\n')[0].slice(0, 80),
      command,
      cwd: workingDirectory,
      remoteRoot,
      startedAt: new Date().toISOString(),
      shell: facts.shell,
      setsid: facts.setsid === true,
    }
    const runDir = this.remoteRunDir(record)
    // The launcher is written to the host rather than inlined in one `sh -c`:
    // it records the pid before the work starts (so a stop can find it) and the
    // exit status after it ends (so a later reader learns how it went), which no
    // single command line can do.
    const launcher = [
      '#!/bin/sh',
      `cd ${shellQuote(workingDirectory)} || exit 66`,
      `printf '%s\\n' "$$" > ${shellQuote(`${runDir}/${id}.pid`)}`,
      `printf '%s\\n' ${shellQuote(new Date().toISOString())} > ${shellQuote(`${runDir}/${id}.started`)}`,
      `${shellQuote(facts.shell)} -c ${shellQuote(command)}`,
      'code=$?',
      `printf '%s\\n' "$code" > ${shellQuote(`${runDir}/${id}.status`)}`,
      'exit $code',
    ].join('\n')
    const scriptPath = `${runDir}/${id}.sh`
    const logPath = `${runDir}/${id}.log`
    const launch = [
      `mkdir -p ${shellQuote(runDir)} || exit 66`,
      `cat > ${shellQuote(scriptPath)} <<'DSH_REMOTE_EOF'\n${launcher}\nDSH_REMOTE_EOF`,
      `chmod 700 ${shellQuote(scriptPath)}`,
      // setsid when the host has it: the run then owns a process group that can
      // be signalled whole. Without it, nohup still survives the channel closing.
      record.setsid
        ? `setsid nohup ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 < /dev/null &`
        : `nohup ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 < /dev/null &`,
      'printf "pid=%s\\n" "$!"',
    ].join('\n')
    const result = await transport.run(launch, { maxBytes: 64 * 1024 })
    if (result.code !== 0) throw new RemoteSessionError(`could not start the remote command: ${result.stderr.trim() || `exit ${result.code}`}`, 'start-failed')
    const pid = /pid=(\d+)/.exec(result.stdout.toString('utf8'))?.[1]
    record.pid = pid === undefined ? undefined : Number(pid)
    this.records.unshift(record)
    this.save()
    return { ...record, runDir, scriptPath, logPath }
  }

  /**
   * Live state of one session, read from the server.
   * @param id - session id.
   * @param options - how much log to return.
   * @returns the state, its exit code when it finished, and the log tail.
   */
  async status(id, options = {}) {
    const record = this.require(id)
    const transport = this.registry.transport(record.profileId)
    const runDir = this.remoteRunDir(record)
    const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES
    const script = [
      `if [ -f ${shellQuote(`${runDir}/${id}.status`)} ]; then printf 'state=exited\\n'; printf 'code=%s\\n' "$(cat ${shellQuote(`${runDir}/${id}.status`)})"`,
      `elif [ -f ${shellQuote(`${runDir}/${id}.pid`)} ] && kill -0 "$(cat ${shellQuote(`${runDir}/${id}.pid`)})" 2>/dev/null; then printf 'state=running\\n'`,
      `else printf 'state=gone\\n'; fi`,
      `printf 'started=%s\\n' "$(cat ${shellQuote(`${runDir}/${id}.started`)} 2>/dev/null || echo '')"`,
      `printf 'bytes=%s\\n' "$(wc -c < ${shellQuote(`${runDir}/${id}.log`)} 2>/dev/null || echo 0)"`,
      `printf 'tail<<DSH\\n'`,
      `tail -c ${tailBytes} ${shellQuote(`${runDir}/${id}.log`)} 2>/dev/null`,
      `printf '\\nDSH\\n'`,
    ].join('\n')
    const result = await transport.run(script, { maxBytes: tailBytes + 64 * 1024 })
    const text = result.stdout.toString('utf8')
    const state = /state=(\w+)/.exec(text)?.[1] ?? 'unknown'
    const code = /code=(-?\d+)/.exec(text)?.[1]
    const bytes = Number(/bytes=(\d+)/.exec(text)?.[1] ?? 0)
    const tail = text.slice(text.indexOf('tail<<DSH\n') + 'tail<<DSH\n'.length, text.lastIndexOf('\nDSH'))
    record.state = state
    record.exitCode = code === undefined ? undefined : Number(code)
    record.bytes = bytes
    record.checkedAt = new Date().toISOString()
    this.save()
    return { id, state, exitCode: code === undefined ? undefined : Number(code), bytes, tail, label: record.label, command: record.command, cwd: record.cwd, startedAt: record.startedAt, profileId: record.profileId }
  }

  /**
   * Stop one session: the whole process group when it owns one, else the process
   * and its children.
   * @param id - session id.
   * @returns the state after the signal.
   */
  async stop(id) {
    const record = this.require(id)
    const transport = this.registry.transport(record.profileId)
    const runDir = this.remoteRunDir(record)
    const pid = `$(cat ${shellQuote(`${runDir}/${id}.pid`)} 2>/dev/null)`
    const script = [
      `pid=${pid}`,
      '[ -n "$pid" ] || exit 0',
      record.setsid === true ? 'kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null' : 'kill -TERM "$pid" 2>/dev/null',
      'sleep 2',
      record.setsid === true ? 'kill -KILL "-$pid" 2>/dev/null || true' : 'kill -KILL "$pid" 2>/dev/null || true',
      `printf 'stopped\\n'`,
    ].join('\n')
    const result = await transport.run(script, { maxBytes: 16 * 1024 })
    if (result.code !== 0) throw new RemoteSessionError(`could not stop "${id}": ${result.stderr.trim() || `exit ${result.code}`}`, 'stop-failed')
    return await this.status(id, { tailBytes: 2048 })
  }

  /**
   * Every session, newest first, without touching the network.
   *
   * The last known state is what a list renders; {@link status} is what refreshes
   * it, so opening a panel costs one round trip per visible session rather than
   * one per record ever created.
   * @returns the stored records.
   */
  list() {
    return this.records.map((record) => ({
      id: record.id,
      profileId: record.profileId,
      label: record.label,
      command: record.command,
      cwd: record.cwd,
      startedAt: record.startedAt,
      state: record.state ?? 'unknown',
      exitCode: record.exitCode,
      bytes: record.bytes,
      checkedAt: record.checkedAt,
      pid: record.pid,
    }))
  }

  /**
   * Forget records.
   *
   * `finishedOnly` drops a record only when its state is KNOWN to have ended —
   * `exited` with a recorded status, or `gone` because the process no longer
   * exists.
   * A record whose state was never refreshed is kept, because the whole point of
   * the registry is that a command may still be running when nobody is looking —
   * and forgetting it would destroy the only handle a user has on that work.
   * @param options - `id` for one, `finishedOnly` to drop what certainly ended, `all` for everything.
   * @returns how many records were dropped.
   */
  forget(options = {}) {
    const before = this.records.length
    if (options.all === true) this.records = []
    else if (options.id !== undefined) this.records = this.records.filter((entry) => entry.id !== options.id)
    else if (options.finishedOnly === true) this.records = this.records.filter((entry) => entry.state !== 'exited' && entry.state !== 'gone')
    this.save()
    return before - this.records.length
  }
}

export default RemoteSessionStore
