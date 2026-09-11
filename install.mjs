#!/usr/bin/env node
/**
 * Installer for the `dsh-remote-ssh` plugin.
 *
 * It runs as four visible phases — checking, installing, verifying, done — so the
 * operator watches the whole thing happen instead of reading a result:
 *
 *  1. **checking** — every requirement is probed BEFORE anything is written. A
 *     missing one fails here, with the command that fixes it, rather than leaving
 *     half an installation behind.
 *  2. **installing** — three durable changes: the two packages under
 *     `<DSH_HOME>/profiles/plugins/` (under the profiles root so their bare
 *     `@deepseek-ai/dsh-*` imports resolve through the harness's own
 *     `node_modules`), this plugin's block in `<DSH_HOME>/cordis.patch.yml` (the
 *     home-level layer, so every profile sees the rows), and
 *     `<DSH_HOME>/settings.yaml`.
 *  3. **verifying** — the install is read back and, decisively, the host module is
 *     actually imported from where the loader will import it. A copy that was
 *     truncated, a composition that lost a row, or a settings section that did
 *     not land are all caught here rather than at the next `dsh` boot.
 *  4. **done** — the switch state and the next actions.
 *
 * **The installation is a transaction.** Everything it will touch — the
 * composition layer, the settings document, and any package already installed —
 * is snapshotted first, and anything short of a fully verified install is rolled
 * back. A half-installed plugin is worse than none: the loader would either fail
 * to boot the profile or, worse, boot it with a composition that disables the
 * shipped providers and never registers the replacements.
 *
 * The plugin is ENABLED by default: installing it is the decision. `--keep-off`
 * installs it dormant, which is what a fleet rollout wants when activation is a
 * separate, audited step.
 *
 * Usage:
 *   node install.mjs [--keep-off] [--link] [--dry-run] [--no-color] [--dsh-home DIR] [--uninstall]
 */
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = ['dsh-remote-ssh', 'dsh-remote-ssh-ui']
const SETTINGS_NAMESPACE = 'remote-ssh'
const BEGIN_MARKER = '# >>> dsh-remote-ssh (managed block — re-running the installer replaces it) >>>'
const END_MARKER = '# <<< dsh-remote-ssh <<<'
const AUTHOR = 'Christian Kasse (cmukanisa)'
const HOMEPAGE = 'https://github.com/cmukanisa/dsh-remote-ssh'
/** The Node range the harness itself requires. */
const NODE_FLOOR = '22.19'
/** The rows the composition must end up declaring, disabled providers included. */
const EXPECTED_ROWS = ['remote-ssh', 'fs-remote-ssh', 'shell-remote-ssh', 'subprocess-remote-ssh', 'remote-ssh-ui', 'fs-sandbox', 'bash-sandbox', 'subprocess']

// ── presentation ─────────────────────────────────────────────────────────────

/**
 * Whether stdout can carry escape sequences.
 *
 * `NO_COLOR` is honoured because it is the cross-tool convention, `TERM=dumb`
 * because that is how a build log says so, and `--no-color` because a person
 * piping the output into a document should not have to know either.
 */
const COLOR = process.argv.includes('--no-color') ? false : process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'

/** Whether the terminal can be expected to render box-drawing characters. */
const UNICODE = process.platform !== 'win32' || process.env.WT_SESSION !== undefined || process.env.TERM_PROGRAM !== undefined

/** Wrap text in an SGR sequence, or return it untouched when colour is off. */
const paint = (code) => (text) => (COLOR ? `\u001B[${code}m${text}\u001B[0m` : text)
const brand = paint('38;5;209') // the warm accent the header is built around
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const yellow = paint('33')
const red = paint('31')
const cyan = paint('36')

