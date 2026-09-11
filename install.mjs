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
 * Usage:
 *   node install.mjs [--enable] [--link] [--dry-run] [--dsh-home DIR] [--uninstall]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = ['dsh-remote-ssh', 'dsh-remote-ssh-ui']
const SETTINGS_NAMESPACE = 'remote-ssh'
const BEGIN_MARKER = '# >>> dsh-remote-ssh (managed block — re-running the installer replaces it) >>>'
const END_MARKER = '# <<< dsh-remote-ssh <<<'

/** Parse the small flag surface; no dependency, no config file. */
function parseArgs(argv) {
  const options = { enable: false, link: false, dryRun: false, uninstall: false, dshHome: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--enable') options.enable = true
    else if (flag === '--link') options.link = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--uninstall') options.uninstall = true
    else if (flag === '--dsh-home') { index += 1; options.dshHome = argv[index] }
    else if (flag === '--help' || flag === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`unknown option: ${flag}`)
  }
  return options
}

/** Print the flag reference. */
function printHelp() {
  process.stdout.write(`dsh-remote-ssh installer

  --enable        activate the plugin immediately (default: leave it off so the
                  harness asks you to enable it in Settings -> Plugins)
  --link          symlink the packages instead of copying them (development)
  --dry-run       report what would change, touch nothing
  --uninstall     remove the packages, the composition rows, and the setting
  --dsh-home DIR  harness home to install into (default: $DSH_HOME or ~/.dsh)
`)
}

/** Resolve the harness home the same way the launcher does. */
function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** A short, human-facing report line. */
function report(action, detail) {
  process.stdout.write(`  ${action.padEnd(9)} ${detail}\n`)
}

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

/**
 * Install the two packages and return the directory they landed in.
 * @param options - parsed flags.
 * @param pluginsDir - destination root.
 * @returns the destination root.
 */
function installPackages(options, pluginsDir) {
  mkdirSync(pluginsDir, { recursive: true })
  for (const name of PACKAGES) {
    const source = requirePath(join(HERE, 'packages', name), `package ${name}`)
    const destination = join(pluginsDir, name)
    if (options.dryRun) {
      report('would', `${options.link ? 'link' : 'copy'} ${source} -> ${destination}`)
      continue
    }
    rmSync(destination, { recursive: true, force: true })
    if (options.link) {
      // A symlinked package is imported through its real path, so Node resolves
      // its bare `@deepseek-ai/dsh-*` imports from the SOURCE tree — which is why
      // `--link` only works for a checkout that sits under the profiles root.
      symlinkSync(source, destination, 'dir')
      report('linked', destination)
    } else {
      cpSync(source, destination, { recursive: true })
      report('copied', destination)
    }
  }
  return pluginsDir
}

/**
 * Merge the managed block into the home patch layer.
 * @param options - parsed flags.
 * @param patchPath - the home layer path.
 * @param pluginsDir - the directory the packages were installed into.
 */
function installPatch(options, patchPath, pluginsDir) {
  const existing = readIfPresent(patchPath)
  const withoutBlock = stripBlock(existing)
  const base = isEmptyEntryList(withoutBlock) ? '# dsh home-level patch layer.\n[]\n' : withoutBlock
  const next = `${base.trimEnd()}\n\n${composeBlock(pluginsDir)}\n`
  if (options.dryRun) {
    report('would', `write ${patchPath} (${composeBlock(pluginsDir).split('\n').length} lines)`)
    return
  }
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, next)
  report('patched', patchPath)
}

/**
 * Seed the settings section that the Plugins page renders as this plugin's card.
 * @param options - parsed flags.
 * @param settingsPath - `$DSH_HOME/settings.yaml`.
 */
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
 * Seed — or, with `--enable`, update — the settings section the Plugins card renders.
 * @param options - parsed flags.
 * @param settingsPath - `$DSH_HOME/settings.yaml`.
 */
