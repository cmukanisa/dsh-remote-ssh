/**
 * Installer suite: what a user's machine looks like after each invocation.
 *
 * The installer makes three durable changes to a harness home, and every one of
 * them is a promise: the packages are where the loader can resolve them, the
 * composition rows are present exactly once, and the plugin arrives SWITCHED OFF
 * so the harness asks to be activated rather than silently gaining SSH access.
 *
 * Usage: node test/install.test.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const home = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-install-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  preference: system\n')
// The installer refuses to write before it has confirmed the harness module tree
// is reachable from the destination; the suites' own linked packages stand in for
// the harness's, which is the same directory the loader would resolve.
mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(home, 'profiles', 'node_modules', '@deepseek-ai'), 'dir')

// The installer knocks on the harness port to say whether a restart is due.
// The suite must not depend on whatever listens on this machine's 3080, so every
// run is pointed at a port the suite owns: a stand-in that answers exactly like
// an unauthenticated `dsh web`, a port that is closed, or a stranger.
// The stand-ins run in their own process: `execFileSync` below blocks this one's
// event loop, so a server hosted here could never answer the installer's probe.
// Each stand-in isolates one half of the fingerprint or one failure shape:
// `auth401` is a 401 that never says "dsh web", `page200` says it with the wrong
// status, `silent` accepts the socket and never answers, `trickle` answers 401
// then streams a body forever without the fingerprint.
const standIns = spawn(process.execPath, ['--input-type=module', '-e', `
  import { createServer } from 'node:http'
  import { createServer as createTcpServer } from 'node:net'
  const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s.address().port)) })
  const harness = await listen((_req, res) => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('dsh web authentication required; reopen the URL printed by dsh web.\\n') })
  const stranger = await listen((_req, res) => { res.writeHead(200); res.end('hello') })
  const auth401 = await listen((_req, res) => { res.writeHead(401); res.end('Unauthorized') })
  const page200 = await listen((_req, res) => { res.writeHead(200); res.end('dsh web authentication required') })
  const trickle = await listen((_req, res) => { res.writeHead(401); setInterval(() => res.write('.'), 200) })
  const silent = await new Promise((resolve) => { const s = createTcpServer(() => {}); s.listen(0, '127.0.0.1', () => resolve(s.address().port)) })
  process.stdout.write(JSON.stringify({ harness, stranger, auth401, page200, trickle, silent }) + '\\n')
  setInterval(() => {}, 1 << 30)
`], { stdio: ['ignore', 'pipe', 'inherit'] })
process.on('exit', () => standIns.kill())
const ports = JSON.parse(await new Promise((resolve) => standIns.stdout.once('data', (chunk) => resolve(String(chunk)))))
const { harness: harnessPort, stranger: strangerPort } = ports
const closed = createTcpServer()
await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
const closedPort = closed.address().port
await new Promise((resolve) => closed.close(resolve))

/** Run the installer in-process-equivalent form and return its stdout. */
const install = (...args) => execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', home, '--harness-port', String(harnessPort), ...args], { encoding: 'utf8' })

const first = install()
check('the plugin is activated by default', /^remote-ssh:\n  enabled: true$/m.test(readFileSync(join(home, 'settings.yaml'), 'utf8')), readFileSync(join(home, 'settings.yaml'), 'utf8').split('\n').slice(-2).join(' | '))
check('the run reports every phase', ['checking', 'installing', 'verifying'].every((name) => first.includes(name)), first.split('\n').filter((entry) => /checking|installing|verifying/.test(entry)).join(' | '))
check('the packages are installed', existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh', 'lib', 'registry.js')) && existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh-ui', 'lib', 'client.js')))
check('the installer reports the activation step', first.includes('Serveur distant (SSH)') && /Done in/.test(first), first.split('\n').filter((line) => /Done in|switched off/.test(line)).join(' | '))