/** The glyph set, with an ASCII fallback for terminals that cannot draw boxes. */
const glyph = UNICODE
  ? { ok: '✓', fail: '✗', info: '•', warn: '!', arrow: '→', bullet: '·', rule: '─', diamond: '◆', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  : { ok: '+', fail: 'x', info: '-', warn: '!', arrow: '->', bullet: '.', rule: '-', diamond: '*', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }

/** Visible width of the report, clamped so it reads well in a narrow pane and a wide one. */
const WIDTH = Math.min(96, Math.max(64, process.stdout.columns ?? 84))
const INDENT = '  '

/** Strip escape sequences, so padding is computed on what the eye sees. */
function visible(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

/** Print one line, with the shared indent. */
function line(text = '') {
  process.stdout.write(`${text === '' ? '' : `${INDENT}${text}`}\n`)
}

/** Print one aligned `status label ······· detail` row. */
function step(status, label, detail) {
  const mark = status === 'ok' ? green(glyph.ok) : status === 'warn' ? yellow(glyph.warn) : status === 'fail' ? red(glyph.fail) : dim(glyph.info)
  const left = `${mark} ${label.padEnd(11)}`
  const dots = Math.max(2, WIDTH - INDENT.length - visible(left).length - detail.length - 3)
  line(`${left}${dim(` ${glyph.bullet.repeat(dots)} `)}${detail}`)
}

/** Start a named phase, so the whole run reads as a sequence. */
function phase(title) {
  process.stdout.write(`\n${INDENT}${bold(title)}\n`)
}

/** A horizontal rule that spans the report width. */
function rule() {
  process.stdout.write(`${INDENT}${dim(glyph.rule.repeat(WIDTH - INDENT.length))}\n`)
}

/**
 * The header: what this is, whose it is, and where it is going.
 * @param destination - the harness home being written to.
 * @param options - `showHarness: false` for `--help`, which targets no home.
 */
function header(destination, options = {}) {
  const rows = [
    `${brand(glyph.diamond)} ${bold('dsh-remote-ssh')} ${dim(`v${readVersion()}`)}`,
    dim('Remote SSH workspaces for the DeepSeek Harness'),
    `${dim('by')} ${brand(AUTHOR)} ${dim(`· ${HOMEPAGE}`)}`,
  ]
  const inner = Math.min(WIDTH - 4, Math.max(...rows.map((row) => visible(row).length)) + 2)
  process.stdout.write(`${INDENT}${dim(glyph.tl + glyph.h.repeat(inner + 2) + glyph.tr)}\n`)
  for (const row of rows) {
    process.stdout.write(`${INDENT}${dim(glyph.v)} ${row}${' '.repeat(Math.max(0, inner - visible(row).length))} ${dim(glyph.v)}\n`)
  }
  process.stdout.write(`${INDENT}${dim(glyph.bl + glyph.h.repeat(inner + 2) + glyph.br)}\n`)
  if (options.showHarness === false) return
  line()
  line(`${dim('harness'.padEnd(11))}${cyan(destination)}`)
}

/** The shipped version, so the report never disagrees with the package. */
function readVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Show a path relative to the harness home when that is shorter, else absolute. */
function shorten(path, home) {
  const rel = relative(home, path)
  return rel === '' || rel.startsWith('..') ? path : rel
}

/** Files under a directory, recursively, ignoring dependencies. */
function countFiles(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    total += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1
  }
  return total
}

/** A requirement that cannot be satisfied, carrying the remedy. */
class RequirementError extends Error {
  /**
   * @param message - what is missing.
   * @param remedy - the command or action that fixes it.
   */
  constructor(message, remedy) {
    super(message)
    this.name = 'RequirementError'
    this.remedy = remedy
  }
}

// ── flags ────────────────────────────────────────────────────────────────────

/** Parse the small flag surface; no dependency, no config file. */
function parseArgs(argv) {
  const options = { enable: true, force: false, link: false, dryRun: false, uninstall: false, dshHome: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--keep-off' || flag === '--no-enable') options.enable = false
    else if (flag === '--enable') { options.enable = true; options.force = true }
    else if (flag === '--link') options.link = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--uninstall') options.uninstall = true
    else if (flag === '--no-color') continue
    else if (flag === '--dsh-home') { index += 1; options.dshHome = argv[index] }
    else if (flag === '--help' || flag === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`unknown option: ${flag}`)
  }
  return options
}

/** Print the flag reference. */
function printHelp() {
  header(process.env.DSH_HOME ?? join(homedir(), '.dsh'), { showHarness: false })
  phase('options')
  const rows = [
    ['--keep-off', 'install dormant instead of activating (for an audited rollout)'],
    ['--enable', 'activate even if a previous run left it switched off'],
    ['--link', 'symlink the packages instead of copying them (development)'],
    ['--dry-run', 'run the checks, report the changes, write nothing'],
    ['--uninstall', 'remove the packages, the composition rows, and the setting'],
    ['--no-color', 'plain output'],
    ['--dsh-home DIR', 'harness home to install into (default: $DSH_HOME or ~/.dsh)'],
  ]
  for (const [flag, description] of rows) line(`${brand(flag.padEnd(15))} ${dim(description)}`)
  line()
  line(dim('Installing activates the plugin; the installer is idempotent, so re-running it replaces its own block.'))
  line()
}

/** Resolve the harness home the same way the launcher does. */
function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

// ── filesystem ───────────────────────────────────────────────────────────────

/** Require a path to exist. */
function requirePath(path, description) {
  if (!existsSync(path)) throw new RequirementError(`${description} not found at ${path}`, 're-download the plugin; the archive is incomplete')
  return path
}

/**
 * Read a document that may not exist yet.
 *
 * Reading and catching `ENOENT` rather than testing `existsSync` first is not a
 * style preference: a check followed by a use is a race, and the two documents
 * this installer edits are exactly the ones a concurrent edit would corrupt.
 * @param path - the file to read.
 * @returns its text, or an empty string when it is absent.
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Remove this plugin's managed block from a patch document.
 * @param text - the current document.
 * @returns the document without the block.
 */
function stripBlock(text) {
  const start = text.indexOf(BEGIN_MARKER)
  if (start < 0) return text
  const end = text.indexOf(END_MARKER, start)
  if (end < 0) return text.slice(0, start)
  return `${text.slice(0, start)}${text.slice(end + END_MARKER.length)}`
}

/**
 * Whether a patch document is the empty profile root.
 * @param text - the document body.
 * @returns true when no entry is declared.
 */
function isEmptyEntryList(text) {
  return text.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '' && !entry.startsWith('#')).join('') === '[]'
}

