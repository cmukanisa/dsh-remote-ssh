/**
 * `RemoteFileSystem`: the composed `ctx.fs` provider. It IS the sandboxed local
 * backend for every local path, and a second, SSH-backed execution world for
 * every path that lives under a remote profile's mirror root.
 *
 * The split is invisible to consumers. A session whose `cwd` is a mirror path
 * gets remote reads, remote listings, remote atomic writes, and remote literal
 * edits out of the same `ctx.fs` calls the local tools already make, because
 * the target key a remote path resolves to is the mirror path it came from —
 * the same identity vocabulary the workspace registry, the session header, and
 * the sidebar already use.
 *
 * Containment mirrors `@deepseek-ai/dsh-fs-sandbox`: `read-only` refuses every
 * remote mutation, and `workspace-write` refuses any remote target whose
 * canonical mirror path is not under the per-call workspace root. The check is
 * canonicalize-then-contain over the REMOTE realpath, so it keeps the same
 * guarantee the local fence does — a policy check in trusted code, not a kernel
 * boundary.
 *
 * @module dsh-remote-ssh/fs
 */
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { SshTransportError, shellQuote } from './ssh.js'

/** Bytes sampled for the binary (NUL) check, matching the local backend's window. */
const BINARY_SAMPLE_BYTES = 8192

/** Remote absolute path of a target key, or undefined for a local target. */
function remotePathOfKey(key) {
  return typeof key === 'string' && key.startsWith('ssh://') ? key : undefined
}

