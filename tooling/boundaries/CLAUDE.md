# tooling/boundaries

Package boundaries for the whole repo, generated from one manifest. Private; never published.

## Files

- `packages.json`: **the manifest**, and the only file to edit by hand. One node per package or subpath entry: `dir`, `layer`, `runsIn`, `deps`, `slices`, `neutral`, `compositionRoot`. Its `$comment` explains the fields.
- `generated/` and the root `.dependency-cruiser.json`: written by `pnpm boundaries:write`. Never edit them; `pnpm boundaries` fails when they drift from the manifest. Biome skips them (`biome.json` → `files.includes`).
- `grit/neutral-no-dialect-compare.grit`: hand-written. Which packages it covers comes from the manifest's `neutral` flags.
- `src/manifest.ts` (parse + validate), `src/workspace.ts` (workspace vs manifest), `src/generate.ts` (the generated files), `src/cli.ts` (`check` | `write`).

## Changing things

- **New package:** add its node (check `monorepo-architecture.md` first; the package map is Tyler's call), create the package, then `pnpm boundaries:write`. `pnpm boundaries` reports `manifest-unknown-package` until both exist.
- **New dependency between packages:** add it to `deps` (layers point down; worker and coordinator never meet), then add it to `package.json`. A package.json dep the manifest doesn't allow fails `manifest-deps`.
- **New policy slice:** add it to `slices` (it must match `neutralPolicy`'s keys; a test checks).
- **New rule:** generate it in `src/generate.ts`, and add a planted-violation case to `src/planted.test.ts` that fails without it.

## Gotchas

- Biome's `--stdin-file-path` mode doesn't report plugin diagnostics, so `planted.test.ts` copies the config into a scratch dir and lints real files. It needs `TMPDIR` (Turbo passes it through).
- GritQL regexes: use `(?:…)` groups. A capturing group counts as a variable, and Biome fails with "regex pattern matched 1 variables, but expected 0".
- dependency-cruiser rejects nested quantifiers like `(?:-[a-z]+)?` as unsafe regexes.
- dependency-cruiser 18.7 runs on the TypeScript 6 API through `packageExtensions` in `pnpm-workspace.yaml`.
