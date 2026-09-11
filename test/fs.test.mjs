/**
 * Standalone exercise of the remote filesystem, shell, and subprocess layers
 * against a real SSH host — no harness boot required.
 *
 * The suite owns a fresh directory per run, so it is repeatable against the same
 * host and never depends on state a previous run left behind.
 *
 * Environment (all optional):
 *   DSH_SSH_TEST_HOST, DSH_SSH_TEST_PORT, DSH_SSH_TEST_USER,
 *   DSH_SSH_TEST_KEY, DSH_SSH_TEST_ROOT, DSH_SSH_TEST_KNOWN_HOSTS
 *
 * Usage: node test/fs.test.mjs [host] [port] [user] [identityFile] [remoteRoot]
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { RemoteRegistry } from '../packages/dsh-remote-ssh/lib/registry.js'
import { RemoteFileSystem } from '../packages/dsh-remote-ssh/lib/fs.js'

const env = process.env
const [host = env.DSH_SSH_TEST_HOST ?? '127.0.0.1', port = env.DSH_SSH_TEST_PORT ?? '2222', user = env.DSH_SSH_TEST_USER ?? 'dsh', identityFile = env.DSH_SSH_TEST_KEY ?? '/tmp/dsh-ssh-test/id_test', remoteRoot = env.DSH_SSH_TEST_ROOT ?? '/tmp'] = process.argv.slice(2)
const knownHosts = env.DSH_SSH_TEST_KNOWN_HOSTS
const extraOptions = knownHosts === undefined ? [] : ['-o', `UserKnownHostsFile=${knownHosts}`]

const stateDir = `${env.TMPDIR ?? '/tmp'}/dsh-remote-ssh-e2e-${process.pid}`
const ctx = new Context()
const registry = new RemoteRegistry(ctx, {
  root: `${stateDir}/remotes`,
  stateFile: `${stateDir}/remotes.json`,
  controlDir: `${stateDir}/ssh-mux`,
  connectTimeoutMs: 20000,
})
const profile = registry.add({ label: 'test', host, port: Number(port), user, identityFile, extraOptions })
const policy = { mode: 'danger-full-access', workspaceRoot: registry.mountRoot(profile.id) }
ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', workspaceRoot: policy.workspaceRoot, resolve: () => policy, overrideOf: () => undefined })
const fs = new RemoteFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 })

const report = []
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const remoteDir = `${remoteRoot}/.dsh-e2e-${Date.now().toString(36)}`
await registry.test(profile.id)
await registry.makeDir(profile.id, remoteDir)
const localDir = registry.ensureMirror(profile.id, remoteDir)

// resolve + write + read
const fileTarget = await fs.resolve(`${localDir}/hello.txt`)
const write = await fs.writeText(fileTarget, 'bonjour\nmonde\n', { kind: 'createIfAbsent' }, undefined, policy)
check('writeText creates a file', write.operation === 'create', JSON.stringify(write.operation))
check('readText round-trips', (await fs.readText(fileTarget)) === 'bonjour\nmonde\n')

// stat + version guard
const info = await fs.stat(fileTarget)
check('stat reports a file', info?.type === 'file' && info.size === 14, JSON.stringify(info))
let stale = false
try {
  await fs.writeText(fileTarget, 'x', { kind: 'replaceIfVersion', version: 'bogus' }, undefined, policy)
} catch (error) {
  stale = error.code === 'FS_STALE_VERSION'
}
check('version guard rejects a stale write', stale)
let notObserved = false
try {
  await fs.writeText(fileTarget, 'x', { kind: 'createIfAbsent' }, undefined, policy)
} catch (error) {
  notObserved = error.code === 'FS_NOT_OBSERVED'
}
check('createIfAbsent refuses an existing file', notObserved)

// edit + sandbox fence
const edit = await fs.editText(fileTarget, { oldString: 'monde', newString: 'le monde', replaceAll: false }, undefined, undefined, policy)
check('editText applies a literal edit', edit.after === 'bonjour\nle monde\n')
let denied = false
try {
  await fs.editText(fileTarget, { oldString: 'bonjour', newString: 'salut', replaceAll: false }, undefined, undefined, { mode: 'read-only', workspaceRoot: localDir })
} catch (error) {
  denied = error.code === 'FS_SANDBOX_DENIED'
}
check('read-only fence denies a remote edit', denied)
let outsideDenied = false
try {
  await fs.editText(fileTarget, { oldString: 'bonjour', newString: 'salut', replaceAll: false }, undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/tmp' })
} catch (error) {
  outsideDenied = error.code === 'FS_SANDBOX_DENIED'
}
check('workspace-write fence denies a remote target outside its root', outsideDenied)
const allowed = await fs.editText(fileTarget, { oldString: 'bonjour', newString: 'salut', replaceAll: false }, undefined, undefined, { mode: 'workspace-write', workspaceRoot: localDir })
check('workspace-write fence admits a target inside its root', allowed.after === 'salut\nle monde\n')

// listing, subdirectory, byte ranges, absence
await registry.makeDir(profile.id, `${remoteDir}/sub`)
await fs.writeText(await fs.resolve(`${localDir}/sub/nested.txt`), 'nested', { kind: 'createIfAbsent' }, undefined, policy)
const entries = await fs.listDir(await fs.resolve(localDir))
check('listDir returns the children', entries.map((entry) => entry.name).join(',') === 'hello.txt,sub', entries.map((entry) => entry.name).join(','))
const bytes = await fs.readByteRange(fileTarget, { offset: 6, length: 2 })
check('readByteRange reads a window', Buffer.from(bytes).toString() === 'le', Buffer.from(bytes).toString())
check('stat on an absent path is undefined', (await fs.stat(await fs.resolve(`${localDir}/missing.txt`))) === undefined)
check('contains() is canonical', fs.contains(await fs.resolve(localDir), fileTarget))
check('fileUrl is a profile URI', fs.fileUrl(fileTarget).startsWith('ssh://test/'), fs.fileUrl(fileTarget))

// uri round-trip
const viaUri = await fs.resolve(`ssh://${profile.id}${remoteDir}/hello.txt`)
check('ssh:// URIs resolve back to the same target', viaUri.targetKey === fileTarget.targetKey)

// non-UTF-8 rejection
await fs.writeText(await fs.resolve(`${localDir}/binary.bin`), 'ok', undefined, undefined, policy)
await registry.transport(profile.id).run(`printf '\\000\\001\\002' > ${JSON.stringify(`${remoteDir}/binary.bin`).replace(/"/g, "'")}`)
let notText = false
try {
  await fs.readText(await fs.resolve(`${localDir}/binary.bin`))
} catch (error) {
  notText = error.code === 'FS_NOT_TEXT'
}
check('binary content is refused as FS_NOT_TEXT', notText)

// shell executor over the same world. It consumes `ctx.subprocess`, so the
// routed subprocess runtime is mounted first — the same order the composition
// uses when it replaces both seams.
const { RemoteSubprocessRuntime } = await import('../packages/dsh-remote-ssh/lib/subprocess.js')
const subprocess = new RemoteSubprocessRuntime(ctx, {})
const { RemoteShellExecutor } = await import('../packages/dsh-remote-ssh/lib/shell.js')
const shell = new RemoteShellExecutor(ctx, { timeoutMs: 60000, maxTimeoutMs: 600000, maxOutputBytes: 1024 * 1024, maxSpillBytes: 1024 * 1024, graceMs: 5000 })
const shellResult = await shell.run(shell.resolve({ command: 'pwd && echo "$(uname -s)" && cat hello.txt', workdir: localDir, timeoutMs: 30000 }))
check('the shell executor runs remotely in the remote directory', shellResult.exitCode === 0 && shellResult.stdout.text.includes(remoteDir) && shellResult.stdout.text.includes('salut'), shellResult.stdout.text.trim())

// subprocess routing (the glob/grep seam)
const handle = subprocess.spawn({ argv: ['/bin/echo', 'routed'], cwd: localDir, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000 })
const outcome = await handle.done
check('subprocess.spawn routes a remote directory', handle.collected.stdout.readFrom(0).text.trim() === 'routed', `${outcome.exitCode} ${handle.collected.stdout.readFrom(0).text.trim()}`)
const rgHandle = subprocess.spawn({ argv: ['/opt/none/definitely-absent-binary', '--files'], cwd: localDir, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000 })
await rgHandle.done
check('a missing remote program reports guidance', rgHandle.collected.stderr.readFrom(0).text.includes('not available on'), rgHandle.collected.stderr.readFrom(0).text.trim())


// Local passthrough: the same provider must keep every local path on the local
// backend, because replacing `ctx.fs` is what makes remote workspaces work and a
// regression here would break every ordinary session.
const localScratch = await fs.resolve(`${stateDir}/local-scratch.txt`)
const localWrite = await fs.writeText(localScratch, 'local content\n')
check('a local path is written locally', localWrite.operation === 'create' && readFileSync(`${stateDir}/local-scratch.txt`, 'utf8') === 'local content\n')
check('a local path is read locally', (await fs.readText(localScratch)) === 'local content\n')
check('a local stat is served by the local backend', (await fs.stat(localScratch))?.size === 14)
const localEntries = await fs.listDir(await fs.resolve(stateDir))
check('a local directory lists without a remote round-trip', localEntries.some((entry) => entry.name === 'local-scratch.txt'))
check('a relative local path resolves against the session cwd', String((await fs.resolve('package.json', { cwd: new URL('..', import.meta.url).pathname })).displayPath).endsWith('package.json'))

console.log(report.join('\n'))
console.log(process.exitCode === 1 ? '\nRESULT: FAILURES' : '\nRESULT: ALL PASS')
process.exit(process.exitCode ?? 0)