/** Abort check shared by every remote operation. */
function throwIfAborted(signal, verb) {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/** Translate a transport failure into the seam's structured error taxonomy. */
function ioError(error, displayPath, verb) {
  if (error instanceof FsError) return error
  if (error instanceof SshTransportError) {
    const stderr = error.stderr ?? ''
    if (/No such file or directory|not found/i.test(stderr) && error.exitCode === 1) return new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND')
    if (/Permission denied/i.test(stderr)) return new FsError(`cannot ${verb} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
    return new FsError(`cannot ${verb} "${displayPath}": ${error.message}`, 'FS_IO_ERROR', { cause: error })
  }
  return new FsError(`cannot ${verb} "${displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
}

/** Collapse CRLF to LF: the canonical in-memory form for edits and diff bases. */
function normalizeLineEndings(content) {
  return content.split('\r\n').join('\n')
}

/** Whether the raw text reads as CRLF-dominant over its first 4 KiB. */
function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

/** Convert LF-normalized text back to the style detected at read time. */
function restoreLineEndings(content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Count non-overlapping occurrences of `needle`. */
function countOccurrences(content, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement with the local backend's exact rules: an empty
 * search string or zero matches is `FS_EDIT_NOT_FOUND`, and more than one match
 * without `replaceAll` is `FS_AMBIGUOUS_EDIT`.
 */
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (!replaceAll && replacements > 1) throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

/** Decode UTF-8 strictly, raising the seam's `FS_NOT_TEXT` on invalid bytes. */
function decodeUtf8(buffer, verb, displayPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

/**
 * The composed filesystem provider: local by default, remote under a mirror root.
 */
export class RemoteFileSystem extends SandboxedFileSystem {
  static inject = ['remoteSsh', 'sandboxPolicy']

  /**
   * @param ctx - host context carrying the remote registry and sandbox policy.
   * @param config - the local backend's config, unchanged.
   */
  constructor(ctx, config) {
    super(ctx, config)
    /** Remote realpath results, so a burst of operations on one path costs one round-trip. */
    this.realpathCache = new Map()
  }

  /** The remote registry. */
  get registry() {
    return this.ctx.remoteSsh
  }

  /** Whether a local absolute path belongs to a remote mirror. */
  worldOf(localPath) {
    return this.registry.worldOf(localPath)
  }

  /** The world a resolved target lives in, or undefined for a purely local target. */
  worldOfTarget(target) {
    return this.registry.worldOf(target.targetKey)
  }

  /** Drop cached realpath results for one profile; called after every remote mutation. */
  invalidate(profileId) {
    for (const key of [...this.realpathCache.keys()]) if (key.startsWith(`${profileId}\u0000`)) this.realpathCache.delete(key)
  }

  /**
   * Remote realpath with a short TTL cache. The cache exists because one model
   * call fans out into several round-trips on the same path; it is invalidated
   * on every remote mutation of that profile.
   */
  async remoteRealpath(profileId, remotePath, signal) {
    const key = `${profileId}\u0000${remotePath}`
    const cached = this.realpathCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 2000) return cached.path
    const path = await this.registry.realpath(profileId, remotePath, signal)
    this.realpathCache.set(key, { path, at: Date.now() })
    return path
  }

  /**
   * Resolve a model- or plugin-supplied path into a stable target.
   *
   * A path under a mirror root — or an explicit `ssh://<profile>/<path>` URI —
   * resolves in the remote world: the remote realpath becomes the target
   * identity, re-expressed as the canonical mirror path, and the display path
   * stays the absolute local spelling the caller used.
   */
  async resolve(path, opts) {
    throwIfAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const uri = parseRemoteUri(path, this.registry)
    const absolute = uri !== undefined ? this.registry.localPathOf(uri.profileId, uri.remotePath) : isAbsolute(path) ? resolvePath(path) : resolvePath(opts?.cwd ?? this.config.cwd, path)
    const world = uri !== undefined ? { profile: this.registry.require(uri.profileId), remotePath: uri.remotePath } : this.worldOf(absolute)
    if (world === undefined) return super.resolve(path, opts)
    try {
      const canonical = await this.remoteRealpath(world.profile.id, world.remotePath, opts?.signal)
      throwIfAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(this.registry.localPathOf(world.profile.id, canonical)), displayPath: absolute }
    } catch (error) {
      throw ioError(error, absolute, 'resolve')
    }
  }

  /** The canonical path a subprocess in this target's world opens (the mirror path). */
  processPath(target) {
    return String(target.targetKey)
  }

  /** Map an absolute local path into this provider's world when it is the same file. */
  processPathFromHostPath(hostPath) {
    if (!isAbsolute(hostPath)) return undefined
    const world = this.worldOf(resolvePath(hostPath))
    if (world === undefined) return super.processPathFromHostPath(hostPath)
    return this.registry.localPathOf(world.profile.id, world.remotePath)
  }

  /**
   * Canonical URI of a target. Remote targets use `ssh://<profileId>/<path>`
   * with per-segment percent-encoding, which keeps the UI's URL-relative path
   * computation exact for paths containing spaces or `#`.
   */
  fileUrl(target) {
    const remotePath = this.remotePathFor(target)
    if (remotePath === undefined) return super.fileUrl(target)
    const world = this.worldOf(target.targetKey)
    const encoded = remotePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `ssh://${world.profile.id}${encoded}`
  }

  /** Canonical containment over mirror paths. */
  contains(parent, child) {
    const left = this.processPath(parent)
    const right = this.processPath(child)
    if (left === right) return true
    const rel = relative(left, right)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }

  /** The remote absolute path behind a target, or undefined for a local target. */
  remotePathFor(target) {
    const world = this.worldOf(target.targetKey)
    return world === undefined ? undefined : world.remotePath
  }

  /** The transport of the profile owning a target. */
  transportFor(target) {
    return this.registry.transport(this.worldOf(target.targetKey).profile.id)
  }

  /**
   * Probe one remote path.
   * @returns the metadata, or undefined when the path is absent.
   */
  async remoteProbe(profileId, remotePath, follow, signal) {
    const transport = this.registry.transport(profileId)
    const facts = await transport.probe({ signal })
    const test = follow ? ['if [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi', 'read size mtime inode mode <<EOF', follow ? `$(stat -Lc '%s %Y %i %a' -- "$p" 2>/dev/null || echo "0 0 0 0")` : '$(true)', 'EOF'].join('\n') : null
    const statArgs = facts.stat === 'gnu' ? `-${follow ? 'L' : ''}c '%s|%Y|%i|%a'` : `-${follow ? 'L' : ''}f '%z|%m|%i|%Lp'`
    const typeTest = follow ? 'if [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi' : 'if [ -L "$p" ]; then t=symlink; elif [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi'
    const script = [`p=${shellQuote(remotePath)}`, 'if [ ! -e "$p" ] && [ ! -L "$p" ]; then exit 3; fi', typeTest, `meta=$(stat ${statArgs} -- "$p" 2>/dev/null) || meta="0|0|0|0"`, 'printf "%s\\t%s\\n" "$t" "$meta"'].join('\n')
    void test
    let result
    try {
      result = await transport.run(script, { signal, maxBytes: 64 * 1024 })
    } catch (error) {
      throw ioError(error, remotePath, 'stat')
    }
    if (result.code === 3) return undefined
    if (result.code !== 0) throw ioError(new SshTransportError(`stat exited ${result.code}: ${result.stderr.trim()}`, { exitCode: result.code, stderr: result.stderr }), remotePath, 'stat')
    const [type, meta] = result.stdout.toString('utf8').trim().split('\t')
    const [size, mtime, inode, mode] = (meta ?? '0|0|0|0').split('|')
    // `stat` prints permission bits as OCTAL DIGITS, so they are parsed base 8;
    // reading them base 10 turns 644 into 420 and every later chmod corrupts the
    // file it was meant to preserve.
    const permissions = Number.parseInt(mode ?? '0', 8) || 0
    return { type, size: Number(size), mtime: Number(mtime), inode: Number(inode), mode: permissions, version: FsVersion(`${inode}:${size}:${mtime}:${mode}`) }
  }

  /** {@link FileSystem.stat} for the remote world. */
  async remoteStat(profileId, remotePath, follow, signal) {
    const info = await this.remoteProbe(profileId, remotePath, follow, signal)
    if (info === undefined) return undefined
    return { version: info.version, type: info.type === 'symlink' ? (follow ? 'other' : 'symlink') : info.type, size: info.size }
  }

  /** {@link FileSystem.stat}, routed. */
  async stat(target, signal) {
    const world = this.worldOfTarget(target)
    if (world === undefined) return super.stat(target, signal)
    throwIfAborted(signal, 'stat')
    const info = await this.remoteStat(world.profile.id, world.remotePath, true, signal)
    throwIfAborted(signal, 'stat')
    return info === undefined ? undefined : { version: info.version, type: info.type, size: info.size }
  }

  /** {@link FileSystem.lstat}, routed. */
  async lstat(path, opts, signal) {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const uri = parseRemoteUri(path, this.registry)
    const absolute = uri !== undefined ? this.registry.localPathOf(uri.profileId, uri.remotePath) : isAbsolute(path) ? resolvePath(path) : resolvePath(opts?.cwd ?? this.config.cwd, path)
    const world = uri !== undefined ? { profile: this.registry.require(uri.profileId), remotePath: uri.remotePath } : this.worldOf(absolute)
    if (world === undefined) return super.lstat(path, opts, signal)
    throwIfAborted(signal, 'lstat')
    const info = await this.remoteStat(world.profile.id, world.remotePath, false, signal)
    if (info === undefined) return undefined
    return { version: info.version, type: info.type === 'symlink' ? 'symlink' : info.type, size: info.size }
  }

  /** Run one remote script for a target, mapping failures into the seam's taxonomy. */
  async runFor(target, script, options = {}) {
    const world = this.worldOfTarget(target)
    const transport = this.registry.transport(world.profile.id)
    try {
      return await transport.run(script, options)
    } catch (error) {
      throw ioError(error, target.displayPath, options.verb ?? 'read')
    }
  }

  /** Require a regular remote file, mirroring the local backend's error vocabulary. */
  async requireRemoteFile(target, verb, signal) {
    const world = this.worldOfTarget(target)
    const info = await this.remoteStat(world.profile.id, world.remotePath, true, signal)
    if (info === undefined) {
      this.ctx.emit('fs/observed', target, { kind: 'absent' }, undefined)
      throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return { world, info }
  }

  /**
   * Require the remote parent directory of a target to exist.
   *
   * The mirror tree is created locally, so a path whose remote parent is
   * missing would otherwise reach the remote `cat`/`mv` and come back as an
   * opaque shell diagnostic. This turns that into the seam's own `FS_NOT_FOUND`
   * naming the directory that is actually absent.
   */
  async requireRemoteParent(profileId, remotePath, displayPath, verb, signal) {
    const slash = remotePath.lastIndexOf('/')
    const directory = slash <= 0 ? '/' : remotePath.slice(0, slash)
    const info = await this.remoteStat(profileId, directory, true, signal)
    if (info === undefined) throw new FsError(`cannot ${verb} "${displayPath}": parent directory "${directory}" does not exist`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot ${verb} "${displayPath}": parent path "${directory}" is not a directory`, 'FS_NOT_FOUND')
    return directory
  }

  /** {@link FileSystem.readText}, routed. */
  async readText(target, signal) {
    if (this.worldOfTarget(target) === undefined) return super.readText(target, signal)
    throwIfAborted(signal, 'read')
    await this.requireRemoteFile(target, 'read', signal)
    const result = await this.runFor(target, `cat -- ${shellQuote(this.remotePathFor(target))}`, { signal, verb: 'read' })
    throwIfAborted(signal, 'read')
    if (result.code !== 0) throw new FsError(`cannot read "${target.displayPath}": ${result.stderr.trim() || `remote cat exited ${result.code}`}`, 'FS_IO_ERROR')
    if (result.stdout.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    return decodeUtf8(result.stdout, 'read', target.displayPath)
  }

  /** {@link FileSystem.streamText}, routed: chunks arrive as the remote writes them. */
  async streamText(target, signal) {
    if (this.worldOfTarget(target) === undefined) return super.streamText(target, signal)
    await this.requireRemoteFile(target, 'read', signal)
    const world = this.worldOfTarget(target)
    const transport = this.registry.transport(world.profile.id)
    const child = transport.spawnRaw(transport.wrap(`cat -- ${shellQuote(world.remotePath)}`), { signal })
    const displayPath = target.displayPath
    async function* chunks() {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let sampled = 0
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      try {
        for await (const chunk of child.stdout) {
          if (sampled < BINARY_SAMPLE_BYTES) {
            const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampled))
            sampled += sample.length
            if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
          }
          let text
          try {
            text = decoder.decode(chunk, { stream: true })
          } catch (error) {
            if (!(error instanceof TypeError)) throw error
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
          }
          if (text !== '') yield text
        }
        const tail = decoder.decode()
        if (tail !== '') yield tail
      } finally {
        child.kill()
        void stderr
      }
    }
    return chunks()
  }

  /** {@link FileSystem.readBytes}, routed with the same inclusive byte cap. */
  async readBytes(target, signal, maxBytes) {
    if (this.worldOfTarget(target) === undefined) return super.readBytes(target, signal, maxBytes)
    const { info } = await this.requireRemoteFile(target, 'read', signal)
    if (info.size !== undefined && info.size > maxBytes) throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    const result = await this.runFor(target, `head -c ${maxBytes + 1} -- ${shellQuote(this.remotePathFor(target))}`, { signal, verb: 'read' })
    if (result.code !== 0) throw new FsError(`cannot read "${target.displayPath}": ${result.stderr.trim() || `remote read exited ${result.code}`}`, 'FS_IO_ERROR')
    if (result.stdout.length > maxBytes) throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    return new Uint8Array(result.stdout)
  }

  /** {@link FileSystem.readByteRange}, routed through a byte-window read. */
  async readByteRange(target, range, signal) {
    if (this.worldOfTarget(target) === undefined) return super.readByteRange(target, range, signal)
    await this.requireRemoteFile(target, 'read', signal)
    if (range.length === 0) return new Uint8Array(0)
    const path = shellQuote(this.remotePathFor(target))
    const result = await this.runFor(target, `tail -c +${range.offset + 1} -- ${path} | head -c ${range.length}`, { signal, verb: 'read' })
    if (result.code !== 0) throw new FsError(`cannot read "${target.displayPath}": ${result.stderr.trim() || `remote window read exited ${result.code}`}`, 'FS_IO_ERROR')
    return new Uint8Array(result.stdout)
  }

  /**
   * {@link FileSystem.listDir}, routed through one NUL-delimited remote scan so
   * names with spaces, quotes, or newlines survive the trip intact.
   */
  async listDir(target, signal) {
    const world = this.worldOfTarget(target)
    if (world === undefined) return super.listDir(target, signal)
    throwIfAborted(signal, 'list')
    const info = await this.remoteStat(world.profile.id, world.remotePath, true, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const script = [
      `cd ${shellQuote(world.remotePath)} || exit 66`,
      'for entry in * .[!.]* ..?*; do',
      '  [ -e "$entry" ] || [ -L "$entry" ] || continue',
      '  if [ -L "$entry" ]; then kind=l; elif [ -d "$entry" ]; then kind=d; else kind=f; fi',
      '  printf "%s\\t%s\\n" "$kind" "$entry"',
      'done',
      'exit 0',
    ].join('\n')
    const result = await this.runFor(target, script, { signal, verb: 'list', maxBytes: 16 * 1024 * 1024 })
    if (result.code !== 0) throw new FsError(`cannot list "${target.displayPath}": ${result.stderr.trim() || `remote listing exited ${result.code}`}`, 'FS_IO_ERROR')
    const entries = []
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const kind = line.slice(0, tab)
      const name = line.slice(tab + 1)
      if (name === '.' || name === '..') continue
      entries.push({ name, kind })
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    throwIfAborted(signal, 'list')
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.kind === 'd' ? 'directory' : entry.kind === 'l' ? 'other' : 'file',
      target: {
        targetKey: FsTargetKey(join(this.processPath(target), entry.name)),
        displayPath: join(target.displayPath, entry.name),
      },
    }))
  }

  /**
   * The remote mutation fence. Returns the exact target to mutate, after
   * re-canonicalizing it so the checked identity is the mutated one.
   */
  async checkedRemoteTarget(target, sandboxPolicy, displayVerb) {
    const world = this.worldOfTarget(target)
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return world
    if (policy.mode === 'read-only') throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    const canonical = await this.remoteRealpath(world.profile.id, world.remotePath)
    const mirror = this.registry.localPathOf(world.profile.id, canonical)
    const rootWorld = this.worldOf(resolvePath(policy.workspaceRoot))
    const withinRoot = rootWorld !== undefined && rootWorld.profile.id === world.profile.id ? isUnder(this.registry.localPathOf(rootWorld.profile.id, rootWorld.remotePath), mirror) : false
    if (!withinRoot) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    void displayVerb
    return { profile: world.profile, remotePath: canonical, mirror }
  }

  /** Best-effort remote diff basis: the prior content, or null when unusable. */
  async remoteDiffBasis(profileId, remotePath, maxBytes) {
    try {
      const transport = this.registry.transport(profileId)
      const result = await transport.run(`head -c ${maxBytes} -- ${shellQuote(remotePath)}`, { maxBytes })
      if (result.code !== 0) return null
      const raw = result.stdout
      if (raw.includes(0)) return null
      if (raw.length >= maxBytes) return null
      try {
        return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(raw))
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  /**
   * {@link FileSystem.writeText}, routed: fence, optional version guard, then one
   * atomic temp-file-plus-rename publication on the remote host.
   */
  async writeText(target, content, expected, signal, sandboxPolicy) {
    if (this.worldOfTarget(target) === undefined) return super.writeText(target, content, expected, signal, sandboxPolicy)
    return this.withLock(target.targetKey, () => this.remoteWrite(target, content, expected, signal, sandboxPolicy))
  }

  /**
   * The guarded remote write body, under the per-target lock.
   *
   * The lock is the local backend's own (`withLock`), so a remote target gets the
   * same read→guard→write serialization a local one gets: concurrent writes to
   * one remote file are ordered, one wins, and the rest observe the new version
   * and fail as stale rather than interleaving two temp files into one path.
   */
  async remoteWrite(target, content, expected, signal, sandboxPolicy) {
    throwIfAborted(signal, 'write')
    const checked = await this.checkedRemoteTarget(target, sandboxPolicy, 'write')
    const { profile, remotePath, mirror } = checked
    const transport = this.registry.transport(profile.id)
    const directory = await this.requireRemoteParent(profile.id, remotePath, target.displayPath, 'write', signal)
    const existing = await this.remoteProbe(profile.id, remotePath, true, signal)
    if (existing !== undefined && existing.type !== 'file') throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    const before = existing !== undefined && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes ? await this.remoteDiffBasis(profile.id, remotePath, this.config.diffBasisMaxBytes) : null
    const script = atomicWriteScript(remotePath, existing?.mode ?? DEFAULT_FILE_MODE)
    const result = await this.runFor(target, script, { stdin: Buffer.from(content, 'utf8'), signal, verb: 'write' })
    if (result.code !== 0) throw new FsError(`cannot write "${target.displayPath}": ${result.stderr.trim() || `remote write exited ${result.code}`}`, 'FS_IO_ERROR')
    this.invalidate(profile.id)
    const after = await this.remoteProbe(profile.id, mirror === undefined ? remotePath : remotePath, true, signal)
    return {
      operation: existing === undefined ? 'create' : 'update',
      version: after?.version ?? FsVersion(`missing:${remotePath}`),
      before,
      after: normalizeLineEndings(content),
    }
  }

  /**
   * {@link FileSystem.editText}, routed: one read-match-write critical section
   * against the remote file, with the same staleness, ambiguity, and
   * line-ending rules as the local backend.
   */
  async editText(target, edit, expected, signal, sandboxPolicy) {
    if (this.worldOfTarget(target) === undefined) return super.editText(target, edit, expected, signal, sandboxPolicy)
    return this.withLock(target.targetKey, () => this.remoteEdit(target, edit, expected, signal, sandboxPolicy))
  }

  /** The read-match-write remote edit body, under the per-target lock. */
  async remoteEdit(target, edit, expected, signal, sandboxPolicy) {
    throwIfAborted(signal, 'edit')
    const checked = await this.checkedRemoteTarget(target, sandboxPolicy, 'edit')
    const { profile, remotePath } = checked
    const transport = this.registry.transport(profile.id)
    const existing = await this.remoteProbe(profile.id, remotePath, true, signal)
    if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && existing.version !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    const read = await transport.run(`cat -- ${shellQuote(remotePath)}`, { signal, maxBytes: 64 * 1024 * 1024 })
    if (read.code !== 0) throw new FsError(`cannot edit "${target.displayPath}": ${read.stderr.trim() || `remote read exited ${read.code}`}`, 'FS_IO_ERROR')
    if (read.stdout.includes(0)) throw new FsError(`cannot edit "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    const raw = decodeUtf8(read.stdout, 'edit', target.displayPath)
    const original = normalizeLineEndings(raw)
    const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
    const content = restoreLineEndings(edited.content, detectLineEndings(raw))
    const script = atomicWriteScript(remotePath, existing.mode)
    const result = await this.runFor(target, script, { stdin: Buffer.from(content, 'utf8'), signal, verb: 'edit' })
    if (result.code !== 0) throw new FsError(`cannot edit "${target.displayPath}": ${result.stderr.trim() || `remote edit exited ${result.code}`}`, 'FS_IO_ERROR')
    this.invalidate(profile.id)
    const after = await this.remoteProbe(profile.id, remotePath, true, signal)
    return { version: after?.version ?? FsVersion(`missing:${remotePath}`), before: original, after: edited.content }
  }
}


/** Creation mode for a remote file with no prior version. */
const DEFAULT_FILE_MODE = 0o644

/**
 * Build the remote publication script for one atomic write.
 *
 * The temp file is a sibling of the target, so `mv` stays inside one filesystem
 * (`rename` across filesystems fails with `EXDEV`) and the replacement is atomic.
 * `chmod` receives the mode as an OCTAL STRING: `chmod 420` would be read as
 * octal `0420`, which is how a file once landed as write-only.
 * @param remotePath - the absolute target path.
 * @param mode - the permissions to preserve, or the create default.
 * @returns POSIX shell source reading the new content from stdin.
 */
function atomicWriteScript(remotePath, mode) {
  const directory = remotePath.slice(0, remotePath.lastIndexOf('/')) || '/'
  const temporary = `${directory}/.dsh-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const permissions = (Number(mode) & 0o777).toString(8)
  return [
    `tmp=${shellQuote(temporary)}`,
    `target=${shellQuote(remotePath)}`,
    "trap 'rm -f \"$tmp\"' EXIT",
    `cat > "$tmp" || exit 74`,
    permissions === '0' ? ':' : `chmod ${permissions} "$tmp" 2>/dev/null || true`,
    `mv -f "$tmp" "$target" || exit 75`,
    'trap - EXIT',
    'exit 0',
  ].join('\n')
}

/** Canonical containment over two already-canonical absolute paths. */
function isUnder(root, candidate) {
  if (root === candidate) return true
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Parse an explicit `ssh://<profile>/<path>` reference. */
function parseRemoteUri(path, registry) {
  if (!path.startsWith('ssh://')) return undefined
  const rest = path.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  const profileId = slash < 0 ? rest : rest.slice(0, slash)
  const remotePath = slash < 0 ? '/' : rest.slice(slash)
  if (profileId === '' || registry.list().every((entry) => entry.id !== profileId)) return undefined
  return { profileId, remotePath: decodeURIComponent(remotePath) }
}

export { applyLiteralEdit, atomicWriteScript, isUnder }
export default RemoteFileSystem
