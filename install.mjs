#!/usr/bin/env node
/**
 * Idempotent installer for the `dsh-remote-ssh` plugin.
 *
 * It performs exactly three durable changes and is safe to re-run:
 *
 *  1. copies the two packages into `<DSH_HOME>/profiles/plugins/` — under the
 *     profiles root so their bare `@deepseek-ai/dsh-*` imports resolve through
 *     the harness's own `node_modules` without a bundling step;
 *  2. replaces this plugin's block in `<DSH_HOME>/cordis.patch.yml` — the
 *     home-level layer, so every profile sees the rows;
 *  3. seeds `<DSH_HOME>/settings.yaml` with `remote-ssh.enabled: false` when the
 *     namespace has no section yet, so the harness ASKS to be activated instead
 *     of silently gaining SSH access.
 *
 * The output is the operator's only window into those three changes, so it is
 * built as a small report rather than a stream of lines: a header that says what
 * this is, one aligned row per change, and a closing line that says what to do
 * next. Colour and box-drawing are used only when the terminal supports them.
 *
 * Usage:
 *   node install.mjs [--enable] [--link] [--dry-run] [--no-color] [--dsh-home DIR] [--uninstall]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = ['dsh-remote-ssh', 'dsh-remote-ssh-ui']
const SETTINGS_NAMESPACE = 'remote-ssh'
const BEGIN_MARKER = '# >>> dsh-remote-ssh (managed block — re-running the installer replaces it) >>>'
const END_MARKER = '# <<< dsh-remote-ssh <<<'
const AUTHOR = 'Christian Kasse (cmukanisa)'
const HOMEPAGE = 'https://github.com/cmukanisa/dsh-remote-ssh'

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
  const left = `${mark} ${label.padEnd(8)}`
  const dots = Math.max(2, WIDTH - INDENT.length - visible(left).length - detail.length - 3)
  line(`${left}${dim(` ${glyph.bullet.repeat(dots)} `)}${dim(detail)}`)
}

/** A horizontal rule that spans the report width. */
function rule() {
  process.stdout.write(`${INDENT}${dim(glyph.rule.repeat(WIDTH - INDENT.length))}\n`)
}

/** A dim section label. */
function section(title) {
  process.stdout.write(`\n${INDENT}${bold(title)}\n`)
}

/**
 * The header: what this is, whose it is, and where it is going.
 * @param destination - the harness home being written to.
 */
function header(destination, options = {}) {
  const version = readVersion()
  const rows = [
    `${brand(glyph.diamond)} ${bold(`dsh-remote-ssh`)} ${dim(`v${version}`)}`,
    dim('Remote SSH workspaces for the DeepSeek Harness'),
    `${dim('by')} ${brand(AUTHOR)} ${dim(`· ${HOMEPAGE}`)}`,
  ]
  const inner = Math.min(WIDTH - 4, Math.max(...rows.map((row) => visible(row).length)) + 2)
  process.stdout.write(`${INDENT}${dim(glyph.tl + glyph.h.repeat(inner + 2) + glyph.tr)}\n`)
  for (const row of rows) {
    const padding = ' '.repeat(Math.max(0, inner - visible(row).length))
    process.stdout.write(`${INDENT}${dim(glyph.v)} ${row}${padding} ${dim(glyph.v)}\n`)
  }
  process.stdout.write(`${INDENT}${dim(glyph.bl + glyph.h.repeat(inner + 2) + glyph.br)}\n`)
  if (options.showHarness === false) return
  line()
  line(`${dim('harness'.padEnd(9))}${cyan(destination)}`)
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

// ── flags ────────────────────────────────────────────────────────────────────

/** Parse the small flag surface; no dependency, no config file. */
function parseArgs(argv) {
  const options = { enable: false, link: false, dryRun: false, uninstall: false, dshHome: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--enable') options.enable = true
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
  section('options')
  const rows = [
    ['--enable', 'activate immediately, instead of waiting for the Settings switch'],
    ['--link', 'symlink the packages instead of copying them (development)'],
    ['--dry-run', 'report what would change, touch nothing'],
    ['--uninstall', 'remove the packages, the composition rows, and the setting'],
    ['--no-color', 'plain output'],
    ['--dsh-home DIR', 'harness home to install into (default: $DSH_HOME or ~/.dsh)'],
  ]
  for (const [flag, description] of rows) line(`${brand(flag.padEnd(15))} ${dim(description)}`)
  line()
  line(`${dim('The installer is idempotent: re-running it replaces its own block.')}`)
  line()
}

// ── filesystem ───────────────────────────────────────────────────────────────

/** Require a value the installation cannot proceed without. */
function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`${description} not found at ${path}`)
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
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).join('') === '[]'
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
  const body = template.split('\n').map((line) => (line.includes('@@PLUGINS_DIR@@') ? line.split('@@PLUGINS_DIR@@').join(pluginsDir) : line)).join('\n')
  return `${BEGIN_MARKER}\n${body.trimEnd()}\n${END_MARKER}`
}

