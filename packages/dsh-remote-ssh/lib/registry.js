/**
 * The remote SSH registry (`ctx.remoteSsh`): durable connection profiles, the
 * local mount mirror that gives every remote directory a stable local-path
 * identity, and the remote directory operations the workspace picker needs.
 *
 * The service is HOST-PLANE state. A profile added once is visible to every
 * session of every agent preset, because it lives in one JSON document under
 * the harness home rather than in session state, and because the mirror root
 * it owns is what a session's `cwd` points at.
 *
 * ## The mirror
 *
 * A workspace in this harness is a real local directory: session headers carry
 * a canonical local `cwd`, the workspace registry `realpath`s the path at
 * create, and the sidebar resolves sessions by comparing that canonical cwd.
 * A remote workspace therefore gets a real — but empty — local mirror
 * directory, `<root>/<profileId>/<remote/path>`, and the filesystem backend
 * translates every path under it into the remote path it mirrors. Nothing else
 * in the harness has to learn a new path vocabulary, and the few consumers
 * that bypass `ctx.fs` degrade to an empty directory instead of failing.
 *
 * @module dsh-remote-ssh/registry
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve as joinPath, sep } from 'node:path'
import { SshTransport, SshTransportError, shellQuote } from './ssh.js'
import { TRANSPORTS, isTailnetAddress, peerFor, tailnetPreflight, tailnetStatus } from './tailscale.js'

/** Validated configuration of the registry row. */
export const Config = z.object({
  /** Directory holding one mirror subtree per profile. */
  root: z.string().required(),
  /** Durable profile document. Holds credentials, so it is written mode 0600. */
  stateFile: z.string().required(),
  /** OpenSSH multiplexing socket directory. */
  controlDir: z.string().default(''),
  /** Connection timeout for one `ssh` invocation, in milliseconds. */
  connectTimeoutMs: z.natural().default(20000),
})

/** The settings namespace this plugin owns; the Plugins page renders its card. */
export const SETTINGS_NAMESPACE = 'remote-ssh'

/** Settings schema: the switch the Settings → Plugins card writes. */
const SETTINGS_SCHEMA = z.object({
  /** Master switch. Off, every remote path is treated as an ordinary local path. */
  enabled: z.boolean().default(true),
  /** Connection timeout for one `ssh` invocation, in milliseconds. */
  connectTimeoutMs: z.natural().default(20000),
  /** Host-key policy applied to new profiles. */
  strictHostKeyChecking: z.union([z.const('accept-new'), z.const('yes'), z.const('no')]).default('accept-new'),
})

