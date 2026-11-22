# Contributing

## Dev loop

```
npm ci
npm run check    # type check, lint, offline tests
npm run build
```

`npm run test:live` uses real logins and spends real quota. It runs only when the guard in `test/live/guard.ts` is satisfied and is never run in CI.

## Design record

`docs/spec.md` is the design record; comments in `src/` cite its § numbers. A behaviour change updates it in the same PR. `docs/probes/` holds the probe scripts behind the research-log entries in the spec and `docs/research/`.

## AI-assisted contributions

Welcome. The author is responsible for every line and must have run `npm run check`.

## Releasing

One-time setup, by the owner:

1. Create the GitHub repository `kevin1chun/schmear` (it must match `repository` in `package.json` for npm provenance), then enable private vulnerability reporting (Settings, Security), which SECURITY.md relies on.
2. Create a `release` environment with a required reviewer; `.github/workflows/release.yml` publishes from it.
3. On npmjs.com, add this repository's `release.yml` as the trusted publisher for `schmear`. Trusted publishing may refuse the first publish of a new package name; then publish that version by hand with 2FA (`npm publish`) and add the trusted publisher afterwards.
4. Protect `main` and add a tag ruleset that limits who can push `v*` tags.

Each release: bump `version` in `package.json`, move the CHANGELOG's Unreleased entries under `## [X.Y.Z] - YYYY-MM-DD`, commit, and push the tag `vX.Y.Z`. The workflow fails unless the tag equals the package version.

## License

Contributions are licensed under MIT, the project's license. There is no CLA.
