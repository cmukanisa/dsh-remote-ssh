#!/bin/sh
# One-line install for the dsh-remote-ssh plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/cmukanisa/dsh-remote-ssh/main/install.sh | sh
#
# It only fetches the release tarball and hands over to install.mjs; every
# durable change (packages, composition rows, activation setting) is made there,
# idempotently, so this script is a downloader and nothing else.
#
# Flags are forwarded: --enable, --link, --dry-run, --no-color, --uninstall,
# --dsh-home DIR.
set -eu

REPO="${DSH_REMOTE_SSH_REPO:-cmukanisa/dsh-remote-ssh}"
REF="${DSH_REMOTE_SSH_REF:-main}"
AUTHOR='Christian Kasse (cmukanisa)'

# Colour only when stdout is a terminal and nothing asked for plain output; the
# same contract install.mjs follows, so `| sh` and `| sh | tee log` look alike.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); O=$(printf '\033[38;5;209m'); R=$(printf '\033[0m')
else
  B=''; D=''; O=''; R=''
fi

say() { printf '%s\n' "$1"; }
note() { printf '  %s\n' "$1"; }

fail() {
  printf '\n  %s\n\n' "${B}dsh-remote-ssh:${R} $1" >&2
  exit 1
}

# One compact line, not a second banner: install.mjs renders the header box, and
# two of them in a row read as two installs.
printf '\n  %s\n\n' "${O}◆${R} ${B}dsh-remote-ssh${R} ${D}by ${AUTHOR}${R}"

command -v node >/dev/null 2>&1 || fail "node is required but was not found on PATH"
command -v tar  >/dev/null 2>&1 || fail "tar is required but was not found on PATH"

# Running from a checkout: use it directly so contributors can test their edits.
if [ -f "./install.mjs" ] && [ -f "./patch/remote-ssh.patch.yml.tpl" ]; then
  note "${D}source${R}  ./install.mjs ${D}(local checkout)${R}"
  printf '\n'
  exec node ./install.mjs "$@"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required to download the plugin"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t dsh-remote-ssh)"
trap 'rm -rf "$TMP"' EXIT INT TERM

URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}"
note "${D}source${R}  ${O}${REF}${R} ${D}from${R} ${REPO}"
printf '\n'
curl -fsSL "$URL" -o "$TMP/plugin.tar.gz" || fail "download failed; check the repository name and your network"

mkdir -p "$TMP/src"
tar -xzf "$TMP/plugin.tar.gz" -C "$TMP/src" --strip-components=1 || fail "the downloaded archive could not be extracted"
[ -f "$TMP/src/install.mjs" ] || fail "the archive does not look like the dsh-remote-ssh repository"

cd "$TMP/src"
exec node ./install.mjs "$@"
