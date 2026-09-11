/**
 * Tailscale suite.
 *
 * Everything here runs without a tailnet: the peer parser is fed a synthetic
 * transcript, the transport is inspected as argv, and the CLI-missing path is
 * exercised by naming a binary that does not exist. That is deliberate — a test
 * suite must not need the contributor's own tailnet, and it must never carry one
 * either: the fixture below is invented, and the assertions would fail if it were
 * replaced with real node names or addresses.
 *
 * The one thing this cannot cover is a live tailnet, which the README documents
 * as a manual check.
 *
 * Usage: node test/tailscale.test.mjs
 */
import { readFileSync } from 'node:fs'
import { SshTransport } from '../packages/dsh-remote-ssh/lib/ssh.js'
import { TRANSPORTS, isTailnetAddress, parseTailnetStatus, peerFor, tailnetPreflight, tailnetStatus } from '../packages/dsh-remote-ssh/lib/tailscale.js'

const report = []
let failures = 0
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── a synthetic tailnet, invented here and nowhere else ──────────────────────
const FIXTURE = {
  BackendState: 'Running',
  CurrentTailnet: { Name: 'example.invalid' },
  Self: { HostName: 'workstation', DNSName: 'workstation.example-tailnet.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'] },
  User: { '1': { LoginName: 'operator@example.invalid' } },
  Peer: {
    'nodekey:offline-laptop': { HostName: 'laptop', DNSName: 'laptop.example-tailnet.ts.net.', TailscaleIPs: ['100.64.0.11'], OS: 'macOS', Online: false },
    'nodekey:build': { HostName: 'build-a', DNSName: 'build-a.example-tailnet.ts.net.', TailscaleIPs: ['100.64.0.10'], OS: 'linux', Online: true, UserID: '1', sshHostKeys: { publicKey: 'ssh-ed25519 AAAA' } },
    'nodekey:tagged': { HostName: 'runner', DNSName: '', TailscaleIPs: ['100.64.0.12'], OS: 'linux', Online: true, Tags: ['tag:ci'] },
    'nodekey:empty': { HostName: '', DNSName: '', TailscaleIPs: [] },
  },
}

const tailnet = parseTailnetStatus(JSON.stringify(FIXTURE))
check('the backend state is read', tailnet.backendState === 'Running', tailnet.backendState)
check('the tailnet name is read', tailnet.tailnetName === 'example.invalid', tailnet.tailnetName)
check('this node is reported', tailnet.self.hostName === 'workstation' && tailnet.self.address === '100.64.0.1', JSON.stringify(tailnet.self))
check('a peer with neither name nor address is dropped', tailnet.peers.length === 3, String(tailnet.peers.length))
check('the MagicDNS trailing dot is stripped', tailnet.peers[0].dnsName.endsWith('.ts.net'), tailnet.peers[0].dnsName)
check('online peers sort first', tailnet.peers[0].online && tailnet.peers[tailnet.peers.length - 1].online === false, tailnet.peers.map((peer) => `${peer.hostName}:${peer.online}`).join(','))
check('the Tailscale SSH server is detected from advertised host keys', tailnet.peers.find((peer) => peer.hostName === 'build-a').tailscaleSsh === true)
check('a peer without host keys is not reported as running Tailscale SSH', tailnet.peers.find((peer) => peer.hostName === 'laptop').tailscaleSsh === false)
check('a tagged peer keeps its tags', tailnet.peers.find((peer) => peer.hostName === 'runner').tags[0] === 'tag:ci')
check('the peer owner is resolved through the user table', tailnet.peers.find((peer) => peer.hostName === 'build-a').user === 'operator@example.invalid')

// ── address classification ───────────────────────────────────────────────────
check('a MagicDNS name is a tailnet address', isTailnetAddress('build-a.example-tailnet.ts.net'))
check('a CGNAT address is a tailnet address', isTailnetAddress('100.64.0.10') && isTailnetAddress('100.127.255.254'))
check('the CGNAT range boundaries are respected', !isTailnetAddress('100.63.255.255') && !isTailnetAddress('100.128.0.1'))
check('a Tailscale IPv6 address is recognised', isTailnetAddress('fd7a:115c:a1e0::1234'))
check('an ordinary address is not a tailnet address', !isTailnetAddress('10.0.0.1') && !isTailnetAddress('example.com'))
check('an empty value is not a tailnet address', !isTailnetAddress(''))

// ── peer lookup and preflight ────────────────────────────────────────────────
check('a peer is found by MagicDNS name', peerFor(tailnet, 'build-a.example-tailnet.ts.net')?.hostName === 'build-a')
check('a peer is found by short host name', peerFor(tailnet, 'build-a')?.hostName === 'build-a')
check('a peer is found by address', peerFor(tailnet, '100.64.0.11')?.hostName === 'laptop')
check('an unknown host matches no peer', peerFor(tailnet, 'unknown.example.com') === undefined)
check('an offline peer is reported before the connect timeout', /OFFLINE/.test(tailnetPreflight('laptop.example-tailnet.ts.net', peerFor(tailnet, 'laptop')) ?? ''))
check('an online peer yields no obstacle', tailnetPreflight('build-a.example-tailnet.ts.net', peerFor(tailnet, 'build-a')) === undefined)
check('an unknown peer yields no obstacle', tailnetPreflight('elsewhere.example.com', undefined) === undefined)