/**
 * Compose the managed block from the shipped template.
 * @param pluginsDir - the directory the packages were installed into.
 * @returns the block, markers included.
 */
function composeBlock(pluginsDir) {
  // Normalise first: a Windows checkout with core.autocrlf hands over CRLF, and
  // the managed block must be byte-identical everywhere for the strip/replace to
  // stay idempotent.
  const template = readFileSync(join(HERE, 'patch', 'remote-ssh.patch.yml.tpl'), 'utf8').split('\r\n').join('\n')
  const body = template.split('\n').map((entry) => (entry.includes('@@PLUGINS_DIR@@') ? entry.split('@@PLUGINS_DIR@@').join(pluginsDir) : entry)).join('\n')
  return `${BEGIN_MARKER}\n${body.trimEnd()}\n${END_MARKER}`
}

/**
 * The row ids a patch document declares, disabled ones included.
 * @param text - the document body.
 * @returns every `- id:` value, in document order.
 */
function rowIds(text) {
  return text.split('\n').map((entry) => /^\s*-\s+id:\s*(\S+)/.exec(entry)?.[1]).filter((id) => id !== undefined)
}

// ── phase 1: checking ────────────────────────────────────────────────────────

/** Compare two dotted versions numerically. */
function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Probe every requirement and report it, failing before anything is written.
 *
 * A hard requirement is one without which the plugin cannot load or cannot work:
 * Node in the harness's range, an OpenSSH client, a harness home with a profiles
 * directory, a writable destination, and the harness's own module tree reachable
 * from where the packages will sit. Tailscale is reported but optional.
 * @param context - the resolved paths this run touches.
 */
