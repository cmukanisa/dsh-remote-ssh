/**
 * End-to-end suite against a REAL, RUNNING harness.
 *
 * The other two suites test the plugin's own layers; this one tests the thing a
 * user actually touches: a booted `dsh` process where the plugin is composed,
 * the browser bundle is served, and the `sshWorkspace` Remote namespace answers
 * over the same gateway the web UI uses.
 *
 * Usage:
 *   node test/harness.e2e.mjs --base http://127.0.0.1:3099 --token TOKEN \
 *     [--host 127.0.0.1] [--port 22] [--user dsh] [--key ~/.ssh/id_ed25519]
 */
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}

const base = option('base', 'http://127.0.0.1:3099')
const token = option('token', process.env.DSH_WEB_TOKEN)
const host = option('host', '127.0.0.1')
const port = Number(option('port', '22'))
const user = option('user', process.env.USER ?? 'root')
const key = option('key', undefined)
const remotePath = option('path', undefined)
if (token === undefined) {
  process.stderr.write('harness.e2e: --token (or DSH_WEB_TOKEN) is required; it is printed by `dsh web`\n')
  process.exit(2)
}

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Cookie jar: the index token exchange mints the session cookie every RPC needs. */
const jar = new Map()
const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')

/** Authenticate with the process token printed at boot. */
async function authenticate() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean)
  for (const cookie of cookies) {
    const [pair] = String(cookie).split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
  if (response.status >= 400) throw new Error(`index returned HTTP ${response.status}`)
  return response
}

/** One Remote call, exactly as the browser half issues it. */
async function call(method, callArgs) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${method}`, method, payload: { args: callArgs } }),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = await response.json()
  const result = body.result
  if (result?.ok === false) {
    const error = new Error(result.error?.message ?? `${method} failed`)
    error.code = result.error?.code
    throw error
  }
  return result.value
}

/** The plugin's browser bundle must be discovered AND served. */
async function checkClientBundle() {
  const index = await (await fetch(`${base}/`, { headers: { cookie: cookieHeader() } })).text()
  const marker = '__DSH_BOOT__'
  const at = index.indexOf(marker)
  check('the boot payload declares the client module', at >= 0 && index.includes('@deepseek-ai/dsh-remote-ssh-ui'))
  if (at < 0) return
  const raw = index.slice(at)
  const start = raw.indexOf('{')
  let depth = 0
  let end = -1
  for (let cursor = start; cursor < raw.length; cursor += 1) {
    if (raw[cursor] === '{') depth += 1
    else if (raw[cursor] === '}') { depth -= 1; if (depth === 0) { end = cursor + 1; break } }
  }
  if (end < 0) { check('the boot payload is parseable', false); return }
  const data = JSON.parse(raw.slice(start, end))
  const row = (data.entries ?? []).find((entry) => entry.id === '@deepseek-ai/dsh-remote-ssh-ui')
  check('the client module exposes a served URL', typeof row?.url === 'string', row?.url ?? '(absent)')
  if (row?.url === undefined) return
  const bundle = await fetch(new URL(row.url, base), { headers: { cookie: cookieHeader() } })
  const text = await bundle.text()
  check('the client bundle is served', bundle.status === 200 && text.includes('__ModuleLoader__.load'), `HTTP ${bundle.status}, ${text.length} bytes`)
  check('the served bundle registers the expected module id', text.includes('"@deepseek-ai/dsh-remote-ssh-ui"'))
}

try {
  await authenticate()
  await checkClientBundle()

  const status = await call('sshWorkspace/status', {})
  check('the Remote namespace answers', typeof status?.enabled === 'boolean', JSON.stringify(status))
  check('the mirror root is reported', typeof status?.root === 'string', status?.root)

  // A profile identifies a host+port+user triple, so a leftover registration for
  // the same target is cleared first: the suite must be re-runnable against one
  // long-lived harness without depending on the order runs happen in.
  for (const existing of status.profiles ?? []) {
    if (existing.host === host && existing.port === port && existing.user === user) await call('sshWorkspace/disconnect', { id: existing.id })
  }

  const connected = await call('sshWorkspace/connect', { input: { label: `e2e-${Date.now()}`, host, port, user, ...(key === undefined ? {} : { identityFile: key }) } })
  check('a host connects and is probed', connected?.report?.ok === true, connected?.report?.error ?? connected?.report?.platform)
  check('the probe reports the remote platform', typeof connected?.profile?.platform === 'string', connected?.profile?.platform)
  const id = connected?.profile?.id
  if (id === undefined || connected?.report?.ok !== true) throw new Error('cannot continue without a connected profile')

  const root = remotePath ?? connected.profile.home ?? '/'
  const listing = await call('sshWorkspace/list', { id, path: root })
  check('a remote directory lists', Array.isArray(listing?.entries) && typeof listing?.path === 'string', `${listing?.entries?.length ?? 0} entries at ${listing?.path}`)
  check('the listing carries breadcrumbs', Array.isArray(listing?.crumbs) && listing.crumbs[0]?.path === '/', JSON.stringify(listing?.crumbs?.map((crumb) => crumb.name)))
  check('the listing carries the mirror it maps to', typeof listing?.localPath === 'string', listing?.localPath)

  const directory = listing.entries.find((entry) => entry.type === 'directory')
  if (directory !== undefined) {
    const deeper = await call('sshWorkspace/list', { id, path: directory.path })
    check('navigating into a subdirectory works', deeper.path === directory.path, deeper.path)
  }

  const adopted = await call('sshWorkspace/adopt', { id, path: listing.path, title: `e2e:${listing.path}` })
  check('a remote folder becomes a workspace', typeof adopted?.localPath === 'string' && adopted?.workspace?.id !== undefined, JSON.stringify(adopted?.workspace))
  check('the workspace lives under the mirror root', String(adopted?.localPath).startsWith(String(status.root)), adopted?.localPath)
  if (adopted?.workspace?.id !== undefined) {
    const removed = await call('workspace/delete', { request: { workspaceId: adopted.workspace.id } })
    check('the test workspace is cleaned up', removed?.deleted === true)
  }

  await call('sshWorkspace/disconnect', { id })
  const after = await call('sshWorkspace/status', {})
  check('the profile is forgotten', (after?.profiles ?? []).every((entry) => entry.id !== id))
} catch (error) {
  check(`the run completed: ${error instanceof Error ? error.message : String(error)}`, false)
}

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