const patch = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
check('the empty root was replaced by a list', !patch.includes('\n[]\n'), patch.split('\n').slice(0, 4).join(' | '))
for (const id of ['remote-ssh', 'fs-remote-ssh', 'shell-remote-ssh', 'subprocess-remote-ssh', 'remote-ssh-ui']) {
  check(`the composition declares ${id}`, new RegExp(`id: ${id}\\n`).test(patch), '')
}
const pluginsDir = join(home, 'profiles', 'plugins')
check('the rows point at the installed packages', patch.includes(`${pluginsDir}/dsh-remote-ssh/lib/registry.js`), '')
check('the shipped providers are disabled', /- id: fs-sandbox\n  disabled: true/.test(patch) && /- id: bash-sandbox\n  disabled: true/.test(patch) && /- id: subprocess\n  disabled: true/.test(patch))

const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
check('the existing settings survive', settings.includes('ui-theme:'))
check('the setting is reported as written', /^remote-ssh:\n  enabled: true$/m.test(settings), settings.trim().split('\n').slice(-2).join(' | '))

install()
const secondPatch = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
check('re-running does not duplicate the block', secondPatch.split('# >>> dsh-remote-ssh').length === 2, String(secondPatch.split('# >>> dsh-remote-ssh').length - 1))
check('re-running does not duplicate the setting', (readFileSync(join(home, 'settings.yaml'), 'utf8').match(/^remote-ssh:$/gm) ?? []).length === 1)

install('--enable')
check('--enable flips the switch', /^remote-ssh:\n  enabled: true$/m.test(readFileSync(join(home, 'settings.yaml'), 'utf8')))

// A re-install must report the operator's stored answer, not a default. A plain
// re-run after --enable used to say "waiting for activation", which is how a
// working installation looked broken.
const afterEnable = install()
check('a re-install reports the plugin as enabled', /remote-ssh\.enabled = true/.test(afterEnable) && !/switched off/.test(afterEnable), afterEnable.split('\n').filter((line) => /enabled =|switched off/.test(line)).join(' | '))
const afterDisable = install('--dry-run')
check('a dry run leaves the enabled state alone', /enabled = true/.test(afterDisable), afterDisable.split('\n').filter((line) => /enabled =/.test(line)).join(' | '))