// ── the three changes ────────────────────────────────────────────────────────

/**
 * Install the two packages and return the directory they landed in.
 * @param options - parsed flags.
 * @param pluginsDir - destination root.
 * @param dshHome - harness home, for the short path the report prints.
 * @returns the destination root.
 */
function installPackages(options, pluginsDir, dshHome) {
  mkdirSync(pluginsDir, { recursive: true })
  for (const name of PACKAGES) {
    const source = requirePath(join(HERE, 'packages', name), `package ${name}`)
    const destination = join(pluginsDir, name)
    const shown = shorten(destination, dshHome)
    if (options.dryRun) {
      step('info', 'would', `${options.link ? 'link' : 'copy'} ${name} ${glyph.arrow} ${shown}`)
      continue
    }
    rmSync(destination, { recursive: true, force: true })
    if (options.link) {
      // A symlinked package is imported through its real path, so Node resolves
      // its bare `@deepseek-ai/dsh-*` imports from the SOURCE tree — which is why
      // `--link` only works for a checkout that sits under the profiles root.
      symlinkSync(source, destination, 'dir')
      step('ok', 'linked', `${name} ${glyph.arrow} ${dim(shown)}`)
    } else {
      cpSync(source, destination, { recursive: true })
      step('ok', 'copied', `${name} ${glyph.arrow} ${dim(shown)}`)
    }
  }
  return pluginsDir
}

/**
 * Merge the managed block into the home patch layer.
 * @param options - parsed flags.
 * @param patchPath - the home layer path.
 * @param pluginsDir - the directory the packages were installed into.
 * @param dshHome - harness home, for the short path the report prints.
 */
function installPatch(options, patchPath, pluginsDir, dshHome) {
  const existing = readIfPresent(patchPath)
  const withoutBlock = stripBlock(existing)
  const base = isEmptyEntryList(withoutBlock) ? '# dsh home-level patch layer.\n[]\n' : withoutBlock
  const block = composeBlock(pluginsDir)
  const rows = block.split('\n').filter((entry) => /^\s*-\s+id:/.test(entry)).length
  if (options.dryRun) {
    step('info', 'would', `write ${shorten(patchPath, dshHome)} ${dim(`(${block.split('\n').length} lines)`)}`)
    return
  }
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, `${base.trimEnd()}\n\n${block}\n`)
  step('ok', 'patched', `${shorten(patchPath, dshHome)} ${dim(`${rows} rows`)}`)
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
  const start = lines.findIndex((line) => line.startsWith(`${SETTINGS_NAMESPACE}:`))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) { end = index; break }
  }
  const body = lines.slice(start + 1, end)
  const enabledAt = body.findIndex((line) => /^\s*enabled\s*:/.test(line))
  const indentation = body.find((line) => /^\s*\S/.test(line))?.match(/^\s*/)?.[0] ?? '  '
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
  const start = lines.findIndex((line) => line.startsWith(`${SETTINGS_NAMESPACE}:`))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) break
    const match = /^\s*enabled\s*:\s*(true|false)\s*$/.exec(lines[index])
    if (match !== null) return match[1] === 'true'
  }
  return undefined
}

/**
 * Seed — or, with `--enable`, update — the settings section the Plugins card renders.
 * @param options - parsed flags.
 * @param settingsPath - `$DSH_HOME/settings.yaml`.
 * @param dshHome - harness home, for the short path the report prints.
 * @returns whether the plugin is enabled once this step has run.
 */
