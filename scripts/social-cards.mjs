#!/usr/bin/env node
// Renders the four social cards that accompany the launch posts.
//
// The cards are plain HTML screenshotted by a headless Chrome, so the wording
// and the palette live in this file instead of in a binary. Re-run it after any
// change to the product description; the PNGs are the only committed artefact.
//
// Usage:
//   node scripts/social-cards.mjs [--out docs/assets/social] [--scale 2] [--theme light|dark]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function waitForExit(child, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) sleep(50);
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = 'github.com/cmukanisa/dsh-remote-ssh';
const INSTALLER = 'https://raw.githubusercontent.com/cmukanisa/dsh-remote-ssh/main/install.sh';
const WIDTH = 1600;
const HEIGHT = 900;
/** GitHub's social preview slot, and the size every link card expects. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 640;

const THEMES = ['light', 'dark'];
/** Set by main() before any card is rendered; document_ reads it through. */
let THEME = 'light';

function parseArguments(argv) {
  const options = { out: path.join(ROOT, 'docs', 'assets', 'social'), scale: 2, theme: 'light' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--out') options.out = path.resolve(argv[(index += 1)]);
    else if (flag === '--scale') options.scale = Number(argv[(index += 1)]);
    else if (flag === '--theme') options.theme = argv[(index += 1)];
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write('usage: node scripts/social-cards.mjs [--out <dir>] [--scale <n>] [--theme light|dark]\n');
      process.exit(0);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!THEMES.includes(options.theme)) throw new Error(`--theme must be one of ${THEMES.join(', ')}`);
  if (!Number.isFinite(options.scale) || options.scale < 1) {
    throw new Error('--scale must be a number greater than or equal to 1');
  }
  return options;
}

// Chrome is the renderer. Anything else would add a dependency this project does
// not want, so the script fails loudly with the list it looked at.
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`no Chrome found; set CHROME_PATH. Looked at:\n  ${candidates.join('\n  ')}`);
}