// ── an upgrade a running harness cannot see must say "restart", not "reload" ─
// The client-module table of a running `dsh web` is keyed on the package name
// read at boot; after the #6 rename the new bundle registered a different id
// and every page load failed with "loaded without registering". The installer
// used to close with "Reload the harness page", which is exactly the wrong advice.
const uiManifest = join(home, 'profiles', 'plugins', 'dsh-remote-ssh-ui', 'package.json')
const same = install()
check('an identical re-install still says reload', /Reload the harness page/.test(same) && !/Restart the harness/.test(same), same.split('\n').filter((entry) => /Reload|Restart/.test(entry)).join(' | '))
writeFileSync(uiManifest, JSON.stringify({ ...JSON.parse(readFileSync(uiManifest, 'utf8')), name: '@deepseek-ai/dsh-remote-ssh-ui' }, null, 2))
const renamed = install()
check('a renamed package is reported', /renamed.*@deepseek-ai\/dsh-remote-ssh-ui.*dsh-remote-ssh-ui/.test(renamed), renamed.split('\n').filter((entry) => /renamed/.test(entry)).join(' | '))
check('a renamed package asks for a restart', /Restart the harness/.test(renamed) && !/Reload the harness page/.test(renamed), renamed.split('\n').filter((entry) => /Reload|Restart/.test(entry)).join(' | '))
check('the running harness is named with its port', new RegExp(`running on 127\\.0\\.0\\.1:${harnessPort}`).test(renamed) && new RegExp(`Restart the harness running on 127\\.0\\.0\\.1:${harnessPort}`).test(renamed), renamed.split('\n').filter((entry) => /dsh web|Restart/.test(entry)).join(' | '))
writeFileSync(uiManifest, JSON.stringify({ ...JSON.parse(readFileSync(uiManifest, 'utf8')), name: '@deepseek-ai/dsh-remote-ssh-ui' }, null, 2))
const noHarness = execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', home, '--harness-port', String(closedPort)], { encoding: 'utf8' })
check('with no harness answering, the restart line says so', /none on 127\.0\.0\.1/.test(noHarness) && /if one was already running/.test(noHarness) && /none answered/.test(noHarness), noHarness.split('\n').filter((entry) => /dsh web|Restart/.test(entry)).join(' | '))
writeFileSync(uiManifest, JSON.stringify({ ...JSON.parse(readFileSync(uiManifest, 'utf8')), name: '@deepseek-ai/dsh-remote-ssh-ui' }, null, 2))
const strangerOut = execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', home, '--harness-port', String(strangerPort)], { encoding: 'utf8' })
check('a stranger on the port is not mistaken for the harness', /something else answers/.test(strangerOut) && /if one was already running/.test(strangerOut) && /is not dsh web/.test(strangerOut), strangerOut.split('\n').filter((entry) => /dsh web|Restart/.test(entry)).join(' | '))
// The two halves of the fingerprint, each alone, must not pass for the harness;
// a silent or endless responder must be "other" and must not stall the run.
for (const [name, port, label] of [['a 401 without the banner', ports.auth401, 'auth401'], ['a 200 that names dsh web', ports.page200, 'page200'], ['a silent listener', ports.silent, 'silent'], ['an endless 401 body', ports.trickle, 'trickle']]) {
  const startedAt = Date.now()
  const out = execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', home, '--dry-run', '--harness-port', String(port)], { encoding: 'utf8' })
  const elapsed = Date.now() - startedAt
  check(`${name} is reported as something else (${label})`, /something else answers/.test(out) && !/running on/.test(out), out.split('\n').filter((entry) => /dsh web/.test(entry)).join(' | '))
  check(`${name} does not stall the installer (${label})`, elapsed < 3000, `${elapsed}ms`)
}
const hostFile = join(home, 'profiles', 'plugins', 'dsh-remote-ssh', 'lib', 'registry.js')
writeFileSync(hostFile, `${readFileSync(hostFile, 'utf8')}\n// stale\n`)
const hostChanged = install()
check('a changed host half asks for a restart', /host half/.test(hostChanged) && /Restart the harness/.test(hostChanged), hostChanged.split('\n').filter((entry) => /host half|Restart/.test(entry)).join(' | '))
const hostManifest = join(home, 'profiles', 'plugins', 'dsh-remote-ssh', 'package.json')
writeFileSync(hostManifest, JSON.stringify({ ...JSON.parse(readFileSync(hostManifest, 'utf8')), version: '0.0.0-stale' }, null, 2))
const versionOnly = install()
check('a version bump alone still says reload', /Reload the harness page/.test(versionOnly) && !/Restart the harness/.test(versionOnly), versionOnly.split('\n').filter((entry) => /Reload|Restart/.test(entry)).join(' | '))
const uiManifestPath = join(home, 'profiles', 'plugins', 'dsh-remote-ssh-ui', 'package.json')
writeFileSync(uiManifestPath, JSON.stringify({ ...JSON.parse(readFileSync(uiManifestPath, 'utf8')), dsh: { client: { platform: 'web', inject: [] } } }, null, 2))
const injectChanged = install()
check('a manifest change beyond the version asks for a restart', /host half/.test(injectChanged) && /Restart the harness/.test(injectChanged), injectChanged.split('\n').filter((entry) => /host half|Restart/.test(entry)).join(' | '))
writeFileSync(uiManifestPath, '{ not json')
const corrupt = install()
check('a corrupt installed manifest asks for a restart rather than failing', /host half/.test(corrupt) && /Restart the harness/.test(corrupt), corrupt.split('\n').filter((entry) => /host half|Restart/.test(entry)).join(' | '))
writeFileSync(hostFile, `${readFileSync(hostFile, 'utf8')}\n// stale again\n`)
const preview = install('--dry-run')
check('a dry run previews the restart verdict', /host half/.test(preview) && /restarted/.test(preview) && /Dry run/.test(preview), preview.split('\n').filter((entry) => /host half|Dry run/.test(entry)).join(' | '))
const previewApplied = install()
check('a dry run wrote nothing, so the real run still sees the change', /host half/.test(previewApplied), '')
const bundle = join(home, 'profiles', 'plugins', 'dsh-remote-ssh-ui', 'lib', 'client.js')
writeFileSync(bundle, `${readFileSync(bundle, 'utf8')}\n// stale\n`)
const bundleOnly = install()
check('a changed bundle alone still says reload', /Reload the harness page/.test(bundleOnly) && !/Restart the harness/.test(bundleOnly), bundleOnly.split('\n').filter((entry) => /Reload|Restart/.test(entry)).join(' | '))

