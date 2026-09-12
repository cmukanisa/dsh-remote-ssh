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

/** Record one assertion and print its verdict. */
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

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
  ['packages/dsh-remote-ssh-ui/lib/client.js', 'dsh-remote-ssh-ui'],
]) {
  const text = readFileSync(join(ROOT, name), 'utf8')
  const ok = text.includes('window.__ModuleLoader__.load(') && text.includes(`id: "${expectedId}"`) && text.includes('exports.apply = apply') && text.includes('exports.inject')
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} keeps the module-table wrapper for ${expectedId}\n`)

  // A `single` slot REFUSES a second registration at the same priority rather
  // than shadowing it, and the refusal propagates out of apply() — the whole UI
  // then shows "Failed to load plugins" instead of this plugin's surface. The
  // shipped directory picker registers at the default 0, so every registration
  // into a hole it may already occupy has to name a priority.
  const singleSlotRegistrations = [...text.matchAll(/name: "([^"]*\.directoryFlow)",([^}]*)}/g)]
  const prioritised = singleSlotRegistrations.filter((match) => /priority:/.test(match[2]))
  const allPrioritised = singleSlotRegistrations.length >= 2 && prioritised.length === singleSlotRegistrations.length
  if (!allPrioritised) failures += 1
  process.stdout.write(`${allPrioritised ? 'PASS' : 'FAIL'}  ${name} gives every single-occupancy hole an explicit priority (${prioritised.length}/${singleSlotRegistrations.length})\n`)

  // And the fallbacks have to survive a refusal: one contested slot must not take
  // the launcher and the Settings card down with it.
  const guarded = text.includes('function registerSafely(') && !/ctx\.slots\.register\(\{ name: "[^"]*\.directoryFlow"/.test(text)
  if (!guarded) failures += 1
  process.stdout.write(`${guarded ? 'PASS' : 'FAIL'}  ${name} registers through the guarded helper, so one refusal cannot unload the plugin\n`)

  // Every displayed string is a locale key, and every key exists in every
  // dictionary. A missing key renders as the key itself in that language, which
  // is a silent regression no test would otherwise catch.
  // A key counts as used when it appears as a literal anywhere in the bundle,
  // not only as `T("key")`: a key reached through a lookup table is still a key
  // the bundle can display, and requiring the call form would force every table
  // to be inlined.
  const literals = new Set([...text.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]))
  const blocks = [...text.matchAll(/\n\t\t\t(en|fr|zh): \{([\s\S]*?)\n\t\t\t\}/g)]
  check(`${name} declares the fr, en, and zh dictionaries`, blocks.length === 3, blocks.map((block) => block[1]).join(','))
  const reference = new Set(blocks.length === 0 ? [] : [...blocks[0][2].matchAll(/"([^"]+)":/g)].map((match) => match[1]))
  for (const [, locale, body] of blocks) {
    const defined = new Set([...body.matchAll(/"([^"]+)":/g)].map((match) => match[1]))
    // Missing is measured against the FIRST dictionary, so a key added to one
    // locale and forgotten in another is what this reports — not a key the source
    // happens to reach dynamically.
    const missing = [...reference].filter((key) => !defined.has(key))
    const unused = [...defined].filter((key) => !literals.has(key))
    const ok = missing.length === 0 && unused.length === 0
    if (!ok) failures += 1
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} ${locale}: ${defined.size} keys, ${missing.length} missing${missing.length > 0 ? ` (${missing.join(',')})` : ''}, ${unused.length} unused${unused.length > 0 ? ` (${unused.join(',')})` : ''}\n`)

    // A value must be the display text, never a call. A bulk rename that reaches
    // into the dictionary turns a translation into `T("its own key")`, which
    // renders the key in that language and passes every key-count check.
    const selfReferential = [...body.matchAll(/"([^"]+)":\s*(T\([^\n]*)/g)].map((match) => match[1])
    check(`${name} ${locale} values are text, not calls`, selfReferential.length === 0, selfReferential.join(','))
  }

  // Every `ctx.<service>` the bundle reads must be in `exports.inject`, base
  // service included for dotted entries: cordis throws on an undeclared read,
  // the React render crashes, and a `single` hole then abdicates to the next
  // occupant until the page is reloaded — which is how the local tab silently
  // turned into the OS chooser.
  const injectList = text.match(/exports\.inject = \[([^\]]*)\]/)?.[1] ?? ''
  const declared = new Set([...injectList.matchAll(/"([^"]+)"/g)].map((match) => match[1]))
  const missingBase = [...declared].filter((entry) => entry.includes('.') && !declared.has(entry.split('.')[0]))
  check(`${name} declares the base service of every dotted inject`, missingBase.length === 0, missingBase.join(','))
  const known = new Set(['fiber', 'effect', 'on', 'emit', 'get', 'set', 'reflect', 'events', 'root', 'scope', 'plugin', 'inject'])
  const read = new Set([...text.matchAll(/\bctx\.([a-zA-Z]+)\b/g)].map((match) => match[1]).filter((service) => !known.has(service)))
  const undeclared = [...read].filter((service) => !declared.has(service))
  check(`${name} declares every service it reads from ctx`, undeclared.length === 0, undeclared.join(','))

  // A locale key reaching the DOM as a literal would mean hardcoded copy.
  const hardcoded = [...text.matchAll(/>\s*"([A-ZÀ-ÿ][^"]{3,})"/g)].map((match) => match[1])
  check(`${name} shows no hardcoded display copy`, hardcoded.length === 0, hardcoded.join(' | '))
}

process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
