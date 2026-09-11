/**
 * Tailscale adapter: tailnet discovery and the transport decision.
 *
 * Two distinct things are called "connecting over Tailscale", and conflating them
 * would be a security mistake:
 *
 *  - **OpenSSH over the tailnet.** The destination is a MagicDNS name or a
 *    `100.64.0.0/10` address. Nothing changes in the transport: the real `ssh`
 *    binary connects over WireGuard, and your `known_hosts` and SSH keys are the
 *    authority exactly as before. This already works and stays the default.
 *
 *  - **`tailscale ssh`, opt-in per profile.** The Tailscale client wraps the
 *    system `ssh`, resolves MagicDNS even with `--accept-dns=false`, reaches the
 *    node through `tailscaled` (so it works in userspace-networking mode), and
 *    additionally verifies the destination's host key against the one the
 *    coordination server advertises for that node. Access is then governed by
 *    tailnet ACLs and identity rather than by SSH keys on disk.
 *
 * The adapter never decides which of the two to use on its own: the profile says
 * so, and {@link isTailnetAddress} only *reports* that a destination is inside the
 * tailnet, it does not silently switch transports.
 *
 * @module dsh-remote-ssh/tailscale
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The two transports a profile may name. */
export const TRANSPORTS = ['openssh', 'tailscale']

/** The Tailscale CLI binary, overridable for tests and unusual installs. */
export function tailscaleBin() {
  return process.env.DSH_TAILSCALE_BIN ?? 'tailscale'
}

/** Tailscale's CGNAT range, the addresses a tailnet hands out. */
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/
/** Tailscale's IPv6 prefix. */
const TAILNET_V6 = /^fd7a:115c:a1e0:/i

/**
 * Whether one address belongs to a tailnet.
 *
 * This is a REPORT, never a routing decision: it feeds the status badge and the
 * preflight hint. A profile's transport is whatever the profile says.
 * @param value - a host, IP, or MagicDNS name.
 * @returns true when the value is a tailnet address or a `*.ts.net` name.
 */
export function isTailnetAddress(value) {
  if (typeof value !== 'string' || value === '') return false
  const host = value.replace(/^\[|\]$/g, '')
  if (TAILNET_V4.test(host) || TAILNET_V6.test(host)) return true
  return /\.ts\.net$/i.test(host)
}

/**
 * Read the local tailnet's state.
 *
 * Never throws: a missing CLI, a stopped daemon, or malformed output are all
 * ordinary states for a machine that simply does not use Tailscale, and the
 * caller renders them as "unavailable" rather than as an error.
 * @param options - an explicit binary and timeout, for tests and unusual installs.
 * @returns the parsed tailnet, or an unavailable result carrying the reason.
 */
export async function tailnetStatus(options = {}) {
  const bin = options.bin ?? tailscaleBin()
  try {
    const { stdout } = await run(bin, ['status', '--json'], { timeout: options.timeoutMs ?? 10000, maxBuffer: 8 * 1024 * 1024 })
    return { available: true, ...parseTailnetStatus(stdout) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, reason: 'not-installed', error: 'the `tailscale` command was not found on PATH' }
    return { available: false, reason: 'unavailable', error: `\`${bin} status --json\` failed: ${error?.stderr?.trim() || error?.message || String(error)}` }
  }
}

/**
 * Parse `tailscale status --json` into the shape the picker renders.
 *
 * Only stable, documented fields are read; a peer missing one is skipped rather
 * than guessed at. `sshHostKeys` presence is how the daemon reports that the peer
 * runs the Tailscale SSH server, which is what makes the `tailscale` transport
 * usable against it.
 * @param text - the raw JSON document.
 * @returns the tailnet name, this node, and its peers.
 */
export function parseTailnetStatus(text) {
  const document = JSON.parse(text)
  const self = document.Self ?? {}
  const peers = []
  for (const [id, peer] of Object.entries(document.Peer ?? {})) {
    const dnsName = String(peer.DNSName ?? '').replace(/\.$/, '')
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []
    if (dnsName === '' && addresses.length === 0) continue
    peers.push({
      id,
      hostName: peer.HostName ?? dnsName,
      dnsName,
      address: addresses[0] ?? '',
      os: peer.OS ?? 'unknown',
      online: peer.Online === true,
      // A peer advertising SSH host keys runs the Tailscale SSH server.
      tailscaleSsh: peer.sshHostKeys !== undefined && peer.sshHostKeys !== null,
      tags: Array.isArray(peer.Tags) ? peer.Tags : [],
      user: (peer.UserID !== undefined && document.User?.[peer.UserID]?.LoginName) || undefined,
    })
  }
  peers.sort((left, right) => (left.online === right.online ? left.hostName.localeCompare(right.hostName) : left.online ? -1 : 1))
  return {
    backendState: document.BackendState ?? 'unknown',
    tailnetName: document.CurrentTailnet?.Name ?? undefined,
    self: {
      hostName: self.HostName ?? '',
      dnsName: String(self.DNSName ?? '').replace(/\.$/, ''),
      address: (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs[0] : '') ?? '',
    },
    peers,
  }
}

/**
 * Find the peer a candidate destination refers to.
 * @param tailnet - a parsed tailnet, or undefined.
 * @param host - the host a profile would connect to.
 * @returns the matching peer, comparing MagicDNS name, short host name, and address.
 */
export function peerFor(tailnet, host) {
  if (tailnet?.peers === undefined || typeof host !== 'string' || host === '') return undefined
  const wanted = host.toLowerCase()
  return tailnet.peers.find((peer) => peer.dnsName.toLowerCase() === wanted || peer.hostName.toLowerCase() === wanted || peer.address === host)
}

/**
 * The refusal a profile earns when its tailnet peer cannot be reached.
 *
 * A tailnet peer that is offline fails as a connect timeout, which reads as a
 * broken server. Naming the real cause turns a 20-second wait into an answer.
 * @param host - the unreachable destination.
 * @param peer - the peer record that matched, when one did.
 * @returns the message, or undefined when there is nothing useful to say.
 */
export function tailnetPreflight(host, peer) {
  if (peer === undefined) return undefined
  if (peer.online) return undefined
  return `${host} is a tailnet peer (${peer.hostName}) that Tailscale reports as OFFLINE. Bring the machine up, or connect by another address — this is not an SSH or credential problem.`
}
