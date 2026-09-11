/**
 * SSH workspace support for the DeepSeek Harness (`dsh`).
 *
 * Once a host is connected, one of its directories becomes an ordinary
 * workspace: the agent reads, writes, edits, lists, searches, and runs shell
 * commands against the far side with every tool it already has, while the
 * harness keeps addressing the folder by a stable local path.
 *
 * - **Host capability** — `lib/ssh.js` (transport), `lib/registry.js` (durable
 *   profiles + local mirrors), `lib/fs.js` (`ctx.fs`), `lib/shell.js`
 *   (`ctx.shell`), `lib/subprocess.js` (`ctx.subprocess`).
 * - **Browser surface + Remote namespace** — `dsh-remote-ssh-ui` provides the
 *   workspace chooser, the sidebar launcher, and the Settings card.
 *
 * @module @deepseek-ai/dsh-remote-ssh
 */
export { SshTransport, SshTransportError, shellQuote, quoteArgv, sharedControlDirectory } from './ssh.js'
export { RemoteRegistry, RemoteProfileError, SETTINGS_NAMESPACE } from './registry.js'
export { RemoteFileSystem, applyLiteralEdit, atomicWriteScript, isUnder } from './fs.js'
export { RemoteShellExecutor } from './shell.js'
export { RemoteSubprocessRuntime } from './subprocess.js'