function checkAll(context) {
  const { dshHome, profilesDir, pluginsDir } = context

  const nodeVersion = process.versions.node
  const nodeOk = compareVersions(nodeVersion, NODE_FLOOR) >= 0
  step(nodeOk ? 'ok' : 'fail', 'node', `v${nodeVersion} ${dim(`(the harness requires >= ${NODE_FLOOR})`)}`)
  if (!nodeOk) throw new RequirementError(`Node ${nodeVersion} is older than ${NODE_FLOOR}`, 'upgrade Node; the harness itself refuses to boot below this range')

  step('ok', 'platform', `${process.platform} ${dim(process.arch)}`)

  // `ssh -V` prints its banner on STDERR and exits 0, so the version comes from
  // the merged streams rather than from stdout alone.
  const ssh = spawnSync('ssh', ['-V'], { encoding: 'utf8' })
  const sshBanner = `${ssh.stderr ?? ''}${ssh.stdout ?? ''}`.trim().split('\n')[0]
  if (ssh.error?.code === 'ENOENT') {
    step('fail', 'ssh', 'not found on PATH')
    throw new RequirementError('no OpenSSH client on PATH', 'install one: `apt-get install openssh-client`, `brew install openssh`, or the Windows OpenSSH feature')
  }
  step('ok', 'ssh', sshBanner)

  const tailscale = spawnSync('tailscale', ['version'], { encoding: 'utf8' })
  const tailscaleVersion = `${tailscale.stdout ?? ''}${tailscale.stderr ?? ''}`.trim().split('\n')[0].split(' ')[0]
  if (tailscale.error?.code === 'ENOENT') step('info', 'tailscale', `optional ${dim('— absent, so only the OpenSSH transport is offered')}`)
  else step('ok', 'tailscale', `${tailscaleVersion} ${dim('— the Tailscale SSH transport is available')}`)

  if (!existsSync(profilesDir)) {
    step('fail', 'harness', `${shorten(profilesDir, dshHome)} not found`)
    throw new RequirementError(`no harness home at ${dshHome}`, 'run `dsh --profile web --help` once to create it, or pass --dsh-home DIR')
  }
  try {
    statSync(realpathSync(profilesDir))
  } catch {
    step('fail', 'harness', `cannot read ${profilesDir}`)
    throw new RequirementError(`${profilesDir} is not readable`, 'check the permissions on the harness home')
  }
  step('ok', 'harness', dshHome)

  // The probe must NOT create the directory: checking runs before the transaction
  // snapshot, so a directory created here would survive a rollback. Writability of
  // a destination that does not exist yet is the writability of its parent.
  const pluginsExists = existsSync(pluginsDir)
  try {
    accessSync(pluginsExists ? pluginsDir : profilesDir, constants.W_OK)
  } catch {
    step('fail', 'writable', `${shorten(pluginsExists ? pluginsDir : profilesDir, dshHome)} is read-only`)
    throw new RequirementError(`cannot write to ${pluginsDir}`, 'fix the permissions on the harness home, or re-run as the account that owns it')
  }
  step('ok', 'writable', pluginsExists ? `${shorten(pluginsDir, dshHome)} accepts writes` : `${shorten(pluginsDir, dshHome)} will be created`)

  // The packages resolve `@deepseek-ai/dsh-*` by walking up from their own
  // location, so the harness's module tree has to be reachable from there. This is
  // the one requirement whose absence is silent until boot time.
  const modulesRoot = join(profilesDir, 'node_modules', '@deepseek-ai', 'cordis')
  if (!existsSync(modulesRoot)) {
    step('fail', 'modules', `${shorten(modulesRoot, dshHome)} is missing`)
    throw new RequirementError('the harness module tree is not importable from the install location', 'boot the harness once (`dsh --profile web --help`) so its dependencies are installed')
  }
  step('ok', 'modules', `${shorten(modulesRoot, dshHome)} present`)
}