const CSS = `
  /* Light is the default: white page, near-black text, and an accent dark
   * enough to stay readable on white. The dark palette is still available with
   * --theme dark, so the same cards can follow the documentation site. */
  :root {
    --bg: #ffffff;
    --panel: #f7f6f4;
    --panel-2: #fbfaf9;
    --border: #e4e1db;
    --border-strong: #d6d2ca;
    --text: #14131a;
    --muted: #4d4a54;
    --faint: #7d7a86;
    --accent: #b5573a;
    --accent-ink: #ffffff;
    --accent-soft: #f8ece7;
    --accent-border: #eed6cb;
    --ok: #1f7a4d;
    --ok-soft: rgba(31, 122, 77, 0.10);
    --ok-border: rgba(31, 122, 77, 0.28);
    --term-bg: #fbfaf9;
    --note-bg: rgba(20, 19, 26, 0.025);
    --chrome-dot: #d9d6d0;
    --shadow: 0 18px 44px rgba(20, 19, 26, 0.10);
    --glow-1: rgba(217, 119, 87, 0.16);
    --glow-2: rgba(76, 195, 138, 0.10);
    --grid-line: rgba(20, 19, 26, 0.045);
  }

  body.dark {
    --bg: #16151a;
    --panel: #1e1d24;
    --panel-2: #232229;
    --border: #302f39;
    --border-strong: #3a3944;
    --text: #e9e7ee;
    --muted: #a5a1b0;
    --faint: #75717f;
    --accent: #d97757;
    --accent-ink: #1a1116;
    --accent-soft: #3a2a24;
    --accent-border: #54382e;
    --ok: #4cc38a;
    --ok-soft: rgba(76, 195, 138, 0.10);
    --ok-border: rgba(76, 195, 138, 0.32);
    --term-bg: #131217;
    --note-bg: rgba(30, 29, 36, 0.6);
    --chrome-dot: #3c3a45;
    --shadow: 0 30px 70px rgba(0, 0, 0, 0.45);
    --glow-1: rgba(217, 119, 87, 0.30);
    --glow-2: rgba(76, 195, 138, 0.12);
    --grid-line: rgba(255, 255, 255, 0.035);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body { width: 100%; height: 100%; }

  body {
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    position: relative;
  }

  .glow {
    position: absolute;
    inset: -30% -10% auto -10%;
    height: 900px;
    background: radial-gradient(60% 60% at 22% 8%, var(--glow-1), transparent 70%),
                radial-gradient(50% 50% at 92% 6%, var(--glow-2), transparent 70%);
    pointer-events: none;
  }

  .grid {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(var(--grid-line) 1px, transparent 1px),
                      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
    background-size: 64px 64px;
    mask-image: radial-gradient(80% 70% at 30% 20%, #000 20%, transparent 100%);
    pointer-events: none;
  }

  .card {
    position: relative;
    height: 100%;
    padding: 72px 88px 64px;
    display: flex;
    flex-direction: column;
  }

  .topbar { display: flex; align-items: center; gap: 16px; }

  .mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(150deg, var(--accent), #93402a);
    display: grid; place-items: center;
    font: 700 19px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--accent-ink);
  }

  .brand { font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -0.01em; }
  .brand span { color: var(--accent); }

  .tag {
    margin-left: auto;
    font: 500 14px/1 ui-sans-serif, system-ui, sans-serif;
    color: var(--muted);
    border: 1px solid var(--border);
    background: var(--panel-2);
    border-radius: 999px;
    padding: 9px 16px;
  }

  h1 {
    font-size: 66px;
    line-height: 1.06;
    letter-spacing: -0.028em;
    font-weight: 700;
    margin-top: 56px;
    max-width: 21ch;
  }

  h1 em { font-style: normal; color: var(--accent); }

  .lede {
    margin-top: 26px;
    font-size: 25px;
    line-height: 1.45;
    color: var(--muted);
    max-width: 46ch;
    letter-spacing: -0.005em;
  }

  .spacer { flex: 1; }

  /* Keeps the main block optically centred between the top bar and the footer
   * instead of leaving one large hole at the bottom of the card. */
  .center { flex: 1; display: flex; flex-direction: column; justify-content: center; }

  .note {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    background: var(--note-bg);
    border-radius: 12px;
    padding: 20px 24px;
    font: 400 19px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted);
  }
  .note b { color: var(--text); font-weight: 500; }
  .note .k { color: var(--accent); }

  .foot {
    display: flex;
    align-items: center;
    gap: 14px;
    font: 500 19px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--faint);
    border-top: 1px solid var(--border);
    padding-top: 26px;
  }
  .foot b { color: var(--text); font-weight: 600; }
  .foot .dot { color: var(--border-strong); }
  .foot .right { margin-left: auto; color: var(--muted); }

  /* ---- shared diagram pieces ---- */

  .cols { display: flex; gap: 44px; align-items: stretch; }
  .col { flex: 1; min-width: 0; }

  .node {
    border: 1px solid var(--border);
    background: var(--panel-2);
    border-radius: 16px;
    padding: 24px 26px;
  }
  .node .kind {
    font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .node .name { margin-top: 12px; font-size: 23px; font-weight: 600; }
  .node .path {
    margin-top: 12px;
    font: 400 17px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted);
    word-break: break-all;
  }
  .node .path b { color: var(--text); font-weight: 500; }

  .chips { display: flex; flex-wrap: wrap; gap: 12px; }
  .chip {
    font: 500 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text);
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 999px;
    padding: 11px 18px;
  }
  .chip.ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-border); }
  .chip.plain { color: var(--muted); background: var(--panel); border-color: var(--border); }

  .arrow {
    font: 500 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--accent);
    letter-spacing: 0.1em;
  }

  /* ---- mock UI (workspace picker) ---- */

  .ui {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--panel);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .ui-bar {
    display: flex; align-items: center; gap: 10px;
    padding: 15px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .ui-bar i { width: 11px; height: 11px; border-radius: 50%; background: var(--chrome-dot); display: block; }
  .ui-bar .title { margin-left: 8px; font-size: 15px; color: var(--muted); }
  .ui-body { padding: 22px 24px 24px; }

  .field-label {
    font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint);
    margin-bottom: 10px;
  }

  .tabs { display: flex; gap: 6px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 5px; }
  .tabs span { flex: 1; text-align: center; font-size: 15px; padding: 9px 0; border-radius: 7px; color: var(--muted); }
  .tabs .on { background: var(--accent); color: var(--accent-ink); font-weight: 600; }

  .row {
    display: flex; align-items: center; gap: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    margin-top: 10px;
    background: var(--panel-2);
  }
  .row .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); flex: none; }
  .row .who { display: block; font: 600 17px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row .where { display: block; font: 400 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--faint); margin-top: 5px; }
  .row .badge {
    margin-left: auto; font-size: 13px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px;
  }
  .row .badge.ts { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }

  /* ---- terminal ---- */

  .term {
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--term-bg);
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  .term-bar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
  .term-bar i { width: 11px; height: 11px; border-radius: 50%; background: var(--chrome-dot); display: block; }
  .term-bar .title { margin-left: 8px; font: 500 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--faint); }
  .term-body { padding: 26px 28px; font: 400 21px/1.75 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .term-body .prompt { color: var(--accent); }
  .term-body .cmd { color: var(--text); }
  .term-body .dim { color: var(--faint); }
  .term-body .ok { color: var(--ok); }

  .checklist { margin-top: 30px; display: flex; flex-direction: column; gap: 14px; }
  .check { display: flex; align-items: baseline; gap: 14px; font-size: 22px; color: var(--muted); }
  .check .tick { color: var(--ok); font-size: 20px; }
  .check b { color: var(--text); font-weight: 600; }

  /* The link-preview card is half the canvas, so the fixed sizes above are
   * dialled back once here instead of being duplicated in a second stylesheet. */
  body.tight .card { padding: 44px 56px 38px; }
  body.tight .mark { width: 32px; height: 32px; border-radius: 8px; font-size: 15px; }
  body.tight .brand { font-size: 17px; }
  body.tight .tag { font-size: 12px; padding: 7px 13px; }
  body.tight h1 { font-size: 40px; letter-spacing: -0.022em; max-width: none; }
  body.tight .lede { font-size: 18px; margin-top: 14px; max-width: 54ch; }
  body.tight .foot { font-size: 15px; padding-top: 18px; }
  body.tight .chip { font-size: 14px; padding: 9px 14px; }
  body.tight .chips { gap: 10px; }
`;