/** A connection profile or directory name that is unusable as given. */
export class RemoteProfileError extends Error {
  /**
   * @param message - operator-facing description.
   * @param code - stable machine-routable code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'RemoteProfileError'
    this.code = code
  }
}

/** Normalize a user-supplied remote path to an absolute POSIX path. */
function normalizeRemotePath(path) {
  const trimmed = String(path ?? '').trim()
  if (trimmed === '') return ''
  const parts = []
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** Join an absolute remote path with one child segment. */
function remoteJoin(base, name) {
  const left = normalizeRemotePath(base)
  return left === '/' ? `/${name}` : `${left}/${name}`
}

/** A filesystem-safe id derived from a profile label or host. */
function slugify(value, fallback) {
  // Two anchored single-character strips, not `^-+|-+$`: the run-collapsing
  // replace above guarantees at most one leading and one trailing dash, and an
  // alternation of two quantified patterns is a polynomial backtracking hazard on
  // a long input (CodeQL js/polynomial-redos).
  const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug === '' ? fallback : slug.slice(0, 32)
}

/**
 * Durable registry of SSH connection profiles plus the local mirror tree that
 * makes a remote directory addressable as an ordinary workspace path.
 */
export class RemoteRegistry extends Service {
  static Config = Config

  /**
   * @param ctx - the host context; `workspaceRegistry` is read optionally.
   * @param config - mirror root, durable document path, and transport knobs.
   */
  constructor(ctx, config) {
    super(ctx, 'remoteSsh')
    this.config = config
    this.stateFile = config.stateFile
    this.root = config.root
    this.controlDir = config.controlDir === '' ? join(dirname(config.stateFile), 'ssh-mux') : config.controlDir
    /** Persisted profiles by id, in insertion order. */
    this.profiles = []
    /** Live transports by profile id; recreated when a profile is edited. */
    this.transports = new Map()
    /** Last successful probe per profile id, for the picker's status column. */
    this.facts = new Map()
    /**
     * The settings namespace this plugin owns. Registration is optional because
     * a headless deployment composes no settings provider; without one the
     * subsystem stays enabled and the composition is the only switch.
     */
    this.settingsScope = this.ctx.get('settings')?.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { applies: 'live' })
    this.load()
  }

  /**
   * Whether the operator left the subsystem switched on.
   *
   * The switch gates OFFERING remote workspaces (the workspace dialog and the
   * sidebar launcher), never ROUTING: a mirror path keeps resolving to its
   * remote world while the switch is off, because a session already living in
   * one must not silently start reading the empty local mirror instead.
   */
  get enabled() {
    return this.settingsScope?.get().enabled ?? true
  }

  /** The effective connection timeout: the settings layer over the row config. */
  get connectTimeoutMs() {
    return this.settingsScope?.get().connectTimeoutMs ?? this.config.connectTimeoutMs
  }

  /**
   * Flip the master switch.
   * @param value - the next `enabled` value.
   * @returns the settings value after the write.
   */
  async setEnabled(value) {
    await this.settingsScope?.update({ enabled: value === true })
    return { enabled: this.enabled, profiles: this.list() }
  }

  /** Read the durable document, tolerating absence and repairing a corrupt file by ignoring it. */
  load() {
    if (!existsSync(this.stateFile)) {
      this.profiles = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      this.profiles = Array.isArray(parsed.profiles) ? parsed.profiles.filter((entry) => typeof entry?.id === 'string' && typeof entry?.host === 'string') : []
    } catch (error) {
      this.ctx.logger?.warn?.(`remote-ssh: ignoring unreadable ${this.stateFile}: ${error.message}`)
      this.profiles = []
    }
    mkdirSync(this.root, { recursive: true })
    for (const profile of this.profiles) mkdirSync(this.mountRoot(profile.id), { recursive: true })
  }

  /** Persist the profile document atomically, mode 0600. */
  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, profiles: this.profiles }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.stateFile)
  }

  /**
   * Public projection of every profile, safe to serialize to a client.
   * @returns one entry per profile, with its last known connectivity facts.
   */
  list() {
    return this.profiles.map((profile) => {
      const facts = this.facts.get(profile.id)
      return {
        id: profile.id,
        label: profile.label,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        identityFile: profile.identityFile,
        hasPassword: profile.password !== '',
        strictHostKeyChecking: profile.strictHostKeyChecking,
        remoteRoot: profile.remoteRoot,
        transport: profile.transport ?? 'openssh',
        // Reported, never inferred: this badge says where the destination lives,
        // it does not change how the connection is made.
        tailnet: isTailnetAddress(profile.host),
        mountRoot: this.mountRoot(profile.id),
        createdAt: profile.createdAt,
        platform: facts?.platform,
        home: facts?.home,
        ripgrep: facts?.rg !== undefined,
      }
    })
  }

  /**
   * One profile by id.
   * @param id - profile id.
   * @returns the stored profile.
   * @throws {RemoteProfileError} with code `unknown-profile` when no profile carries that id.
   */
  require(id) {
    const profile = this.profiles.find((entry) => entry.id === id)
    if (profile === undefined) throw new RemoteProfileError(`unknown remote profile "${id}"`, 'unknown-profile')
    return profile
  }

  /**
   * Add one connection profile and create its mirror root.
   * @param input - connection fields; `label` defaults to `user@host`.
   * @returns the public projection of the created profile.
   * @throws {RemoteProfileError} with code `invalid-profile` on a missing or duplicate host identity.
   */
  add(input = {}) {
    const host = String(input.host ?? '').trim()
    if (host === '') throw new RemoteProfileError('host is required', 'invalid-profile')
    const user = String(input.user ?? '').trim()
    const port = input.port === undefined || input.port === '' ? 22 : Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RemoteProfileError('port must be an integer between 1 and 65535', 'invalid-profile')
    const label = String(input.label ?? '').trim() || `${user === '' ? '' : `${user}@`}${host}`
    const duplicate = this.profiles.find((entry) => entry.host === host && entry.port === port && entry.user === user)
    if (duplicate !== undefined) throw new RemoteProfileError(`"${label}" is already connected as profile "${duplicate.id}"`, 'duplicate-profile')
    const base = slugify(label, 'remote')
    let id = base
    for (let index = 2; this.profiles.some((entry) => entry.id === id); index += 1) id = `${base}-${index}`
    const transport = input.transport ?? 'openssh'
    if (!TRANSPORTS.includes(transport)) throw new RemoteProfileError(`unknown transport "${transport}"; expected one of ${TRANSPORTS.join(', ')}`, 'invalid-profile')
    // The durable shape: `path`-free (a profile names a host, not a folder), and
    // every field a string or a number so the document stays hand-editable.
    const profile = {
      id,
      label,
      host,
      port,
      transport,
      user,
      identityFile: String(input.identityFile ?? '').trim(),
      password: String(input.password ?? ''),
      strictHostKeyChecking: input.strictHostKeyChecking ?? this.settingsScope?.get().strictHostKeyChecking ?? 'accept-new',
      remoteRoot: normalizeRemotePath(input.remoteRoot ?? ''),
      extraOptions: Array.isArray(input.extraOptions) ? input.extraOptions.map(String) : [],
      createdAt: new Date().toISOString(),
    }
    this.profiles.push(profile)
    mkdirSync(this.mountRoot(id), { recursive: true })
    this.save()
    return this.list().find((entry) => entry.id === id)
  }

  /**
   * Edit one profile in place and drop its cached transport.
   * @param id - profile id.
   * @param patch - the fields to replace.
   * @returns the public projection after the edit.
   */
  update(id, patch = {}) {
    const profile = this.require(id)
    if (patch.label !== undefined) profile.label = String(patch.label).trim() || profile.label
    if (patch.host !== undefined && String(patch.host).trim() !== '') profile.host = String(patch.host).trim()
    if (patch.port !== undefined && patch.port !== '') profile.port = Number(patch.port)
    if (patch.user !== undefined) profile.user = String(patch.user).trim()
    if (patch.identityFile !== undefined) profile.identityFile = String(patch.identityFile).trim()
    if (patch.password !== undefined) profile.password = String(patch.password)
    if (patch.strictHostKeyChecking !== undefined) profile.strictHostKeyChecking = patch.strictHostKeyChecking
    if (patch.remoteRoot !== undefined) profile.remoteRoot = normalizeRemotePath(patch.remoteRoot)
    if (patch.transport !== undefined) {
      if (!TRANSPORTS.includes(patch.transport)) throw new RemoteProfileError(`unknown transport "${patch.transport}"; expected one of ${TRANSPORTS.join(', ')}`, 'invalid-profile')
      profile.transport = patch.transport
    }
    if (patch.extraOptions !== undefined) profile.extraOptions = Array.isArray(patch.extraOptions) ? patch.extraOptions.map(String) : []
    this.transports.delete(id)
    this.facts.delete(id)
    this.save()
    return this.list().find((entry) => entry.id === id)
  }

  /**
   * Forget one profile. Its mirror tree is left on disk: sessions already
   * living in it keep a valid local `cwd`, and reconnecting under the same id
   * restores the same path identity.
   * @param id - profile id.
   * @returns `true` when a profile was removed.
   */
  remove(id) {
    const index = this.profiles.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    this.profiles.splice(index, 1)
    this.transports.delete(id)
    this.facts.delete(id)
    this.save()
    return true
  }

  /**
   * The live transport for one profile, created on first use.
   * @param id - profile id.
   * @returns the transport bound to that profile.
   */
  transport(id) {
    const profile = this.require(id)
    let transport = this.transports.get(id)
    if (transport === undefined) {
      transport = new SshTransport(profile, { controlDir: this.controlDir, connectTimeoutMs: this.connectTimeoutMs })
      this.transports.set(id, transport)
    }
    return transport
  }

  /**
   * Reach the host and record its facts.
   * @param id - profile id.
   * @returns a report describing success, the discovered platform, and the login directory.
   */
  async test(id) {
    const profile = this.require(id)
    const transport = this.transport(id)
    transport.facts = undefined
    // A tailnet peer that is offline fails as a connect timeout, which reads as a
    // broken server. Asking Tailscale first turns that into an answer.
    const blocked = await this.tailnetObstacle(profile)
    if (blocked !== undefined) return { ok: false, error: blocked, code: 'tailnet-offline' }
    try {
      const facts = await transport.probe()
      this.facts.set(id, facts)
      return { ok: true, platform: facts.platform, shell: facts.shell, home: facts.home, user: facts.user, ripgrep: facts.rg }
    } catch (error) {
      this.facts.delete(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error), code: error instanceof SshTransportError ? 'ssh-failed' : 'probe-failed' }
    }
  }

  /**
   * The local tailnet, for the connect form's peer picker.
   *
   * Read-only and best effort: a machine without Tailscale reports unavailable
   * rather than failing, which is what lets the browser half render the section
   * only when there is something to show.
   * @returns the tailnet state, or an unavailable result with the reason.
   */
  async tailnet() {
    return await tailnetStatus({})
  }

  /**
   * Why a profile cannot be reached at all, when that is knowable without trying.
   * @param profile - the profile about to be probed.
   * @returns the message to report, or undefined when the attempt should proceed.
   */
  async tailnetObstacle(profile) {
    if (!isTailnetAddress(profile.host)) return undefined
    const tailnet = await this.tailnet()
    if (!tailnet.available) return `"${profile.host}" looks like a tailnet destination, but Tailscale is not usable here: ${tailnet.error}`
    if (tailnet.backendState !== 'Running') return `"${profile.host}" looks like a tailnet destination, but the local Tailscale backend is ${tailnet.backendState}.`
    return tailnetPreflight(profile.host, peerFor(tailnet, profile.host))
  }

  /** Directory holding one profile's mirror tree. */
  mountRoot(id) {
    return join(this.root, id)
  }

  /**
   * Map an absolute LOCAL path to its remote world, when it lives under a mirror.
   * @param absolutePath - a local absolute path.
   * @returns the owning profile and the remote path it mirrors, or undefined for a purely local path.
   */
  worldOf(absolutePath) {
    if (typeof absolutePath !== 'string' || absolutePath === '') return undefined
    const candidate = joinPath(absolutePath)
    for (const profile of this.profiles) {
      const mount = this.mountRoot(profile.id)
      if (candidate !== mount && !candidate.startsWith(mount.endsWith(sep) ? mount : `${mount}${sep}`)) continue
      const relative = candidate === mount ? '' : candidate.slice(mount.length + 1)
      return { profile, mountRoot: mount, remotePath: relative === '' ? '/' : `/${relative.split(sep).join('/')}` }
    }
    return undefined
  }

  /**
   * Map a remote path back to its mirror path, creating nothing.
   * @param id - profile id.
   * @param remotePath - absolute remote path.
   * @returns the absolute local mirror path.
   */
  localPathOf(id, remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    const relative = normalized.split('/').filter((segment) => segment !== '')
    return join(this.mountRoot(id), ...relative)
  }

  /**
   * Create the mirror directory chain for one remote folder so the harness can
   * register it as a workspace.
   * @param id - profile id.
   * @param remotePath - absolute remote directory that exists.
   * @returns the absolute local mirror path.
   */
  ensureMirror(id, remotePath) {
    const local = this.localPathOf(id, remotePath)
    mkdirSync(local, { recursive: true })
    return local
  }

  /**
   * List one remote directory level, as the picker and the workspace menu need it.
   * @param id - profile id.
   * @param remotePath - absolute remote directory; omitted lists the profile's default root.
   * @param signal - aborts the round-trip.
   * @returns the listing with its ancestry and the resolved absolute path.
   */
  async listDir(id, remotePath, signal) {
    const transport = this.transport(id)
    const profile = this.profileOf(id)
    const facts = this.facts.get(id) ?? (await transport.probe({ signal }))
    this.facts.set(id, facts)
    const requested = remotePath === undefined || remotePath === '' ? profile.remoteRoot || facts.home || '/' : remotePath
    const resolved = await this.realpath(id, requested, signal)
    const script = [
      `cd ${shellQuote(resolved)} || exit 66`,
      'for entry in * .[!.]* ..?*; do',
      '  [ -e "$entry" ] || [ -L "$entry" ] || continue',
      '  if [ -L "$entry" ]; then kind=l; elif [ -d "$entry" ]; then kind=d; else kind=f; fi',
      '  printf "%s\\t%s\\n" "$kind" "$entry"',
      'done',
      'exit 0',
    ].join('\n')
    const text = await transport.runChecked(script, { signal, maxBytes: 8 * 1024 * 1024 })
    const entries = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const kind = line.slice(0, tab)
      const name = line.slice(tab + 1)
      if (name === '.' || name === '..') continue
      entries.push({ name, type: kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : 'file', path: remoteJoin(resolved, name) })
    }
    entries.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : right.type === 'directory' ? 1 : 0))
    return { path: resolved, entries, home: facts.home, profile: profile.id, mountRoot: this.mountRoot(id), localPath: this.localPathOf(id, resolved) }
  }

  /**
   * Canonicalize a remote path, mirroring the local backend's rule: realpath the
   * deepest existing ancestor and re-append the missing suffix, so a path that
   * does not exist yet still resolves to a stable identity.
   * @param id - profile id.
   * @param remotePath - absolute or `~`-relative remote path.
   * @param signal - aborts the round-trip.
   * @returns the absolute canonical remote path.
   */
  async realpath(id, remotePath, signal) {
    const transport = this.transport(id)
    const facts = await transport.probe({ signal })
    const raw = String(remotePath ?? '')
    const expanded = raw.startsWith('~') ? `${facts.home ?? ''}${raw.slice(1)}` : raw
    const script = [
      `target=${shellQuote(expanded)}`,
      'missing=""',
      'current="$target"',
      'while [ -n "$current" ]; do',
      '  if resolved=$(realpath -- "$current" 2>/dev/null) || resolved=$(readlink -f -- "$current" 2>/dev/null); then',
      '    printf "%s%s\\n" "$resolved" "$missing"',
      '    exit 0',
      '  fi',
      '  base=${current##*/}',
      '  missing="/$base$missing"',
      '  rest=${current%/*}',
      '  if [ "$rest" = "$current" ]; then current=""; else current="$rest"; fi',
      'done',
      'printf "%s\\n" "$target"',
    ].join('\n')
    const text = await transport.runChecked(`${script}\n`, { signal, maxBytes: 64 * 1024 })
    return text.trim() === '' ? raw : text.trim()
  }

  /**
   * Create one remote directory (and its ancestors).
   * @param id - profile id.
   * @param remotePath - absolute remote directory to create.
   */
  async makeDir(id, remotePath) {
    const transport = this.transport(id)
    const target = normalizeRemotePath(remotePath)
    if (target === '' || target === '/') throw new RemoteProfileError('a remote directory name is required', 'invalid-path')
    await transport.runChecked(`mkdir -p -- ${shellQuote(target)}`)
    this.ensureMirror(id, target)
    return target
  }

  /** The stored profile record (with credentials) behind an id. */
  profileOf(id) {
    return this.require(id)
  }

  /**
   * Register a remote folder as a workspace: create its local mirror and hand
   * that mirror path to the workspace registry, which is what makes the folder
   * appear in the sidebar like any other workspace.
   * @param id - profile id.
   * @param remotePath - absolute remote directory that exists.
   * @param title - display title; omitted derives from the remote path.
   * @returns the local mirror path and the workspace identity when the registry is present.
   */
  async addWorkspace(id, remotePath, title) {
    const profile = this.require(id)
    const resolved = await this.realpath(id, remotePath)
    const listing = await this.listDir(id, resolved)
    const local = this.ensureMirror(id, resolved)
    const registry = this.ctx.get('workspaceRegistry')
    const derivedTitle = title === undefined || String(title).trim() === '' ? `${profile.label}:${resolved}` : String(title).trim()
    if (registry === undefined) return { localPath: local, remotePath: resolved, workspace: undefined, entries: listing.entries.length }
    const workspace = await registry.create(local, derivedTitle)
    return { localPath: local, remotePath: resolved, workspace: { id: workspace.id, title: workspace.title, path: workspace.path }, entries: listing.entries.length }
  }

  /**
   * The remote path a local mirror path stands for, or undefined when the path
   * belongs to no profile. Used by the filesystem, shell, and subprocess layers.
   * @param localPath - an absolute local path.
   * @returns the profile and remote path.
   */
  resolveWorld(localPath) {
    return this.worldOf(localPath)
  }

  /** Close every multiplexed master connection. */
  async dispose() {
    await Promise.all([...this.transports.values()].map((transport) => transport.close()))
    this.transports.clear()
  }
}

/** The service name this plugin publishes. */
export const name = 'remote-ssh'

export default RemoteRegistry
