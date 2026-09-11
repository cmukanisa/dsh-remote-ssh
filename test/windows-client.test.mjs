/**
 * Windows-client expectations: what must hold when the harness itself runs on
 * Windows and drives a POSIX host.
 *
 * Two behaviours are Windows-specific and both are load-bearing:
 *
 *  - OpenSSH for Windows has no connection multiplexing, so the transport must
 *    omit `ControlMaster`/`ControlPath` entirely (naming a `ControlPath` there
 *    fails the connection instead of degrading);
 *  - `ControlPath` is an `AF_UNIX` path with a hard length limit, and the
 *    platform temp directory on Windows is long, so the shortening has to hold
 *    for a Windows-shaped directory too.
 *
 * Usage: node test/windows-client.test.mjs
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedControlDirectory, shellQuote, quoteArgv, SshTransport } from '../packages/dsh-remote-ssh/lib/ssh.js'

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

check('quoting is platform-independent', shellQuote("it's") === `'it'\\''s'`, shellQuote("it's"))
check('argv quoting is platform-independent', quoteArgv(['a b', 'c']) === `'a b' 'c'`, quoteArgv(['a b', 'c']))

const longWindowsShaped = join(tmpdir(), 'x'.repeat(120))
const shortened = sharedControlDirectory(longWindowsShaped)
check('a Windows-length socket directory is shortened', shortened !== longWindowsShaped, shortened)
check('the shortened ControlPath fits the AF_UNIX limit', Buffer.byteLength(join(shortened, 'a'.repeat(40)), 'utf8') <= 104, String(Buffer.byteLength(join(shortened, 'a'.repeat(40)), 'utf8')))

const transport = new SshTransport({ id: 'win', label: 'win', host: 'example.invalid', port: 22, user: 'u', identityFile: '', password: '', strictHostKeyChecking: 'accept-new', remoteRoot: '', extraOptions: [] }, { controlDir: join(tmpdir(), 'dsh-ssh-win') })
const args = transport.baseArgs()
const multiplexes = args.includes('ControlMaster=auto')
if (process.platform === 'win32') {
  check('Windows omits connection multiplexing', !multiplexes, args.join(' '))
  check('Windows still asks for batch mode', args.includes('BatchMode=yes'))
} else {
  check('POSIX opts into connection multiplexing', multiplexes, args.join(' '))
}
check('host-key policy is always explicit', args.some((value) => value.startsWith('StrictHostKeyChecking=')), args.join(' '))
check('the destination is user@host', transport.destination === 'u@example.invalid', transport.destination)

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
