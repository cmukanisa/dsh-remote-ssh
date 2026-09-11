#!/usr/bin/env node
/**
 * Stop and remove the disposable OpenSSH server started by `up.mjs`.
 *
 * Usage: node test/docker/down.mjs [--name dsh-ssh-test]
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const index = args.indexOf('--name')
const name = index < 0 ? 'dsh-ssh-test' : args[index + 1]

try {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'inherit' })
  process.stdout.write(`removed container ${name}\n`)
} catch {
  process.stdout.write(`no container named ${name}\n`)
}
