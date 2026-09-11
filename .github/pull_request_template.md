# Contributing

<!-- Keep this short. The full guide is CONTRIBUTING.md. -->

## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Which suite proves it

- [ ] `npm run check`
- [ ] `npm run test:template`
- [ ] `npm run test:unit`
- [ ] `node test/install.test.mjs`
- [ ] `node test/windows-client.test.mjs`
- [ ] `npm run test:e2e` — server userland: <!-- Alpine / Debian / macOS / other -->
- [ ] `npm run test:harness`

## Checklist

- [ ] Every value reaching a remote shell goes through `shellQuote`
- [ ] A local path still takes the local branch (the passthrough cases pass)
- [ ] Failures carry the seam's own error code, not a bare `Error`
- [ ] Remote mutations invalidate the realpath cache and take the per-target lock
- [ ] Anything opened (connection, slot, settings namespace) is reversible
- [ ] Documentation updated where behaviour changed

## Notes for the reviewer

<!-- Trade-offs, what you deliberately did not do, anything surprising. -->
