/**
 * Node half of the remote-workspace surface package.
 *
 * It exists to own the one Loader row that makes this package part of the
 * composition, which is what `dsh-client-modules` scans to discover the browser
 * half declared in `package.json`'s `dsh.client`. The row's real work is
 * publishing `ctx.sshWorkspaceController`, the Typert Remote namespace the
 * browser calls.
 *
 * The registry is a hard dependency: without a connected-host registry there is
 * nothing for this surface to drive, so the plugin waits rather than publishing
 * an endpoint whose every call would fail.
 *
 * @module dsh-remote-ssh-ui
 */
import { RemoteSshController } from './remote.js'

export { NAMESPACE, RemoteSshController, markRemote } from './remote.js'

/**
 * Cordis service injection: the endpoint is useless until the registry exists,
 * and the work panel needs the detached-work registry beside it.
 */
export const inject = ['remoteSsh', 'remoteSessions']

/**
 * Mount the Remote controller.
 * @param ctx - the host context, carrying `ctx.remoteSsh`.
 */
export function apply(ctx) {
  new RemoteSshController(ctx)
}

export default { inject, apply }