function installSettings(options, settingsPath, dshHome) {
  const existing = readIfPresent(settingsPath)
  const filename = shorten(settingsPath, dshHome)
  const current = enabledInSection(existing)
  if (current !== undefined) {
    if (!options.enable) {
      // The section is the user's answer to "activate me?"; a plain re-install
      // must not overwrite it, and it must report that answer rather than
      // claiming to be waiting for one it already has.
      step('ok', 'kept', `${filename} ${dim(`enabled = ${current}`)}`)
      return current
    }
    if (options.dryRun) { step('info', 'would', `set ${SETTINGS_NAMESPACE}.enabled = true in ${filename}`); return true }
    writeFileSync(settingsPath, setEnabledInSection(existing, 'true'))
    step('ok', 'enabled', `${filename} ${dim('enabled = true')}`)
    return true
  }
  const enabled = options.enable === true
  if (options.dryRun) {
    step('info', 'would', `append ${SETTINGS_NAMESPACE} to ${filename} ${dim(`(enabled = ${enabled})`)}`)
    return enabled
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${existing.trimEnd()}\n${SETTINGS_NAMESPACE}:\n  enabled: ${enabled}\n`)
  step('ok', 'seeded', `${filename} ${dim(`enabled = ${enabled}`)}`)
  return enabled
}

/**
 * The prerequisites the runtime needs but cannot install, as report rows.
 * @returns one `{status, label, detail}` per prerequisite.
 */
function prerequisites() {
  const rows = []
  // `ssh -V` prints its banner on STDERR and exits 0, so the version comes from
  // the merged streams rather than from stdout alone.
  const banner = spawnSync('ssh', ['-V'], { encoding: 'utf8' }).stderr?.trim().split('\n')[0]
  if (banner === undefined || banner === '') rows.push({ status: 'fail', label: 'ssh', detail: 'NOT FOUND — install an OpenSSH client; nothing works without it' })
  else rows.push({ status: 'ok', label: 'ssh', detail: banner })
  const tailscale = spawnSync('tailscale', ['version'], { encoding: 'utf8' })
  const tailscaleVersion = `${tailscale.stdout ?? ''}${tailscale.stderr ?? ''}`.trim().split('\n')[0]
  if (tailscale.error?.code === 'ENOENT') rows.push({ status: 'info', label: 'tailscale', detail: 'optional — absent, so only the OpenSSH transport is offered' })
  else rows.push({ status: 'ok', label: 'tailscale', detail: tailscaleVersion.split(' ')[0] || 'present' })
  if (process.platform === 'win32') rows.push({ status: 'info', label: 'windows', detail: 'no connection multiplexing: every call opens its own connection' })
  return rows
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Entry point. */
function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshHome = resolveDshHome(options.dshHome)
  const profilesDir = join(dshHome, 'profiles')
  const pluginsDir = join(profilesDir, 'plugins')
  const patchPath = join(dshHome, 'cordis.patch.yml')
  const settingsPath = join(dshHome, 'settings.yaml')

  header(dshHome)

  if (options.uninstall) {
    section('removing')
    for (const name of PACKAGES) {
      const target = join(pluginsDir, name)
      if (!existsSync(target)) continue
      if (options.dryRun) step('info', 'would', `remove ${shorten(target, dshHome)}`)
      else { rmSync(target, { recursive: true, force: true }); step('ok', 'removed', shorten(target, dshHome)) }
    }
    const current = readIfPresent(patchPath)
    if (current !== '') {
      if (options.dryRun) step('info', 'would', `strip the managed block from ${shorten(patchPath, dshHome)}`)
      else { writeFileSync(patchPath, `${stripBlock(current).trimEnd()}\n`); step('ok', 'restored', shorten(patchPath, dshHome)) }
    }
    line()
    rule()
    line(`Uninstalled. The profiles you connected stay in ${cyan('remotes.json')}, and their mirrors stay on disk.`)
    line()
    return
  }

  requirePath(profilesDir, 'a dsh profiles directory (run `dsh --profile web` once first)')
  try {
    statSync(realpathSync(profilesDir))
  } catch {
    throw new Error(`cannot read ${profilesDir}`)
  }

  section(options.dryRun ? 'dry run — nothing is written' : 'installing')
  installPackages(options, pluginsDir, dshHome)
  installPatch(options, patchPath, pluginsDir, dshHome)
  const enabled = installSettings(options, settingsPath, dshHome)

  section('prerequisites')
  for (const row of prerequisites()) step(row.status, row.label, row.detail)

  line()
  rule()
  if (options.dryRun) {
    line(`${cyan(bold('Dry run.'))} Nothing was written. A real run would leave the plugin ${enabled === true ? 'enabled' : 'switched off, waiting for activation'}.`)
  } else if (enabled === true) {
    line(`${green(bold('Enabled.'))} Reload the harness page, then ${cyan('workspace "+"')} ${glyph.arrow} ${cyan('"Serveur distant (SSH)"')}.`)
  } else {
    line(`${yellow(bold('Activation required.'))} The plugin is installed and switched off, on purpose.`)
    line()
    line(`  ${glyph.arrow} ${bold('Settings')} ${glyph.arrow} ${bold('Plugins')} ${glyph.arrow} ${bold('"Workspaces distants (SSH)"')} ${glyph.arrow} click ${bold('"Désactivé"')}`)
    line(`  ${glyph.arrow} or run ${cyan('node install.mjs --enable')}`)
  }
  line()
}

try {
  main()
} catch (error) {
  process.stderr.write(`\n${INDENT}${red(glyph.fail)} ${red('dsh-remote-ssh:')} ${error instanceof Error ? error.message : String(error)}\n\n`)
  process.exit(1)
}

/** Resolve the harness home the same way the launcher does. */
function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}
