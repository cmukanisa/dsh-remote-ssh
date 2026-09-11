/**
 * Unit suite: everything that must hold with NO SSH server, NO network, and NO
 * harness boot. This is the suite CI runs on every platform and every supported
 * Node version, because it is the only one that can run everywhere.
 *
 * Usage: node test/unit.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { shellQuote, quoteArgv, sharedControlDirectory } from '../packages/dsh-remote-ssh/lib/ssh.js'
import { RemoteRegistry, RemoteProfileError } from '../packages/dsh-remote-ssh/lib/registry.js'
import { RemoteFileSystem, applyLiteralEdit, atomicWriteScript, isUnder } from '../packages/dsh-remote-ssh/lib/fs.js'
import { RemoteSshController, markRemote } from '../packages/dsh-remote-ssh-ui/lib/remote.js'

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const equals = (name, actual, expected) => check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-unit-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

// ── shell quoting: the one place where a bug becomes remote code execution ────
equals('shellQuote leaves a plain word quoted', shellQuote('hello'), `'hello'`)
equals('shellQuote escapes an embedded single quote', shellQuote("it's"), `'it'\\''s'`)
equals('shellQuote survives a command substitution attempt', shellQuote('$(rm -rf /)'), `'$(rm -rf /)'`)
equals('shellQuote survives a newline', shellQuote('a\nb'), `'a\nb'`)
equals('shellQuote of an empty string is an empty word', shellQuote(''), `''`)
equals('quoteArgv joins words', quoteArgv(['a', 'b c']), `'a' 'b c'`)

// ── control socket path: OpenSSH fatal()s rather than truncating ──────────────
const shortDir = join(tmpdir(), 'dsh-ssh-unit')
equals('a short socket directory is kept', sharedControlDirectory(shortDir), shortDir)
const longDir = join(scratch, 'x'.repeat(120))
const shortened = sharedControlDirectory(longDir)
check('a long socket directory is replaced', shortened !== longDir, shortened)
check('the resulting ControlPath fits the AF_UNIX limit', Buffer.byteLength(join(shortened, 'a'.repeat(40)), 'utf8') <= 104, `${Buffer.byteLength(join(shortened, 'a'.repeat(40)), 'utf8')} bytes`)
equals('the shortening is deterministic', sharedControlDirectory(longDir), shortened)

// ── registry: profiles, mirrors, path mapping ─────────────────────────────────
const ctx = new Context()
const stateRoot = join(scratch, 'state')
const registry = new RemoteRegistry(ctx, { root: join(scratch, 'remotes'), stateFile: join(stateRoot, 'remotes.json'), controlDir: join(stateRoot, 'ssh-mux'), connectTimeoutMs: 1000 })
equals('no profile exists initially', registry.list(), [])

const profile = registry.add({ label: 'Prod Server', host: 'prod.example.com', port: 2222, user: 'deploy', identityFile: '/tmp/k' })
equals('the profile id is slugified from the label', profile.id, 'prod-server')
equals('the profile remembers its port', profile.port, 2222)
check('the durable document was written', existsSync(join(stateRoot, 'remotes.json')))
check('the mirror root exists on disk', existsSync(profile.mountRoot))
equals('a second profile with the same identity is refused', (() => { try { registry.add({ host: 'prod.example.com', port: 2222, user: 'deploy' }); return 'accepted' } catch (error) { return error instanceof RemoteProfileError ? error.code : String(error) } })(), 'duplicate-profile')
equals('an invalid port is refused', (() => { try { registry.add({ host: 'x', port: 70000 }); return 'accepted' } catch (error) { return error.code } })(), 'invalid-profile')
equals('multiple hosts are supported', registry.add({ label: 'Staging', host: 'stage.example.com' }).id, 'staging')
equals('distinct hosts keep distinct mirrors', registry.list().length, 2)

equals('a remote path maps back to its remote spelling', registry.worldOf(join(profile.mountRoot, 'srv', 'app')).remotePath, '/srv/app')
equals('the mirror root itself maps to /', registry.worldOf(profile.mountRoot).remotePath, '/')
equals('an outside path belongs to no world', registry.worldOf(join(scratch, 'elsewhere')), undefined)
equals('a local path renders as a mirror path', registry.localPathOf('prod-server', '/srv/app'), join(profile.mountRoot, 'srv', 'app'))
equals('a mirror is created on demand', registry.ensureMirror('prod-server', '/srv/app'), join(profile.mountRoot, 'srv', 'app'))
check('the created mirror exists', existsSync(join(profile.mountRoot, 'srv', 'app')))
equals('removal reports the profile was known', registry.remove('staging'), true)
equals('removal of an unknown profile is false', registry.remove('staging'), false)
equals('the switch defaults to on', registry.enabled, true)

// Separate context: an environment with no settings provider must still work.
const bareCtx = new Context()
const bareRegistry = new RemoteRegistry(bareCtx, { root: join(scratch, 'r2'), stateFile: join(scratch, 'r2.json'), controlDir: join(scratch, 'mux2'), connectTimeoutMs: 1000 })
equals('a registry without a settings provider stays enabled', bareRegistry.enabled, true)
equals('and the switch write is a no-op', await bareRegistry.setEnabled(false), { enabled: true, profiles: [] })

// ── filesystem helpers ───────────────────────────────────────────────────────
const editCase = (content, oldString, newString, replaceAll) => {
  try {
    return applyLiteralEdit(content, oldString, newString, replaceAll, '/f').content
  } catch (error) {
    return error.code
  }
}
equals('a literal edit replaces one match', editCase('a b c', 'b', 'X', false), 'a X c')
equals('a repeated match without replaceAll is ambiguous', editCase('b b', 'b', 'X', false), 'FS_AMBIGUOUS_EDIT')
equals('replaceAll replaces every match', editCase('b b', 'b', 'X', true), 'X X')
equals('a missing match reports FS_EDIT_NOT_FOUND', editCase('a', 'z', 'X', false), 'FS_EDIT_NOT_FOUND')
equals('an empty search string is refused', editCase('a', '', 'X', false), 'FS_EDIT_NOT_FOUND')
equals('CRLF in the pattern still matches LF content', editCase('a\nb', 'a\r\nb', 'X', false), 'X')

// The chmod argument must be OCTAL TEXT: `chmod 420` is octal 0420, which once
// made every remotely written file write-only.
const script = atomicWriteScript('/srv/app/file.txt', 0o644)
check('the write script chmods with an octal string', script.includes('chmod 644 "$tmp"'), script.split('\n')[6])
check('the temp file is a sibling of the target', script.includes("'/srv/app/.dsh-tmp-"), script.split('\n')[0])
check('the write script publishes atomically', script.includes('mv -f "$tmp" "$target"'), '')
check('a read-only mode is preserved', atomicWriteScript('/srv/app/file.txt', 0o400).includes('chmod 400 "$tmp"'), '')
check('a path with a quote survives quoting', atomicWriteScript("/srv/it's/f.txt", 0o644).includes(`'\\''`), '')

equals('containment accepts the root itself', isUnder('/srv/app', '/srv/app'), true)
equals('containment accepts a descendant', isUnder('/srv/app', '/srv/app/sub'), true)
equals('containment rejects a sibling prefix', isUnder('/srv/app', '/srv/app-evil'), false)
equals('containment rejects a parent', isUnder('/srv/app', '/srv'), false)

ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', workspaceRoot: join(scratch, 'remotes'), resolve: () => ({ mode: 'danger-full-access', workspaceRoot: join(scratch, 'remotes') }), overrideOf: () => undefined })
const fs = new RemoteFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 1024 * 1024 })
const remoteTarget = { targetKey: join(profile.mountRoot, 'srv', 'app', 'index.js'), displayPath: join(profile.mountRoot, 'srv', 'app', 'index.js') }
equals('a remote target yields a profile URI', fs.fileUrl(remoteTarget), 'ssh://prod-server/srv/app/index.js')
equals('a URI percent-encodes per segment', fs.fileUrl({ targetKey: join(profile.mountRoot, 'a b', 'c#d'), displayPath: '' }), 'ssh://prod-server/a%20b/c%23d')
equals('a remote target is not a local path', fs.worldOfTarget(remoteTarget).profile.id, 'prod-server')
check('contains() is canonical for remote targets', fs.contains({ targetKey: profile.mountRoot, displayPath: '' }, remoteTarget))

// ── the Remote namespace descriptor ──────────────────────────────────────────
const controller = new RemoteSshController(ctx)
const methods = remoteMethods(controller).map((marker) => marker.exportName ?? marker.method)
equals('every Remote method is published', methods.sort(), ['adopt', 'connect', 'disconnect', 'list', 'makeDirectory', 'setEnabled', 'status', 'test'])
equals('the namespace is the one the browser calls', controller.typertRemote.namespace, 'sshWorkspace')
equals('the service key matches the binding', controller.typertRemote.serviceKey, 'remoteSshController')
check('a hand-built prototype is also accepted', (() => {
  class Sample {}
  markRemote(Sample.prototype, ['ping'])
  return remoteMethods(new Sample())[0].method === 'ping'
})())

// ── the composition rows the installer writes ────────────────────────────────
const template = readFileSync(new URL('../patch/remote-ssh.patch.yml.tpl', import.meta.url), 'utf8')
for (const id of ['remote-ssh', 'fs-remote-ssh', 'shell-remote-ssh', 'subprocess-remote-ssh', 'remote-ssh-ui']) {
  check(`the template declares row ${id}`, template.includes(`id: ${id}`), '')
}
for (const replaced of ['fs-sandbox', 'bash-sandbox', 'subprocess']) {
  check(`the template replaces ${replaced}`, new RegExp(`- id: ${replaced}\\n  disabled: true`).test(template), '')
}

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
