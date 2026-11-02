# tooling/boundaries

Package boundaries for the whole repo, generated from one manifest. Private; never published.

## Files

- `packages.json`: **the manifest**, and the only file to edit by hand. One node per package or subpath entry: `dir`, `layer`, `runsIn`, `deps`, `slices`, `neutral`, `compositionRoot`. Its `$comment` explains the fields.
- `generated/` and the root `.dependency-cruiser.json`: written by `pnpm boundaries:write`. Never edit them; `pnpm boundaries` fails when they drift from the manifest. Biome skips them (`biome.json` → `files.includes`), and `.gitattributes` marks them `linguist-generated`, so GitHub collapses them in PR diffs.
- `grit/neutral-no-dialect-name.grit`: hand-written. Which packages it covers comes from the manifest's `neutral` flags.
- `src/manifest.ts` (parse + validate), `src/workspace.ts` (workspace vs manifest and repo conventions), `src/generate.ts` (the generated files), `src/cli.ts` (`check` | `write`).

## What `pnpm boundaries` checks

Every check runs, then dependency-cruiser does, so one run reports everything.

- `manifest-*`: the manifest's own rules (layers point down, worker and coordinator never meet, known keys only), its dirs inside the workspace roots, package names and `package.json` deps, generated files current.
- `workspace-*`: each package's `exports` lists `provino-source` first (so no import resolves to `dist/`), each package is in `tsconfig.json` (and its `test/` in `tsconfig.type-tests.json`), a `node --test` script has tests to run, no placed dir is git-ignored, and the TypeScript 6 pin in `packageExtensions` matches the catalog.
- `no-plugin-suppression`: no `biome-ignore` comment silences the boundary lints.
- The workspace roots come from `pnpm-workspace.yaml`; only `<dir>/*` globs are supported.

## Changing things

- **New package:** add its node (check `monorepo-architecture.md` first; the package map is Tyler's call), create the package, then `pnpm boundaries:write`. `pnpm boundaries` reports `manifest-unknown-package` until both exist.
- **New dependency between packages:** add it to `deps` (layers point down; worker and coordinator never meet), then add it to `package.json`. A package.json dep the manifest doesn't allow fails `manifest-deps`.
- **New policy slice:** add it to `slices` (it must match `neutralPolicy`'s keys; a test checks).
- **New rule:** generate it in `src/generate.ts` (or add a check to `src/workspace.ts`), and add a planted case to `src/planted.test.ts` or `src/workspace.test.ts` that fails without it.
- **Tests of a subpath entry** go in the package's `test/`: the `boundary-<package>-tests` rule lets them import every entry.

## Gotchas

- Biome's `--stdin-file-path` mode doesn't report plugin diagnostics, so `planted.test.ts` copies the config into a scratch dir under the OS temp dir and lints real files. Turbo passes `TMPDIR` through so sandboxes that block `/tmp` work. A scratch dir inside a folder with its own root `biome.json` fails with "nested root configuration".
- `planted.test.ts` drops `FORCE_COLOR`: it overrides `NO_COLOR` for dependency-cruiser and would colour the output it matches.
- GritQL regexes match the whole node, and need `(?:…)` groups. A capturing group counts as a variable, and Biome fails with "regex pattern matched 1 variables, but expected 0".
- dependency-cruiser rejects nested quantifiers like `(?:-[a-z]+)?` as unsafe regexes.
- dependency-cruiser 18.7 runs on the TypeScript 6 API through `packageExtensions` in `pnpm-workspace.yaml`.
- `turbo.json` here turns caching off for `test`: the planted tests read root files (`biome.json`, `generated/`, `.dependency-cruiser.json`) and the tools in `node_modules`, none of which are in this package's Turbo inputs.
