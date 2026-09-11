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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Run the installer in-process-equivalent form and return its stdout. */
const install = (...args) => execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dsh-home', home, ...args], { encoding: 'utf8' })

const first = install()
check('the packages are installed', existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh', 'lib', 'registry.js')) && existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh-ui', 'lib', 'client.js')))
check('the installer reports the activation step', first.includes('Workspaces distants (SSH)') && first.includes('install.mjs --enable'), first.split('\n').filter((line) => /Activation|Enabled/.test(line)).join(' | '))

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
check('the plugin arrives switched off', /^remote-ssh:\n  enabled: false$/m.test(settings), settings.trim().split('\n').slice(-2).join(' | '))

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
check('a re-install reports the plugin as enabled', /Enabled\./.test(afterEnable) && !/Activation required/.test(afterEnable), afterEnable.split('\n').filter((line) => /Enabled|Activation/.test(line)).join(' | '))
const afterDisable = install('--dry-run')
check('a dry run leaves the enabled state alone', /enabled = true/.test(afterDisable), afterDisable.split('\n').filter((line) => /enabled =/.test(line)).join(' | '))

const dry = install('--uninstall', '--dry-run')
check('--dry-run changes nothing', dry.includes('would') && existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh')))

install('--uninstall')
check('uninstall removes the packages', !existsSync(join(home, 'profiles', 'plugins', 'dsh-remote-ssh')))
check('uninstall strips the composition rows', !readFileSync(join(home, 'cordis.patch.yml'), 'utf8').includes('remote-ssh'))
check('uninstall keeps the settings document', existsSync(join(home, 'settings.yaml')))

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