function document_(body, card) {
  const tight = card.width !== undefined && card.width < WIDTH;
  const classes = [tight ? 'tight' : '', THEME === 'dark' ? 'dark' : ''].filter(Boolean).join(' ');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>DSH Remote Workspace</title>
<style>${CSS}</style>
<body class="${classes}">
  <div class="glow"></div>
  <div class="grid"></div>
  <div class="card">${body}</div>
</body>
</html>
`;
}

const topbar = (right = 'community plugin') => `
  <div class="topbar">
    <div class="mark">&gt;_</div>
    <div class="brand">dsh<span>-remote-ssh</span></div>
    <div class="tag">${right}</div>
  </div>`;

const foot = (right = 'MIT') => `
  <div class="foot">
    <b>${REPOSITORY}</b>
    <span class="dot">·</span>
    <span>Not affiliated with DeepSeek</span>
    <span class="right">${right}</span>
  </div>`;

const CARDS = [
  {
    // Not a tweet card: this is the 2:1 image GitHub shows when the repository
    // or the documentation site is linked, so a shared link is not a bare URL.
    file: '05-link-preview',
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    html: (card = {}) => document_(`
      ${topbar()}
      <div class="center">
        <h1 style="margin-top:0">Your code doesn't have to live on the machine you're <em>sitting at</em>.</h1>
        <p class="lede">Connect to a server over SSH, pick a folder, and keep it as a workspace — files, shell and subprocesses routed remotely.</p>
        <div class="chips" style="margin-top:26px">
          <span class="chip">multi-server</span>
          <span class="chip">OpenSSH</span>
          <span class="chip">Tailscale</span>
          <span class="chip ok">MIT</span>
        </div>
      </div>
      ${foot('EN / FR / 中文 docs')}
    `, card),
  },
  {
    file: '01-hero',
    html: (card = {}) => document_(`
      ${topbar()}
      <div class="center">
        <h1>Your code doesn't have to live on the machine you're <em>sitting at</em>.</h1>
        <p class="lede">Connect over SSH, pick a folder on the server, and keep it as a workspace: files, shell and subprocesses included.</p>
      </div>
      <div class="cols" style="margin-bottom:40px">
        <div class="col node">
          <div class="kind">This machine</div>
          <div class="name">DSH harness</div>
          <div class="path">workspaces · sandbox · sessions</div>
        </div>
        <div class="col" style="flex:0 0 300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px">
          <div class="arrow" style="font-size:19px">◀──────▶</div>
          <div class="chip plain">ssh</div>
          <div class="arrow" style="font-size:15px; white-space:nowrap">files · shell · procs</div>
        </div>
        <div class="col node">
          <div class="kind">That machine</div>
          <div class="name">Your server</div>
          <div class="path"><b>/home/deploy/app</b> · full tool access</div>
        </div>
      </div>
      ${foot('MIT · EN / FR / 中文')}
    `, card),
  },
  {
    file: '02-routing',
    html: (card = {}) => document_(`
      ${topbar('how the path is routed')}
      <div class="center">
        <h1 style="font-size:52px; margin-top:0">One workspace, <em>two</em> machines.</h1>
        <div class="cols" style="margin-top:52px">
          <div class="col node">
            <div class="kind">Mirrored locally</div>
            <div class="path" style="margin-top:14px">$DSH_HOME/remotes/web/<br><b>home/deploy/app</b></div>
          </div>
          <div class="col" style="flex:0 0 170px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px">
            <div class="arrow" style="font-size:21px">◀──▶</div>
            <div class="chip plain" style="font-size:14px">router</div>
          </div>
          <div class="col node">
            <div class="kind">Real location</div>
            <div class="path" style="margin-top:14px">ssh://deploy@prod-web-01<br><b>/home/deploy/app</b></div>
          </div>
        </div>
        <div class="chips" style="margin-top:34px">
          <span class="chip">ctx.fs</span>
          <span class="chip">ctx.shell</span>
          <span class="chip">ctx.subprocess</span>
          <span class="chip ok">every read, write and command goes over SSH</span>
        </div>
        <div class="note" style="margin-top:34px">
          <div><span class="k">read</span> · <b>one ssh invocation</b>, streamed back</div>
          <div><span class="k">write</span> · <b>mkdir + atomic rename</b> on the server</div>
          <div><span class="k">run</span> · <b>ssh -T</b>, multiplexed, no daemon</div>
        </div>
      </div>
      ${foot('workspace registry · sandbox · cwd unchanged')}
    `, card),
  },
  {
    file: '03-servers',
    html: (card = {}) => document_(`
      ${topbar('several servers at once')}
      <div class="center">
        <div class="cols" style="align-items:center; gap:56px">
          <div class="col" style="flex:0 0 600px">
            <h1 style="font-size:50px; margin-top:0">Add workspace → <em>Remote</em></h1>
            <p class="lede" style="font-size:22px; margin-top:22px; max-width:30ch">Pick a server, browse its folders, adopt one. No config file to hand-edit.</p>
            <div class="chips" style="margin-top:30px">
              <span class="chip ok">OpenSSH</span>
              <span class="chip">Tailscale</span>
              <span class="chip plain">multi-server</span>
            </div>
          </div>
          <div class="col">
            <div class="ui">
              <div class="ui-bar"><i></i><i></i><i></i><span class="title">Add a workspace</span></div>
              <div class="ui-body">
                <div class="field-label">Location</div>
                <div class="tabs"><span>Local</span><span class="on">Remote</span></div>
                <div class="row">
                  <span class="dot"></span>
                  <span><span class="who">prod-web-01</span><span class="where">deploy@10.0.4.11 · /home/deploy/app</span></span>
                  <span class="badge">OpenSSH</span>
                </div>
                <div class="row">
                  <span class="dot"></span>
                  <span><span class="who">gpu-box</span><span class="where">ubuntu@gpu.lab · /srv/train/run-42</span></span>
                  <span class="badge ts">Tailscale</span>
                </div>
                <div class="row">
                  <span class="dot"></span>
                  <span><span class="who">staging</span><span class="where">root@staging.ts.net · /var/www</span></span>
                  <span class="badge ts">Tailscale</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${foot('active work survives closing the harness')}
    `, card),
  },
  {
    file: '04-install',
    html: (card = {}) => document_(`
      ${topbar('one-line installer')}
      <div class="center">
        <h1 style="font-size:54px; margin-top:0">Install in <em>one line</em>.</h1>
        <div class="cols" style="margin-top:48px; gap:52px; align-items:stretch">
          <div class="col" style="flex:0 0 860px">
            <div class="term">
              <div class="term-bar"><i></i><i></i><i></i><span class="title">sh</span></div>
              <div class="term-body">
                <div><span class="prompt">$</span> <span class="cmd">curl -fsSL ${INSTALLER}</span></div>
                <div><span class="prompt">&nbsp;</span> <span class="cmd">| sh</span></div>
                <div class="dim">&nbsp;</div>
                <div><span class="ok">✓</span> <span class="dim">checking requirements</span></div>
                <div><span class="ok">✓</span> <span class="dim">installing plugin rows</span></div>
                <div><span class="ok">✓</span> <span class="dim">verifying paths, imports, template</span></div>
                <div><span class="ok">✓</span> <span class="dim">activated — reload to load it</span></div>
              </div>
            </div>
          </div>
          <div class="col">
            <div class="checklist" style="margin-top:0">
              <div class="check"><span class="tick">✓</span><span><b>Checks</b> every requirement</span></div>
              <div class="check"><span class="tick">✓</span><span><b>Verifies</b> the install</span></div>
              <div class="check"><span class="tick">✓</span><span><b>Rolls back</b> if anything fails</span></div>
              <div class="check"><span class="tick">✓</span><span>Activates it right away</span></div>
              <div class="check"><span class="tick">✓</span><span>Docs in EN / FR / 中文</span></div>
            </div>
          </div>
        </div>
      </div>
      ${foot('macOS · Linux · Windows client &amp; server')}
    `, card),
  },
];

// Chrome writes the PNG and then keeps its process alive (background services),
// so the script polls for a complete file and terminates the browser itself
// instead of waiting for an exit that never comes.
function render(card, chrome, options, staging) {
  const htmlPath = path.join(staging, `${card.file}.html`);
  const pngPath = path.join(options.out, `${card.file}.png`);
  writeFileSync(htmlPath, card.html(card));
  // A leftover file from an earlier run would look "already rendered"; remove it
  // so the poll below can only succeed on the screenshot this run produces.
  rmSync(pngPath, { force: true });

  const width = card.width ?? WIDTH;
  const height = card.height ?? HEIGHT;
  const scale = card.scale ?? options.scale;

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--virtual-time-budget=3000',
      `--user-data-dir=${path.join(staging, `chrome-${card.file}`)}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      new URL(`file://${htmlPath}`).href,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const deadline = Date.now() + 60_000;
  let written = 0;
  let stable = 0;
  while (Date.now() < deadline) {
    if (existsSync(pngPath)) {
      const size = statSync(pngPath).size;
      if (size > 0 && size === written) stable += 1;
      else stable = 0;
      written = size;
      if (stable >= 3) break;
    }
    sleep(200);
  }

  child.kill('SIGKILL');
  waitForExit(child, 5_000);

  if (!existsSync(pngPath) || statSync(pngPath).size === 0) {
    throw new Error(`failed to render ${card.file}: no screenshot was written`);
  }
  return pngPath;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const chrome = findChrome();
  THEME = options.theme;
  mkdirSync(options.out, { recursive: true });
  const staging = path.join(tmpdir(), `dsh-social-${process.pid}`);
  mkdirSync(staging, { recursive: true });

  for (const card of CARDS) {
    const png = render(card, chrome, options, staging);
    const width = card.width ?? WIDTH;
    const height = card.height ?? HEIGHT;
    const scale = card.scale ?? options.scale;
    process.stdout.write(`rendered ${path.relative(ROOT, png)} (${width * scale}×${height * scale})\n`);
  }
  process.stdout.write(`\n${CARDS.length} cards in ${path.relative(ROOT, options.out)}\n`);
}

main();
