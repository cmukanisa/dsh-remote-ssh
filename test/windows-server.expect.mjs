/**
 * Windows-server expectations.
 *
 * The plugin drives a remote host with POSIX shell source, so a Windows OpenSSH
 * server cannot be used. That is a supported limitation, and it must FAIL
 * VISIBLY: the probe has to refuse with an actionable message rather than
 * half-work and let the agent misread the far side.
 *
 * This suite asserts the refusal deterministically, by running the plugin's own
 * probe script through a REAL non-POSIX shell — `cmd.exe` on Windows — instead of
 * depending on a Windows sshd accepting a key first. Getting a key accepted by
 * Windows sshd on a hosted runner is a fixture problem (accounts, profiles,
 * ACLs, password policy); the shell dialect is the product fact, and it is
 * reproduced exactly.
 *
 * `--real <host> <port> <user> <key>` additionally probes a live Windows sshd
 * when one is reachable; that is evidence, not the assertion.
 *
 * Usage: node test/windows-server.expect.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROBE_SCRIPT, parseProbeOutput, nonPosixHost, SshTransport } from '../packages/dsh-remote-ssh/lib/ssh.js'

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── the shell dialect a Windows server really answers with ───────────────────
if (process.platform === 'win32') {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-win-probe-'))
  const script = join(scratch, 'probe.sh')
  writeFileSync(script, PROBE_SCRIPT)
  let stdout = ''
  let failed = false
  try {
    // A Windows sshd runs a command through cmd.exe by default, so this is the
    // same interpreter the plugin would meet on the wire.
    stdout = execFileSync('cmd.exe', ['/c', `"${script}"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    failed = true
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  rmSync(scratch, { recursive: true, force: true })

  check('the Windows shell does not answer the probe', failed || !stdout.includes('uname='), stdout.trim().slice(0, 160) || '(no output)')
  const facts = parseProbeOutput(stdout)
  check('the classifier reads that answer as a non-POSIX host', facts.platform === 'unknown', JSON.stringify(facts))
  const refusal = nonPosixHost('user@windows-host')
  check('the refusal says POSIX is required', refusal.message.includes('POSIX'), refusal.message)
  check('the refusal is actionable', /WSL|POSIX machine/.test(refusal.message), refusal.message)
  check('the refusal names the destination', refusal.message.startsWith('user@windows-host'), refusal.message.slice(0, 40))
} else {
  report.push('SKIP  a Windows shell is only available on Windows')
}

// ── the classifier against transcripts, on every platform ────────────────────
const linuxFacts = parseProbeOutput(['uname=Linux', 'shell=/bin/bash', 'rg=/usr/bin/rg', 'realpath=1', 'stat=gnu', 'base64d=-d', 'home=/home/dsh', 'user=dsh'].join('\n'))
check('a POSIX transcript classifies as linux', linuxFacts.platform === 'linux' && linuxFacts.stat === 'gnu' && linuxFacts.rg === '/usr/bin/rg', JSON.stringify(linuxFacts))
const darwinFacts = parseProbeOutput(['uname=Darwin', 'shell=/bin/bash', 'realpath=1', 'stat=bsd', 'home=/Users/x'].join('\n'))
check('a BSD transcript classifies as darwin', darwinFacts.platform === 'darwin' && darwinFacts.stat === 'bsd', JSON.stringify(darwinFacts))
const windowsNoise = ["'uname' is not recognized as an internal or external command,", 'operable program or batch file.', "The term 'uname' is not recognized as the name of a cmdlet."].join('\n')
check('cmd.exe and PowerShell noise classify as unknown', parseProbeOutput(windowsNoise).platform === 'unknown', JSON.stringify(parseProbeOutput(windowsNoise)))
check('an empty answer classifies as unknown', parseProbeOutput('').platform === 'unknown')
check('an echoed script does not classify as a platform', parseProbeOutput(PROBE_SCRIPT).platform === 'unknown')

// ── optional live evidence ───────────────────────────────────────────────────
const realAt = process.argv.indexOf('--real')
if (realAt >= 0) {
  const [host, port, user, key] = process.argv.slice(realAt + 1)
  const transport = new SshTransport({ id: 'win', label: 'win', host, port: Number(port), user, identityFile: key, password: '', strictHostKeyChecking: 'accept-new', remoteRoot: '', extraOptions: [] }, {})
  try {
    await transport.probe()
    check('a live Windows sshd is refused', false, 'the probe answered as a POSIX host')
  } catch (error) {
    check('a live Windows sshd is refused with the actionable message', /POSIX/.test(error.message), error.message.slice(0, 200))
  }
}

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
