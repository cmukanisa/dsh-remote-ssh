/**
 * Host half of the remote-workspace surface: the Typert Remote namespace the
 * browser half calls.
 *
 * ## Why the markers are written by hand
 *
 * `@Remote` is a TC39 method decorator, and a runtime plugin that ships as plain
 * JavaScript has no decorator syntax to hang it on. The protocol's decorator
 * only records a versioned descriptor on the class prototype, so this module
 * records exactly that shape — the same `{ version: 1, methods: [...] }` object
 * `remoteMethods()` reads — through {@link markRemote}. The Gateway's
 * source-mode discovery then publishes each marked method as
 * `<namespace>/<method>`, deriving the parameter list from the method's own
 * source text, so every parameter must be a plain identifier (no destructuring,
 * defaults, or rest) and a trailing `signal` parameter receives cancellation.
 *
 * @module dsh-remote-ssh-ui/remote
 */
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** The Remote namespace this controller owns. */
export const NAMESPACE = 'sshWorkspace'

/** Prototype key read by `remoteMethods()`; the protocol does not export it. */
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Record Remote markers on a prototype in declaration order.
 * @param prototype - the class prototype to describe.
 * @param methods - public instance method names, in declaration order.
 */
export function markRemote(prototype, methods) {
  const markers = methods.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))
  Object.defineProperty(prototype, REMOTE_METHODS_KEY, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(markers) }),
  })
}

/** Translate a registry failure into the wire's structured error vocabulary. */
function asRemoteError(error) {
  if (error !== null && typeof error === 'object' && error.isDSHRemoteError === true) return error
  const code = typeof error?.code === 'string' && error.code.includes('/') ? error.code : `remote-ssh/${error?.code ?? 'failed'}`
  return new RemoteError(code, error instanceof Error ? error.message : String(error))
}

/**
 * The `sshWorkspace` Remote controller: connection profiles, remote directory
 * browsing, and workspace adoption. Every method delegates to `ctx.remoteSsh`,
 * the host-plane registry that owns the durable profiles and the local mirrors.
 */
export class RemoteSshController extends TypertRemoteService {
  static inject = ['remoteSsh', 'remoteSessions']

  /**
   * @param ctx - host context carrying the remote registry.
   */
  constructor(ctx) {
    super(ctx, 'remoteSshController', { namespace: NAMESPACE })
  }

  /** The registry service. */
  get registry() {
    return this.ctx.remoteSsh
  }

  /** The detached-work registry. */
  get sessions() {
    return this.ctx.remoteSessions
  }

  /**
   * Current subsystem state, read before every dialog render.
   * @returns the switch, the mirror root, and every known profile.
   */
  async status() {
    return {
      enabled: this.registry.enabled,
      root: this.registry.root,
      profiles: this.registry.list(),
      // Read-only and best effort: a machine without Tailscale reports
      // unavailable, and the browser half then renders no tailnet section. This
      // is re-read on every call, so the Settings card's Re-check button adopts a
      // client the user installed after the plugin was.
      tailnet: await this.registry.tailnet(),
      tailscaleBin: process.env.DSH_TAILSCALE_BIN ?? 'tailscale',
    }
  }

  /**
   * Flip the master switch.
   * @param enabled - the next value.
   * @returns the state after the write.
   */
  async setEnabled(enabled) {
    await this.registry.setEnabled(enabled === true)
    return await this.status()
  }

