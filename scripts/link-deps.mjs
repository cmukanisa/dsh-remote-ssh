#!/usr/bin/env node
/**
 * Link the test suite's runtime dependencies from an existing harness install.
 *
 * The plugin imports `@deepseek-ai/cordis`, `@deepseek-ai/dsh-fs`, … exactly as
 * the harness does, but this repository is not a harness checkout, so Node finds
 * nothing to resolve. Rather than vendoring a second copy of the harness (which
 * would let the tests drift from the runtime they claim to test), this script
 * symlinks the packages of an already-installed harness into `./node_modules`.
 *
 * Resolution order for that install:
 *   1. `$DSH_HOME/profiles/node_modules/@deepseek-ai` (a booted dsh home);
 *   2. `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai` (global dsh).
 *
 * Usage: node scripts/link-deps.mjs [--check]
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TARGET = join(HERE, 'node_modules', '@deepseek-ai')

/** Every `@deepseek-ai` package the plugin or its tests import directly. */
const REQUIRED = [
  'cordis',
  'dsh-bash-local',
  'dsh-bash-sandbox',
  'dsh-brand',
  'dsh-fs',
  'dsh-fs-local',
  'dsh-fs-sandbox',
  'dsh-llm',
  'dsh-sandbox',
  'dsh-subprocess-local',
  'dsh-typert-protocol',
  'schemastery',
]

/**
 * Candidate directories holding an installed harness's `@deepseek-ai` packages.
 * @returns existing candidate directories, best first.
 */
function candidates() {
  const roots = []
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  roots.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'))
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    roots.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  } catch {
    /* npm is optional: a harness home is enough */
  }
  return roots.filter((root) => existsSync(root))
}

/** The first candidate that actually carries the required packages. */
function pickSource() {
  for (const root of candidates()) {
    const names = new Set(readdirSync(root))
    if (REQUIRED.every((name) => names.has(name))) return root
  }
  return undefined
}

const source = pickSource()
if (source === undefined && process.argv.includes('--check')) {
  process.stderr.write('link-deps: no harness install found; run `dsh --profile web --help` once, or `npm i -g @deepseek-ai/dsh`\n')
  process.exit(1)
}
if (source === undefined) {
  process.stderr.write('link-deps: no harness install found.\n  Boot the harness once (`dsh --profile web --help`) or install it globally (`npm i -g @deepseek-ai/dsh`), then re-run.\n')
  process.exit(1)
}

mkdirSync(TARGET, { recursive: true })
let linked = 0
for (const name of REQUIRED) {
  const from = join(source, name)
  if (!existsSync(from)) continue
  const to = join(TARGET, name)
  rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, 'dir')
  linked += 1
}
process.stdout.write(`link-deps: ${linked} packages linked from ${source}\n`)
