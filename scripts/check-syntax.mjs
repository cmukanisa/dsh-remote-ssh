#!/usr/bin/env node
/**
 * Portable static check: every shipped file must PARSER-accept on the running
 * Node, and the two client bundles must keep the exact wrapper the browser
 * module table requires.
 *
 * This is deliberately parser-only. The plugin ships plain JavaScript with no
 * build step, so a syntax error is the one class of mistake that would reach a
 * user unreviewed; `node --check` catches it on Windows, macOS, and Linux alike.
 *
 * Usage: node scripts/check-syntax.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories that hold shipped code. */
const ROOTS = ['packages', 'scripts', 'test']

/**
 * Walk one tree, skipping dependencies.
 * @param directory - absolute directory to walk.
 * @returns absolute file paths.
 */
function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

const files = ROOTS.flatMap((root) => {
  const path = join(ROOT, root)
  try {
    return walk(path)
  } catch {
    return []
  }
})
const scripts = files.filter((file) => file.endsWith('.mjs') || file.endsWith('.js'))
let failures = 0

for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL  ${relative(ROOT, file)} does not parse\n${error.stderr?.toString() ?? ''}`)
  }
}
process.stdout.write(`${failures === 0 ? 'PASS' : 'FAIL'}  ${scripts.length} shipped files parse\n`)

// The browser halves are loaded by the shell's module table, not by Node, so the
// wrapper contract is checked as data: a bundle that stops registering its id
// silently disappears from the UI instead of raising anywhere.
for (const [name, expectedId] of [
  ['packages/dsh-remote-ssh-ui/lib/client.js', '@deepseek-ai/dsh-remote-ssh-ui'],
]) {
  const text = readFileSync(join(ROOT, name), 'utf8')
  const ok = text.includes('window.__ModuleLoader__.load(') && text.includes(`id: "${expectedId}"`) && text.includes('exports.apply = apply') && text.includes('exports.inject')
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} keeps the module-table wrapper for ${expectedId}\n`)
}

process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
