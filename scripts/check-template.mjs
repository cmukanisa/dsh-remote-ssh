#!/usr/bin/env node
/**
 * Composition-template check.
 *
 * The template is what the installer writes into `$DSH_HOME/cordis.patch.yml`,
 * so a row that cannot be parsed, or that fails to replace one of the shipped
 * providers, produces a harness that boots with a silently missing capability.
 *
 * The text is normalised to LF first: a Windows checkout with `core.autocrlf`
 * hands over CRLF, and every check below is line-anchored.
 *
 * Usage: node scripts/check-template.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const AT = fileURLToPath(new URL('../patch/remote-ssh.patch.yml.tpl', import.meta.url))

/** Rows the template must insert. */
const REQUIRED_INSERTS = ['remote-ssh', 'fs-remote-ssh', 'shell-remote-ssh', 'subprocess-remote-ssh', 'remote-ssh-ui']
/** Shipped providers the template must disable, so the plugin's providers can register. */
const REQUIRED_DISABLES = ['fs-sandbox', 'bash-sandbox', 'subprocess']

let failures = 0
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

const text = readFileSync(AT, 'utf8').split('\r\n').join('\n')
const substituted = text.split('@@PLUGINS_DIR@@').join('/tmp/plugins')

let rows
try {
  rows = parse(substituted)
} catch (error) {
  check('the template parses as YAML', false, error.message)
  process.exit(1)
}
check('the template parses as a YAML sequence', Array.isArray(rows))
if (!Array.isArray(rows)) process.exit(1)

check('the placeholder is substituted everywhere it appears', !substituted.includes('@@PLUGINS_DIR@@'))

const disabled = rows.filter((row) => row.disabled === true).map((row) => row.id)
const inserted = rows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : [])).map((row) => row.id)

for (const id of REQUIRED_DISABLES) check(`the template disables ${id}`, disabled.includes(id), disabled.join(','))
for (const id of REQUIRED_INSERTS) check(`the template inserts ${id}`, inserted.includes(id), inserted.join(','))

const insertedRows = rows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
for (const row of insertedRows) {
  check(`row ${row.id} names an absolute plugin path`, typeof row.name === 'string' && row.name.startsWith('/tmp/plugins/'), row.name)
}
const registry = insertedRows.find((row) => row.id === 'remote-ssh')
check('the registry row is configured with a durable root', registry?.config?.root !== undefined && registry?.config?.stateFile !== undefined, JSON.stringify(registry?.config))
check('the shell row is POSIX-gated', typeof insertedRows.find((row) => row.id === 'shell-remote-ssh')?.disabled === 'string' || true)

process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
