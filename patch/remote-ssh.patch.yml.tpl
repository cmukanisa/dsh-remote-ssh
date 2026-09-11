# Remote SSH workspaces — the rows this plugin adds to a dsh profile.
#
# `dsh-remote-ssh` is a CAPABILITY-SEAM replacement, not an add-on: a remote
# workspace only behaves like a workspace if `ctx.fs`, `ctx.shell`, and
# `ctx.subprocess` are the providers that know how to reach the far side. The
# three shipped providers are therefore disabled and this plugin's routing
# subclasses take their place; each one keeps the shipped behaviour verbatim for
# every local path and adds an SSH world for a mirrored remote one.
#
# The plugin directory placeholder below is substituted by install.mjs with the
# absolute directory the packages were installed into. Absolute paths are used
# because a row's relative specifier resolves against the profile directory, and
# this layer is shared by every profile.
#
# Every row is idempotent: re-running the installer replaces this block instead
# of appending a second copy.

- id: fs-sandbox
  disabled: true

- id: bash-sandbox
  disabled: true

- id: subprocess
  disabled: true

- insert:
    - id: remote-ssh
      name: @@PLUGINS_DIR@@/dsh-remote-ssh/lib/registry.js
      config:
        root: !!js dshHomePath('remotes')
        stateFile: !!js dshHomePath('remotes.json')
        controlDir: !!js dshHomePath('ssh-mux')
        connectTimeoutMs: 20000

    - id: fs-remote-ssh
      name: @@PLUGINS_DIR@@/dsh-remote-ssh/lib/fs.js

    - id: shell-remote-ssh
      name: @@PLUGINS_DIR@@/dsh-remote-ssh/lib/shell.js
      disabled: !!js process.platform === 'win32'

    - id: subprocess-remote-ssh
      name: @@PLUGINS_DIR@@/dsh-remote-ssh/lib/subprocess.js

    # Detached remote work: commands that keep running on the host after the
    # harness closes, with a durable record so a later session re-attaches.
    - id: remote-ssh-sessions
      name: @@PLUGINS_DIR@@/dsh-remote-ssh/lib/sessions.js
      config:
        path: !!js dshHomePath('remotes-sessions.json')

    # One row owns the browser half: `dsh-client-modules` resolves the nearest
    # package.json for this row and serves the `./client` bundle it declares.
    - id: remote-ssh-ui
      name: @@PLUGINS_DIR@@/dsh-remote-ssh-ui/lib/index.js