  /**
   * Add one connection profile and immediately try it.
   * @param input - host, port, user, and credentials.
   * @returns the created profile with its first connectivity report.
   */
  async connect(input) {
    try {
      const profile = this.registry.add(input ?? {})
      const report = await this.registry.test(profile.id)
      return { profile: this.registry.list().find((entry) => entry.id === profile.id), report }
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Re-test one stored profile.
   * @param id - profile id.
   * @returns the connectivity report.
   */
  async test(id) {
    try {
      const report = await this.registry.test(id)
      return { profile: this.registry.list().find((entry) => entry.id === id), report }
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Forget one profile. Its mirror tree and any workspace living in it stay.
   * @param id - profile id.
   * @returns the remaining profiles.
   */
  async disconnect(id) {
    this.registry.remove(id)
    return { profiles: this.registry.list() }
  }

  /**
   * List one remote directory level.
   * @param id - profile id.
   * @param path - absolute remote directory; omitted opens the profile's own root.
   * @param signal - cancels the round-trip when the caller navigates away.
   * @returns the listing, its ancestry, and the local mirror path it maps to.
   */
  async list(id, path, signal) {
    try {
      const listing = await this.registry.listDir(id, path, signal)
      return { ...listing, crumbs: crumbsOf(listing.path) }
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Create one remote directory under an existing parent.
   * @param id - profile id.
   * @param path - the existing parent directory.
   * @param name - one new directory name.
   * @returns the created absolute remote path.
   */
  async makeDirectory(id, path, name) {
    const trimmed = String(name ?? '').trim()
    if (trimmed === '' || trimmed.includes('/')) throw new RemoteError('remote-ssh/invalid-name', 'a new folder needs a single name without "/"')
    try {
      return await this.registry.makeDir(id, `${path === '/' ? '' : path}/${trimmed}`)
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Detached work: the commands still running on the hosts.
   *
   * Each record's state is re-read from its server, so opening the panel shows
   * what is true NOW rather than what was true when the harness last looked. Only
   * the most recent records are refreshed: a long-forgotten one costs a round trip
   * nobody is waiting for.
   * @returns the sessions, newest first, with fresh state where it was read.
   */
  async work() {
    const records = this.sessions.list()
    const refreshed = await Promise.all(records.slice(0, 10).map(async (record) => {
      try {
        const state = await this.sessions.status(record.id, { tailBytes: 2048 })
        return { ...record, state: state.state, exitCode: state.exitCode, bytes: state.bytes, tail: state.tail.trim().split('\n').slice(-1)[0] ?? '' }
      } catch (error) {
        return { ...record, unreachable: error instanceof Error ? error.message : String(error) }
      }
    }))
    return { sessions: [...refreshed, ...records.slice(10)] }
  }

  /**
   * Start one command that will keep running on the host after the harness closes.
   * @param profileId - which connected host to run on.
   * @param command - the shell source to run.
   * @param cwd - remote working directory.
   * @param label - a short name for the panel.
   * @returns the created record.
   */
  async workStart(profileId, command, cwd, label) {
    try {
      const record = await this.sessions.start(profileId, { command, cwd, label })
      return { id: record.id, pid: record.pid, label: record.label, state: 'running' }
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Cut one running command.
   * @param id - session id.
   * @returns its state after the signal.
   */
  async workStop(id) {
    try {
      const state = await this.sessions.stop(id)
      return { id, state: state.state, exitCode: state.exitCode }
    } catch (error) {
      throw asRemoteError(error)
    }
  }

  /**
   * Forget records.
   * @param id - one session id, or undefined with `finishedOnly`/`all`.
   * @param finishedOnly - drop what is known to have ended.
   * @param all - drop everything.
   * @returns how many were dropped.
   */
  async workForget(id, finishedOnly, all) {
    return { dropped: this.sessions.forget({ id, finishedOnly: finishedOnly === true, all: all === true }) }
  }

  /**
   * Adopt one remote folder as a workspace: create its local mirror, register
   * the workspace with a host-qualified title, and hand back the local path the
   * add-workspace flow must complete with.
   * @param id - profile id.
   * @param path - absolute remote directory that exists.
   * @param title - optional display title.
   * @returns the local mirror path and the workspace identity.
   */
  async adopt(id, path, title) {
    try {
      const result = await this.registry.addWorkspace(id, path, title)
      return { ...result, profiles: this.registry.list() }
    } catch (error) {
      throw asRemoteError(error)
    }
  }
}

/**
 * Ancestry of one absolute POSIX path, root first.
 * @param path - the absolute remote path.
 * @returns one crumb per ancestor, including the path itself.
 */
function crumbsOf(path) {
  const segments = String(path).split('/').filter((segment) => segment !== '')
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    crumbs.push({ name: segment, path: current })
  }
  return crumbs
}

markRemote(RemoteSshController.prototype, ['status', 'setEnabled', 'connect', 'test', 'disconnect', 'list', 'makeDirectory', 'adopt', 'work', 'workStart', 'workStop', 'workForget'])

export default RemoteSshController
