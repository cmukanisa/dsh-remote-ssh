/**
 * Detached remote work, exercised against a real SSH host.
 *
 * The property under test is the one that matters to a user: work started here
 * keeps running on the far side after the client that started it is gone, and a
 * later reader can see its state and its output without having been present.
 *
 * Usage: node test/sessions.test.mjs [host] [port] [user] [key] [root]
 */
import { Context } from '@deepseek-ai/cordis'
import { RemoteRegistry } from '../packages/dsh-remote-ssh/lib/registry.js'
import { RemoteSessionStore } from '../packages/dsh-remote-ssh/lib/sessions.js'

const env = process.env
const [host = env.DSH_SSH_TEST_HOST ?? '127.0.0.1', port = env.DSH_SSH_TEST_PORT ?? '2222', user = env.DSH_SSH_TEST_USER ?? 'dsh', identityFile = env.DSH_SSH_TEST_KEY ?? '/tmp/dsh-ssh-test/id_test', root = env.DSH_SSH_TEST_ROOT ?? '/home/dsh/work'] = process.argv.slice(2)
const knownHosts = env.DSH_SSH_TEST_KNOWN_HOSTS
const stateDir = `${env.TMPDIR ?? '/tmp'}/dsh-remote-ssh-sessions-${process.pid}`

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const ctx = new Context()
const registry = new RemoteRegistry(ctx, { root: `${stateDir}/remotes`, stateFile: `${stateDir}/remotes.json`, controlDir: `${stateDir}/mux`, connectTimeoutMs: 20000 })
const profile = registry.add({ label: 'sessions', host, port: Number(port), user, identityFile, ...(knownHosts === undefined ? {} : { extraOptions: ['-o', `UserKnownHostsFile=${knownHosts}`] }) })
const sessions = new RemoteSessionStore(ctx, { path: `${stateDir}/sessions.json` })
const probe = await registry.test(profile.id)
check('the host is reachable', probe.ok === true, probe.error ?? '')
check('the host reports whether it can give a run its own session', typeof registry.transport(profile.id).facts?.setsid === 'boolean', String(registry.transport(profile.id).facts?.setsid))

const started = await sessions.start(profile.id, { command: 'echo debut; sleep 30; echo fin', cwd: root, label: 'long sleep' })
check('a detached command starts and reports a pid', Number.isInteger(started.pid) && started.pid > 0, `pid=${started.pid}`)
check('a record is durable', JSON.parse((await import('node:fs')).readFileSync(`${stateDir}/sessions.json`, 'utf8')).sessions.length === 1)

let state = await sessions.status(started.id)
check('the run is reported as running', state.state === 'running', `${state.state} tail=${JSON.stringify(state.tail.trim())}`)
check('its live output is visible', state.tail.includes('debut'), state.tail.trim().slice(0, 60))

// The point: the client that started it is torn down, and the work continues.
// A second store instance reads the same document, like a reconnecting harness.
// A scoped child context: the second reader registers its own service instance
// while still resolving `ctx.remoteSsh` from the parent, which is exactly the
// situation of a harness that restarted against the same durable document.
const reconnected = new RemoteSessionStore(ctx.isolate('remoteSessions'), { path: `${stateDir}/sessions.json` })
check('a new reader sees the work without having been present', reconnected.list().length === 1 && reconnected.list()[0].id === started.id)
const after = await reconnected.status(started.id)
check('the work survived and is still running', after.state === 'running', after.state)

const stopped = await reconnected.stop(started.id)
check('the run can be cut', stopped.state !== 'running', stopped.state)

const finished = await reconnected.start(profile.id, { command: 'echo termine', cwd: root, label: 'quick' })
let done = await reconnected.status(finished.id)
for (let attempt = 0; attempt < 10 && done.state === 'running'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  done = await reconnected.status(finished.id)
}
check('a finished run reports its exit code', done.state === 'exited' && done.exitCode === 0, `${done.state} code=${done.exitCode}`)
check('a finished run keeps its output', done.tail.includes('termine'), done.tail.trim())

// Pruning must keep what is still running: forgetting live work would lose the
// only handle a user has on it.
const stillRunning = await reconnected.start(profile.id, { command: 'sleep 30', cwd: root, label: 'keep me' })
const dropped = reconnected.forget({ finishedOnly: true })
check('pruning drops finished records', dropped >= 1, `dropped ${dropped}`)
check('pruning keeps the work that is still running', reconnected.list().length === 1 && reconnected.list()[0].id === stillRunning.id, JSON.stringify(reconnected.list().map((entry) => [entry.id, entry.state])))
await reconnected.stop(stillRunning.id)
check('everything can be forgotten on request', reconnected.forget({ all: true }) >= 1 && reconnected.list().length === 0)
check('an unknown session is refused', await reconnected.status('nope').then(() => false, (error) => error.code === 'unknown-session'))

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