function installSettings(options, settingsPath) {
  const existing = readIfPresent(settingsPath)
  const hasSection = existing.split('\n').some((line) => line.startsWith(`${SETTINGS_NAMESPACE}:`))
  if (hasSection) {
    if (!options.enable) {
      // The section is the user's answer to "activate me?"; a plain re-install
      // must not overwrite it.
      report('kept', `${settingsPath} already declares "${SETTINGS_NAMESPACE}"`)
      return
    }
    const next = setEnabledInSection(existing, 'true')
    if (options.dryRun) { report('would', `set "${SETTINGS_NAMESPACE}.enabled: true" in ${settingsPath}`); return }
    writeFileSync(settingsPath, next)
    report('enabled', `${settingsPath} (${SETTINGS_NAMESPACE}.enabled: true)`)
    return
  }
  const section = `${SETTINGS_NAMESPACE}:\n  enabled: ${options.enable ? 'true' : 'false'}\n`
  if (options.dryRun) {
    report('would', `append "${SETTINGS_NAMESPACE}" to ${settingsPath}`)
    return
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${existing.trimEnd()}\n${section}`)
  report('seeded', `${settingsPath} (enabled: ${options.enable ? 'true' : 'false'})`)
}

/**
 * Report the host prerequisites the runtime needs but cannot install.
 * @returns one line per prerequisite.
 */
function checkPrerequisites() {
  const notes = []
  // `ssh -V` prints its banner on STDERR and exits 0, so the version comes from
  // the merged streams rather than from stdout alone.
  const banner = spawnSync('ssh', ['-V'], { encoding: 'utf8' }).stderr?.trim().split('\n')[0]
  notes.push(banner === undefined || banner === '' ? 'ssh: NOT FOUND — install an OpenSSH client; nothing works without it' : `ssh: ${banner}`)
  if (process.platform === 'win32') notes.push('windows: connection multiplexing is unavailable, so every call opens its own connection')
  return notes
}

/** Entry point. */
function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshHome = resolveDshHome(options.dshHome)
  const profilesDir = join(dshHome, 'profiles')
  const pluginsDir = join(profilesDir, 'plugins')
  const patchPath = join(dshHome, 'cordis.patch.yml')
  const settingsPath = join(dshHome, 'settings.yaml')

  process.stdout.write(`dsh-remote-ssh -> ${dshHome}\n`)

  if (options.uninstall) {
    for (const name of PACKAGES) {
      const target = join(pluginsDir, name)
      if (!existsSync(target)) continue
      if (options.dryRun) report('would', `remove ${target}`)
      else { rmSync(target, { recursive: true, force: true }); report('removed', target) }
    }
    const current = readIfPresent(patchPath)
    if (current !== '') {
      if (options.dryRun) report('would', `strip the managed block from ${patchPath}`)
      else { writeFileSync(patchPath, `${stripBlock(current).trimEnd()}\n`); report('unpatched', patchPath) }
    }
    process.stdout.write('\nUninstalled. The profiles you already connected stay in remotes.json and their mirrors stay on disk.\n')
    return
  }

  requirePath(profilesDir, 'a dsh profiles directory (run `dsh --profile web` once first)')
  try {
    statSync(realpathSync(profilesDir))
  } catch {
    throw new Error(`cannot read ${profilesDir}`)
  }

  installPackages(options, pluginsDir)
  installPatch(options, patchPath, pluginsDir)
  installSettings(options, settingsPath)

  process.stdout.write('\nPrerequisites\n')
  for (const note of checkPrerequisites()) report('-', note)

  process.stdout.write(`\n${options.enable ? 'Installed and enabled.' : 'Installed, waiting for activation.'}\n`)
  if (!options.enable) {
    process.stdout.write(`Activate it in the harness: Settings -> Plugins -> "Workspaces distants (SSH)" -> click "Désactivé".\n`)
    process.stdout.write(`Or set it now:  node install.mjs --enable\n`)
  }
  process.stdout.write('Then restart the harness (or reload the page) and open the workspace "+" menu.\n')
}

try {
  main()
} catch (error) {
  process.stderr.write(`dsh-remote-ssh: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