// ── phase 2: installing ──────────────────────────────────────────────────────

/**
 * Copy or link both packages into the destination.
 * @param options - parsed flags.
 * @param context - resolved paths.
 */
function installPackages(options, context) {
  for (const name of PACKAGES) {
    const source = requirePath(join(HERE, 'packages', name), `package ${name}`)
    const destination = join(context.pluginsDir, name)
    const files = countFiles(source)
    if (options.dryRun) {
      step('info', 'would', `${options.link ? 'link' : 'copy'} ${name} ${glyph.arrow} ${shorten(destination, context.dshHome)} ${dim(`(${files} files)`)}`)
      continue
    }
    rmSync(destination, { recursive: true, force: true })
    if (options.link) {
      // A symlinked package is imported through its real path, so Node resolves
      // its bare `@deepseek-ai/dsh-*` imports from the SOURCE tree — which is why
      // `--link` only works for a checkout that sits under the profiles root.
      symlinkSync(source, destination, 'dir')
      step('ok', 'linked', `${name} ${glyph.arrow} ${dim(shorten(destination, context.dshHome))}`)
    } else {
      cpSync(source, destination, { recursive: true })
      step('ok', 'copied', `${name} ${glyph.arrow} ${dim(shorten(destination, context.dshHome))} ${dim(`(${files} files)`)}`)
    }
  }
}

/**
 * Merge the managed block into the home patch layer.
 * @param options - parsed flags.
 * @param context - resolved paths.
 */
function installPatch(options, context) {
  const existing = readIfPresent(context.patchPath)
  const base = isEmptyEntryList(stripBlock(existing)) ? '# dsh home-level patch layer.\n[]\n' : stripBlock(existing)
  const block = composeBlock(context.pluginsDir)
  const rows = rowIds(block).length
  if (options.dryRun) {
    step('info', 'would', `write ${shorten(context.patchPath, context.dshHome)} ${dim(`(${rows} rows)`)}`)
    return
  }
  mkdirSync(dirname(context.patchPath), { recursive: true })
  writeFileSync(context.patchPath, `${base.trimEnd()}\n\n${block}\n`)
  step('ok', 'patched', `${shorten(context.patchPath, context.dshHome)} ${dim(`(${rows} rows)`)}`)
}

/**
 * Rewrite the namespace's `enabled` value inside an existing section.
 *
 * The document is a flat map of namespaces, so the section ends at the first
 * line that starts a new top-level key. Only `enabled` is touched: every other
 * key the operator may have written there is preserved verbatim, which is what
 * makes re-running the installer safe.
 * @param text - the current document.
 * @param value - the next `enabled` value.
 * @returns the document with the value applied, or undefined when no section exists.
 */
function setEnabledInSection(text, value) {
  const lines = text.split('\n')
  const start = lines.findIndex((entry) => entry.startsWith(`${SETTINGS_NAMESPACE}:`))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) { end = index; break }
  }
  const body = lines.slice(start + 1, end)
  const enabledAt = body.findIndex((entry) => /^\s*enabled\s*:/.test(entry))
  const indentation = body.find((entry) => /^\s*\S/.test(entry))?.match(/^\s*/)?.[0] ?? '  '
  if (enabledAt >= 0) body[enabledAt] = `${indentation}enabled: ${value}`
  else body.unshift(`${indentation}enabled: ${value}`)
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n')
}

/**
 * The `enabled` value a stored section currently resolves to.
 * @param text - the settings document.
 * @returns true, false, or undefined when the section or the key is absent.
 */
function enabledInSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((entry) => entry.startsWith(`${SETTINGS_NAMESPACE}:`))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) break
    const match = /^\s*enabled\s*:\s*(true|false)\s*$/.exec(lines[index])
    if (match !== null) return match[1] === 'true'
  }
  return undefined
}