const dry = install('--uninstall', '--dry-run')
check('--dry-run changes nothing', dry.includes('would') && existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh')))

install('--uninstall')
check('uninstall removes the packages', !existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh')))
check('uninstall strips the composition rows', !readFileSync(join(home, 'cordis.patch.yml'), 'utf8').includes('remote-ssh'))
check('uninstall keeps the settings document', existsSync(join(home, 'settings.yaml')))

// ── a failed install must leave nothing behind ───────────────────────────────
// `cordis.patch.yml` is made a DIRECTORY, which fails the write on every platform
// (a read-only file would not on Windows). The failure happens after the packages
// are copied, so it exercises the rollback rather than the pre-flight checks.
const failing = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-rollback-'))
mkdirSync(join(failing, 'profiles', 'web'), { recursive: true })
mkdirSync(join(failing, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(failing, 'profiles', 'node_modules', '@deepseek-ai'), 'dir')
mkdirSync(join(failing, 'cordis.patch.yml'))
let rollbackOutput = ''
try {
  execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', failing, '--harness-port', String(closedPort)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  rollbackOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
}
check('a failed install exits non-zero', rollbackOutput !== '', rollbackOutput.slice(0, 120))
check('a failed install says it rolled back', /rolling back/.test(rollbackOutput) && /Installation cancelled/.test(rollbackOutput), rollbackOutput.split('\n').filter((entry) => /cancelled|rolling/.test(entry)).join(' | '))
check('a failed install removes the copied packages', !existsSync(join(failing, 'profiles', 'plugins', 'dsh-remote-ssh')), 'the package directory survived')
check('a failed install removes the plugins directory it created', !existsSync(join(failing, 'profiles', 'plugins')))
check('a failed install leaves the composition untouched', existsSync(join(failing, 'cordis.patch.yml')))
check('a failed install writes no setting', !existsSync(join(failing, 'settings.yaml')))
rmSync(failing, { recursive: true, force: true })

// ── --keep-off installs dormant without a first-run section ──────────────────
const dormant = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-dormant-'))
mkdirSync(join(dormant, 'profiles', 'web'), { recursive: true })
mkdirSync(join(dormant, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(dormant, 'profiles', 'node_modules', '@deepseek-ai'), 'dir')
const dormantOut = execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', dormant, '--keep-off', '--harness-port', String(closedPort)], { encoding: 'utf8' })
check('--keep-off installs dormant', /^remote-ssh:\n  enabled: false$/m.test(readFileSync(join(dormant, 'settings.yaml'), 'utf8')), '')
check('--keep-off says so plainly', /Installed, switched off/.test(dormantOut), dormantOut.split('\n').filter((entry) => /switched off/.test(entry)).join(' | '))
execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', dormant, '--enable', '--harness-port', String(closedPort)], { encoding: 'utf8' })
check('--enable brings a dormant install back', /^remote-ssh:\n  enabled: true$/m.test(readFileSync(join(dormant, 'settings.yaml'), 'utf8')), '')
rmSync(dormant, { recursive: true, force: true })

// ── a --link install is the checkout itself: what the harness booted with is unknowable ──
// The developer path the rename bug bit: --link, dsh web started, git pull, --link
// again. A file diff of a symlink against its own target is always equal.
const linked = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-linked-'))
mkdirSync(join(linked, 'profiles', 'web'), { recursive: true })
mkdirSync(join(linked, 'profiles', 'node_modules'), { recursive: true })
symlinkSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(linked, 'profiles', 'node_modules', '@deepseek-ai'), 'dir')
const linkArgs = [join(ROOT, 'install.mjs'), '--dsh-home', linked, '--link', '--harness-port', String(closedPort)]
const linkFirst = execFileSync(process.execPath, linkArgs, { encoding: 'utf8' })
check('a first --link install says reload', /Reload the harness page/.test(linkFirst), linkFirst.split('\n').filter((entry) => /Reload|Restart/.test(entry)).join(' | '))
const linkAgain = execFileSync(process.execPath, linkArgs, { encoding: 'utf8' })
check('a repeated --link install asks for a restart', /host half/.test(linkAgain) && /Restart the harness/.test(linkAgain), linkAgain.split('\n').filter((entry) => /host half|Restart/.test(entry)).join(' | '))
rmSync(linked, { recursive: true, force: true })

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
