/**
 * Windows-server expectation suite.
 *
 * The plugin drives a remote host with POSIX shell source, so a Windows OpenSSH
 * server cannot be used. That is a supported limitation, not a bug, and it must
 * FAIL VISIBLY: the connection probe has to refuse with an actionable message
 * instead of half-working and letting the agent misread the far side.
 *
 * The CI job that runs this enables the Windows OpenSSH Server feature on the
 * runner itself, so the assertion is made against a real Windows sshd.
 *
 * Usage: node test/windows-server.expect.mjs [host] [port] [user] [identityFile]
 */
import { Context } from '@deepseek-ai/cordis'
import { RemoteRegistry } from '../packages/dsh-remote-ssh/lib/registry.js'

const [host = '127.0.0.1', port = '22', user = process.env.USERNAME ?? 'runneradmin', identityFile = process.env.DSH_SSH_TEST_KEY ?? ''] = process.argv.slice(2)

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const ctx = new Context()
const registry = new RemoteRegistry(ctx, { root: `${process.env.RUNNER_TEMP ?? '/tmp'}/win-remotes`, stateFile: `${process.env.RUNNER_TEMP ?? '/tmp'}/win-remotes.json`, controlDir: `${process.env.RUNNER_TEMP ?? '/tmp'}/win-mux`, connectTimeoutMs: 20000 })
const profile = registry.add({ label: 'windows-server', host, port: Number(port), user, ...(identityFile === '' ? {} : { identityFile }) })
const result = await registry.test(profile.id)

check('connecting to a Windows SSH server is refused', result.ok === false, JSON.stringify(result).slice(0, 240))
check('the refusal names the POSIX requirement', typeof result.error === 'string' && result.error.includes('POSIX'), result.error)
check('the refusal is actionable', typeof result.error === 'string' && /WSL|POSIX machine/.test(result.error), result.error)

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
