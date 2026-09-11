#!/usr/bin/env node
/**
 * Start a disposable OpenSSH server for the end-to-end suites.
 *
 * It builds `sshd.Dockerfile` with a freshly generated key pair and publishes it
 * on a free port, then prints the exact environment the suites expect. Docker is
 * required; every other suite runs without it.
 *
 * Usage: node test/docker/up.mjs [--port 2223] [--name dsh-ssh-test] [--keep-key]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : args[index + 1]
}
const port = Number(option('port', '2223'))
const name = option('name', 'dsh-ssh-test')
// A random directory, not a predictable name under the temp root: writing a file
// at a fixed path there is the insecure-temporary-file pattern (a symlink planted
// by another local user would be followed). `--state` stays overridable so a
// caller can reuse a key across runs.
const state = option('state', mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-e2e-')))
mkdirSync(state, { recursive: true })

const privateKey = join(state, 'id_test')
if (!existsSync(privateKey)) execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', privateKey, '-C', 'dsh-remote-ssh-test'], { stdio: 'inherit' })
const publicKey = readFileSync(`${privateKey}.pub`, 'utf8').trim()

/** Run one command, inheriting stdio. */
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { stdio: 'inherit', ...options })

try {
  run('docker', ['rm', '-f', name], { stdio: 'ignore' })
} catch {
  /* no container to remove */
}

run('docker', ['build', '-f', join(HERE, 'sshd.Dockerfile'), '--build-arg', `AUTHORIZED_KEY=${publicKey}`, '-t', 'dsh-remote-ssh-test', join(HERE, '..', '..')])
run('docker', ['run', '-d', '--name', name, '-p', `${port}:22`, 'dsh-remote-ssh-test'])

const knownHosts = join(state, 'known_hosts')
writeFileSync(knownHosts, '')

process.stdout.write(`
A test SSH server is starting on 127.0.0.1:${port} (container ${name}).

  export DSH_SSH_TEST_HOST=127.0.0.1
  export DSH_SSH_TEST_PORT=${port}
  export DSH_SSH_TEST_USER=dsh
  export DSH_SSH_TEST_KEY=${privateKey}
  export DSH_SSH_TEST_KNOWN_HOSTS=${knownHosts}
  export DSH_SSH_TEST_ROOT=/home/dsh/work

  npm run test:e2e

Stop it with: node test/docker/down.mjs --name ${name}
`)
