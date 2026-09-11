#!/usr/bin/env node
/**
 * Documentation gate.
 *
 * The site is served by GitHub Pages straight from `docs/`, with no build step, so
 * nothing would otherwise catch a page that lost a language, a stylesheet that
 * moved, a link that 404s, or a page that started pulling a third-party resource.
 * A plugin that drives SSH connections should not phone out from its own
 * documentation either.
 *
 * Usage: node scripts/check-docs.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LOCALES = ['en', 'fr', 'zh']
/** Third-party origins a page must never reference. */
const OWN_HOSTS = ['github.com', 'raw.githubusercontent.com', 'codeload.github.com']

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

const read = (path) => readFileSync(`${ROOT}docs/${path}`, 'utf8')

check('docs/ is a Pages root with a .nojekyll', existsSync(`${ROOT}docs/.nojekyll`))
check('the stylesheet exists', existsSync(`${ROOT}docs/assets/style.css`))
const landing = read('index.html')
check('the landing page offers all three languages', LOCALES.every((locale) => landing.includes(`./${locale}/`)), LOCALES.join(','))
check('the landing page detects the browser language', /navigator\.languages|navigator\.language/.test(landing))

for (const locale of LOCALES) {
  const path = `${locale}/index.html`
  check(`docs/${path} exists`, existsSync(`${ROOT}docs/${path}`))
  if (!existsSync(`${ROOT}docs/${path}`)) continue
  const page = read(path)
  check(`docs/${path} declares its language`, new RegExp(`<html lang="${locale}"`).test(page))
  check(`docs/${path} loads the shared stylesheet`, page.includes('../assets/style.css'))
  // The switcher is how a reader in the wrong language gets out.
  for (const other of LOCALES) check(`docs/${path} links to ${other}`, page.includes(`../${other}/`))
  // Sections a user guide is useless without.
  for (const anchor of ['id="install"']) check(`docs/${path} keeps the install section`, page.includes(anchor))
  check(`docs/${path} explains the requirements`, /Requirements|Prérequis|环境要求/.test(page))
  check(`docs/${path} explains Tailscale`, page.includes('Tailscale'))
  check(`docs/${path}`.concat(' credits the author'), page.includes('cmukanisa'))
}

// No third-party fetch: no CDN stylesheet, font, or script.
const thirdParty = []
for (const file of ['index.html', ...LOCALES.map((locale) => `${locale}/index.html`)]) {
  const page = read(file)
  for (const match of page.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    const host = new URL(match[1]).host
    if (!OWN_HOSTS.includes(host)) thirdParty.push(`${file} -> ${match[1]}`)
  }
}
check('no page pulls a third-party resource', thirdParty.length === 0, thirdParty.join(', '))

// Every internal link target must exist, so the site has no dead ends.
const targets = new Set()
for (const file of ['index.html', ...LOCALES.map((locale) => `${locale}/index.html`)]) {
  for (const match of read(file).matchAll(/href="(\.{1,2}\/[^"#]*)"/g)) {
    const resolved = new URL(match[1], `file://${ROOT}docs/${file}`).pathname
    targets.add(resolved.endsWith('/') ? `${resolved}index.html` : resolved)
  }
}
const broken = [...targets].filter((target) => !existsSync(target))
check('every internal link resolves', broken.length === 0, broken.map((target) => target.replace(ROOT, '')).join(', '))

process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