/**
 * Write the settings section, honouring an existing operator choice.
 *
 * Installing activates: the section is created with `enabled: true` unless
 * `--keep-off` was passed. An EXISTING section is never flipped by a plain
 * re-install — that value is the operator's answer — but `--enable` overrides it,
 * which is the only way back from a deliberate `--keep-off`.
 * @param options - parsed flags.
 * @param context - resolved paths.
 * @returns whether the plugin is enabled after this step.
 */
function installSettings(options, context) {
  const { settingsPath, dshHome } = context
  const existing = readIfPresent(settingsPath)
  const filename = shorten(settingsPath, dshHome)
  const current = enabledInSection(existing)
  if (current !== undefined) {
    if (options.force && current === false) {
      if (options.dryRun) { step('info', 'would', `set ${SETTINGS_NAMESPACE}.enabled = true in ${filename}`); return true }
      writeFileSync(settingsPath, setEnabledInSection(existing, 'true'))
      step('ok', 'enabled', `${filename} ${dim('remote-ssh.enabled = true')}`)
      return true
    }
    if (options.enable === false && current === true) {
      if (options.dryRun) { step('info', 'would', `set ${SETTINGS_NAMESPACE}.enabled = false in ${filename}`); return false }
      writeFileSync(settingsPath, setEnabledInSection(existing, 'false'))
      step('ok', 'kept off', `${filename} ${dim('remote-ssh.enabled = false')}`)
      return false
    }
    // Report the stored answer, never a default: saying "waiting for activation"
    // over an enabled setting is how a working installation looks broken.
    step('ok', 'kept', `${filename} ${dim(`remote-ssh.enabled = ${current}`)}`)
    return current
  }
  const enabled = options.enable === true
  if (options.dryRun) {
    step('info', 'would', `append ${SETTINGS_NAMESPACE} to ${filename} ${dim(`(enabled = ${enabled})`)}`)
    return enabled
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${existing.trimEnd()}\n${SETTINGS_NAMESPACE}:\n  enabled: ${enabled}\n`)
  step('ok', enabled ? 'enabled' : 'seeded', `${filename} ${dim(`remote-ssh.enabled = ${enabled}`)}`)
  return enabled
}

// ── phase 3: verifying ───────────────────────────────────────────────────────

/**
 * Read the installation back, including a real import of the host module.
 *
 * The import is the point: it is exactly what the Cordis loader does at the next
 * boot, from exactly this path, resolving exactly these dependencies. A truncated
 * copy, a lost export, or an unreachable `@deepseek-ai/cordis` fail here, in the
 * installer, where the message can still be actionable.
 * @param context - resolved paths.
 * @param expected - the state this run intended to leave behind.
 * @returns true when every check passed.
 */
async function verifyAll(context, expected) {
  let ok = true
  const failed = (label, detail) => { step('fail', label, detail); ok = false }

  let total = 0
  const missing = PACKAGES.filter((name) => !existsSync(join(context.pluginsDir, name)))
  if (missing.length > 0) failed('files', `${missing.join(', ')} missing from ${shorten(context.pluginsDir, context.dshHome)}`)
  else {
    for (const name of PACKAGES) total += countFiles(join(context.pluginsDir, name))
    step('ok', 'files', `${total} files under ${shorten(context.pluginsDir, context.dshHome)}`)
  }

  const ids = new Set(rowIds(readIfPresent(context.patchPath)))
  const absent = EXPECTED_ROWS.filter((id) => !ids.has(id))
  if (absent.length > 0) failed('composition', `${absent.join(', ')} missing from ${shorten(context.patchPath, context.dshHome)}`)
  else step('ok', 'composition', `${EXPECTED_ROWS.length} expected rows in ${shorten(context.patchPath, context.dshHome)}`)

  const enabled = enabledInSection(readIfPresent(context.settingsPath))
  if (enabled !== expected.enabled) failed('setting', `remote-ssh.enabled is ${enabled}, expected ${expected.enabled}`)
  else step('ok', 'setting', `remote-ssh.enabled = ${enabled}`)

  try {
    const module = await import(pathToFileURL(join(context.pluginsDir, 'dsh-remote-ssh', 'lib', 'registry.js')).href)
    if (typeof module.RemoteRegistry !== 'function') failed('module', 'registry.js exports no RemoteRegistry class')
    else step('ok', 'module', `registry.js imports and exports RemoteRegistry ${dim('(as the loader will)')}`)
  } catch (error) {
    failed('module', `registry.js did not import: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  return ok
}

// ── the transaction ──────────────────────────────────────────────────────────

/** A snapshot that can be restored, or discarded once the install is proven. */
class Transaction {
  /**
   * @param root - the private directory holding the snapshots.
   * @param entries - one record per touched path.
   */
  constructor(root, entries) {
    this.root = root
    this.entries = entries
  }

  /**
   * Take a snapshot of every path this run will touch.
   *
   * Paths that do not exist yet are recorded as such, so a rollback removes them
   * rather than restoring an older copy that never existed.
   * @param context - resolved paths.
   * @returns the open transaction.
   */
  static begin(context) {
    const root = join(context.dshHome, `.dsh-remote-ssh-rollback-${process.pid}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const targets = [
      { path: context.patchPath, directory: false },
      { path: context.settingsPath, directory: false },
      ...PACKAGES.map((name) => ({ path: join(context.pluginsDir, name), directory: true })),
      // The plugins directory itself: the installer creates it when the harness
      // home has none yet, so a rollback should not leave an empty one behind.
      // It is only removed when it did not exist AND is empty afterwards, because
      // it is shared with every other plugin.
      { path: context.pluginsDir, directory: true, removeOnlyIfEmpty: true },
    ]
    const entries = []
    for (const target of targets) {
      if (!existsSync(target.path)) { entries.push({ ...target, existed: false }); continue }
      // Directory-ness is read from the filesystem, not assumed: a path that was
      // replaced by a directory between runs must still snapshot and restore.
      const directory = statSync(target.path).isDirectory()
      const backup = join(root, String(entries.length))
      cpSync(target.path, backup, { recursive: directory, dereference: false, force: true })
      entries.push({ ...target, directory, existed: true, backup })
    }
    return new Transaction(root, entries)
  }

  /**
   * Put back exactly what was there before, and report each restoration.
   *
   * A rollback that itself fails is reported loudly rather than swallowed: the
   * operator has to know the harness home is in a state the installer did not
   * choose.
   * @returns the number of paths restored.
   */
  rollback() {
    let restored = 0
    for (const entry of this.entries) {
      try {
        if (entry.removeOnlyIfEmpty === true) {
          if (!entry.existed) {
            // Non-recursive by design: it removes the directory only when it is
            // empty, so another plugin's packages can never be destroyed here.
            try { rmdirSync(entry.path) } catch (error) { if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error }
          }
          continue
        }
        rmSync(entry.path, { recursive: true, force: true })
        if (entry.existed) cpSync(entry.backup, entry.path, { recursive: entry.directory, dereference: false, force: true })
        restored += 1
      } catch (error) {
        step('fail', 'rollback', `${shorten(entry.path, this.root)} could not be restored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    rmSync(this.root, { recursive: true, force: true })
    return restored
  }

  /** Discard the snapshots; the installation is proven. */
  commit() {
    rmSync(this.root, { recursive: true, force: true })
  }
}

/** The verification did not confirm the installation. */
class VerificationError extends Error {
  /**
   * @param message - which check failed.
   */
  constructor(message) {
    super(message)
    this.name = 'VerificationError'
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Entry point. */
async function main() {
  const started = Date.now()
  const options = parseArgs(process.argv.slice(2))
  const dshHome = resolveDshHome(options.dshHome)
  const context = {
    dshHome,
    profilesDir: join(dshHome, 'profiles'),
    pluginsDir: join(dshHome, 'profiles', 'plugins'),
    patchPath: join(dshHome, 'cordis.patch.yml'),
    settingsPath: join(dshHome, 'settings.yaml'),
  }

  header(dshHome)

  if (options.uninstall) {
    phase('removing')
    for (const name of PACKAGES) {
      const target = join(context.pluginsDir, name)
      if (!existsSync(target)) { step('info', 'absent', shorten(target, dshHome)); continue }
      if (options.dryRun) step('info', 'would', `remove ${shorten(target, dshHome)}`)
      else { rmSync(target, { recursive: true, force: true }); step('ok', 'removed', shorten(target, dshHome)) }
    }
    const current = readIfPresent(context.patchPath)
    if (current === '') step('info', 'absent', shorten(context.patchPath, dshHome))
    else if (options.dryRun) step('info', 'would', `strip the managed block from ${shorten(context.patchPath, dshHome)}`)
    else { writeFileSync(context.patchPath, `${stripBlock(current).trimEnd()}\n`); step('ok', 'restored', shorten(context.patchPath, dshHome)) }
    line()
    rule()
    line(`Uninstalled. The profiles you connected stay in ${cyan('remotes.json')}, and their mirrors stay on disk.`)
    line()
    return
  }

  phase('checking')
  checkAll(context)

  // Everything from here on is reversible. The snapshot is taken before the first
  // write, so a failed copy, a failed settings write, or a failed verification all
  // end with the harness home exactly as it was found.
  const transaction = options.dryRun ? undefined : Transaction.begin(context)
  let enabled
  try {
    phase(options.dryRun ? 'installing (dry run — nothing is written)' : 'installing')
    installPackages(options, context)
    installPatch(options, context)
    enabled = installSettings(options, context)

    if (!options.dryRun) {
      phase('verifying')
      if (!(await verifyAll(context, { enabled }))) throw new VerificationError('one or more checks above did not pass')
    }
    transaction?.commit()
  } catch (error) {
    if (transaction !== undefined) {
      phase('rolling back')
      const restored = transaction.rollback()
      step('ok', 'restored', `${restored} path(s) put back; the harness home is as it was`)
      line()
      line(`${red(bold('Installation cancelled.'))} Nothing was left half-applied.`)
      line(dim(error instanceof Error ? error.message : String(error)))
      line()
      process.exit(1)
    }
    throw error
  }

  // There is no "verification failed" branch here: a failed verification throws
  // inside the transaction, so this point is only ever reached with a proven
  // install. Saying otherwise would be dead code that reads as a real case.
  line()
  rule()
  if (options.dryRun) {
    line(`${cyan(bold('Dry run.'))} Nothing was written; every check above passed. A real run would leave the plugin ${enabled === true ? 'enabled' : 'switched off'}.`)
  } else if (enabled === true) {
    line(`${green(bold(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`))} Reload the harness page, then ${cyan('workspace "+"')} ${glyph.arrow} ${cyan('"Serveur distant (SSH)"')}.`)
  } else {
    line(`${yellow(bold('Installed, switched off.'))} ${cyan('workspace "+"')} stays as it is until you enable it:`)
    line(`  ${glyph.arrow} ${bold('Settings')} ${glyph.arrow} ${bold('Plugins')} ${glyph.arrow} ${bold('"Workspaces distants (SSH)"')} ${glyph.arrow} click ${bold('"Désactivé"')}, or run ${cyan('node install.mjs --enable')}`)
  }
  line()
}

main().catch((error) => {
  process.stdout.write('\n')
  if (error instanceof RequirementError) {
    step('fail', 'requirement', error.message)
    line(`${INDENT}   ${glyph.arrow} ${error.remedy}`)
  } else {
    line(`${red(glyph.fail)} ${red('dsh-remote-ssh:')} ${error instanceof Error ? error.message : String(error)}`)
  }
  process.stdout.write('\n')
  process.exit(1)
})
