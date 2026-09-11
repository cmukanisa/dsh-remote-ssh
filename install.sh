#!/bin/sh
# One-line install for the dsh-remote-ssh plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/cmukanisa/dsh-remote-ssh/main/install.sh | sh
#
# It only fetches the release tarball and hands over to install.mjs; every
# durable change (packages, composition rows, activation setting) is made there,
# idempotently, so this script is a downloader and nothing else.
#
# Flags are forwarded: --enable, --link, --dry-run, --uninstall, --dsh-home DIR.
set -eu

REPO="${DSH_REMOTE_SSH_REPO:-cmukanisa/dsh-remote-ssh}"
REF="${DSH_REMOTE_SSH_REF:-main}"

fail() { printf 'dsh-remote-ssh: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required but was not found on PATH"
command -v tar  >/dev/null 2>&1 || fail "tar is required but was not found on PATH"

# Running from a checkout: use it directly so contributors can test their edits.
if [ -f "./install.mjs" ] && [ -f "./patch/remote-ssh.patch.yml.tpl" ]; then
  exec node ./install.mjs "$@"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required to download the plugin"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t dsh-remote-ssh)"
trap 'rm -rf "$TMP"' EXIT INT TERM

URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}"
printf 'dsh-remote-ssh: downloading %s\n' "$URL"
curl -fsSL "$URL" -o "$TMP/plugin.tar.gz" || fail "download failed; check the repository name and your network"

mkdir -p "$TMP/src"
tar -xzf "$TMP/plugin.tar.gz" -C "$TMP/src" --strip-components=1 || fail "the downloaded archive could not be extracted"
[ -f "$TMP/src/install.mjs" ] || fail "the archive does not look like the dsh-remote-ssh repository"

cd "$TMP/src"
exec node ./install.mjs "$@"