// ── the two transports ───────────────────────────────────────────────────────
check('the two transport names are exactly what the schema accepts', TRANSPORTS.join(',') === 'openssh,tailscale', TRANSPORTS.join(','))
const base = { id: 'p', label: 'p', host: 'build-a.example-tailnet.ts.net', port: 22, user: 'deploy', identityFile: '', password: '', strictHostKeyChecking: 'accept-new', remoteRoot: '', extraOptions: [] }

const plain = new SshTransport(base, { controlDir: '/tmp/dsh-ts-plain' })
const plainArgv = plain.commandArgv('echo hi')
check('the default transport is OpenSSH', plain.transport === 'openssh' && plainArgv[0] === 'ssh', plainArgv.slice(0, 2).join(' '))
check('OpenSSH on a MagicDNS name is unchanged', plain.transport === 'openssh' && plainArgv.includes('deploy@build-a.example-tailnet.ts.net'))
check('a tailnet-shaped host does NOT switch the transport by itself', plain.transport === 'openssh')

const viaTailscale = new SshTransport({ ...base, transport: 'tailscale' }, { controlDir: '/tmp/dsh-ts-client' })
const tsArgv = viaTailscale.commandArgv('echo hi')
check('the Tailscale transport runs the Tailscale client', tsArgv[0] === 'tailscale', tsArgv[0])
check('the Tailscale client is told to ssh, after the separator', tsArgv[1] === 'ssh' && tsArgv[2] === '--', tsArgv.slice(0, 3).join(' '))
check('ssh options follow the separator, where the wrapper forwards them', tsArgv.slice(3).some((value) => value === '-T'))
check('the destination and command stay last', tsArgv[tsArgv.length - 2] === 'deploy@build-a.example-tailnet.ts.net' && tsArgv[tsArgv.length - 1] === 'echo hi')
// Windows OpenSSH has no connection multiplexing at all, so the transport omits
// it there whatever the transport mode is; everywhere else Tailscale mode keeps
// it, because the wrapper execs the system ssh with these options after `--`.
if (process.platform === 'win32') {
  check('a Windows client omits multiplexing in Tailscale mode too', !tsArgv.some((value) => value.startsWith('ControlPath=')), tsArgv.join(' '))
} else {
  check('multiplexing is kept in Tailscale mode', tsArgv.some((value) => value === 'ControlMaster=auto') && tsArgv.some((value) => value.startsWith('ControlPath=')))
}
check('host-key checking is never disabled by the Tailscale mode', !tsArgv.some((value) => value === 'StrictHostKeyChecking=no'))

const withPassword = new SshTransport({ ...base, transport: 'tailscale', password: 'not-a-real-secret' }, { controlDir: '/tmp/dsh-ts-pass' })
const passArgv = withPassword.commandArgv('echo hi')
check('a password wraps the Tailscale client, not the other way round', passArgv[0] === 'sshpass' && passArgv[1] === '-e' && passArgv[2] === 'tailscale', passArgv.slice(0, 3).join(' '))
check('the password travels in the environment', withPassword.childEnv().SSHPASS === 'not-a-real-secret' && !passArgv.some((value) => value.includes('not-a-real-secret')))

// ── a machine without Tailscale ──────────────────────────────────────────────
const missing = await tailnetStatus({ bin: 'definitely-not-a-real-binary-xyz' })
check('a missing Tailscale CLI is unavailable, not an error', missing.available === false && missing.reason === 'not-installed', JSON.stringify(missing).slice(0, 120))
check('an unavailable tailnet carries an actionable reason', typeof missing.error === 'string' && missing.error.includes('not found'), missing.error)

// ── the suite must stay synthetic ────────────────────────────────────────────
// A test fixture is committed to a public repository, so it must never carry a
// contributor's own tailnet. These two assertions fail the moment a real
// MagicDNS suffix or a real tailnet name replaces the invented ones.
const suite = readFileSync(new URL(import.meta.url), 'utf8')
const inventedSuffix = 'example-tailnet.ts.net'
// Tokenise rather than regex-match: a pattern loose enough to find a MagicDNS
// name anywhere in a file is also loose enough to be worth anchoring, and an
// anchored one would miss a name in the middle of a line. Splitting on the
// characters that can delimit a token needs no such trade.
const allowed = (token) => token === inventedSuffix || token.endsWith(`.${inventedSuffix}`)
// A fixture writes a MagicDNS name the way the daemon does — with a trailing root
// dot — so the dot is stripped before testing. The bare suffix in this file's own
// code is not a domain: a candidate must carry at least one host label in front.
const realSuffixes = [...new Set(suite
  .split(/[\s"'`(),;:[\]{}<>]+/)
  .map((token) => token.replace(/\.$/, ''))
  .filter((token) => token.length > '.ts.net'.length && token.endsWith('.ts.net') && !allowed(token)))]
check('no real MagicDNS suffix is committed', realSuffixes.length === 0, realSuffixes.join(','))
check('the fixture uses a documentation-only tailnet name', FIXTURE.CurrentTailnet.Name === 'example.invalid')

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
