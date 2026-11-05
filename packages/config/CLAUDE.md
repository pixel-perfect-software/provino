# @provino/config

Loads a project's config file and resolves it into everything the coordinator and its workers need (coordinator side; imports `@provino/types` and `@provino/policy` only). B11 built the first part of T1.4: `loadConfigFile`, `resolveProject`, `loadProject`. The built-in dialects and environments come from the caller (`provino`), so this package names no dialect and no environment package, and never imports one.

## Map

| Path | Role |
|---|---|
| `src/load.ts` | `loadConfigFile(path, env)`: `import()` of the file; the default export is an object, or a (maybe async) function of `ConfigEnv`. `loadProject(path, options)`: load, then resolve (`env` defaults to `{ command: 'run', mode: 'test' }`) |
| `src/resolve.ts` | `resolveProject(input, options)` → `ResolvedProject`: root, dialect, policy, globs, environment, isolation, and the `SerializedProjectConfig` |
| `src/errors.ts` | `ConfigError` with a `code` (`ConfigErrorCode`) and, for bad dialect options, `issues` |
| `src/internal/input.ts` | `parseInput`: checks each key `resolveProject` reads (`CONFIG_INVALID`) and refuses `projects`, `plugins`, `alsoServe` when non-empty (`CONFIG_UNSUPPORTED`, naming T1.4) |
| `src/internal/dialect.ts` | `selectDialect` (by name, else by `detect`), `dialectPolicy` (a factory gets `config[name]`, checked by the dialect's Standard Schema first) |
| `src/internal/test-support.ts` | Temp dirs and `rejectsWith`, for the tests |

## Rules that aren't obvious

- **The config's keys are layered into the policy,** not only read beside it: `include` and `exclude` go over `orchestrator.include`/`exclude`, and `globals` over `core.injectGlobals`. The worker reads `policy.core.injectGlobals` *and* `config.globals !== null` (both must hold), so layering keeps the two in agreement. `ResolvedProject.include`/`exclude` are read back from the resolved policy.
- **Dialect choice:** a `dialect` name picks from the dialects the caller gave (a config's own `dialects` list *replaces* theirs, as `BaseConfig.dialects` says "default: the built-ins"); no name picks the highest `detect` score above zero; a tie is `CONFIG_DIALECT_TIE`, not a guess; no match is neutral (`dialect: null`, no globals). `detect` runs only when some dialect has one, and then reads the root's file names and `package.json` once.
- **Dialect options** reach a policy *factory* only (`config[dialect.name]`, through `dialect.options` when present, even when the value is `undefined`, so a schema can supply defaults). A plain policy never sees `config[name]`. `Dialect.policy` is typed bivariantly, so the compiler can't check the factory's argument: this validation is the check.
- **Environment:** the config's name, else `policy.orchestrator.envDefault`, looked up (own keys only) in the caller's table. `EnvironmentRef.options` is `{}`: config's `environment` is a name, so there are no options to give. (B10 noted `EnvironmentRef.options` and `EnvironmentOptionsMap` don't assign without a cast; nothing here builds one from the map, so the cast never came up. T1.4's `environment()` helper will meet it.)
- **Isolation:** the config's, else `isolationDefault.byEnvironment[env]` (own keys only), else `isolationDefault.default`.
- **Setup files:** the neutral `setupFiles` become the worker's `setupFilesAfterEnv` (as Track 11 maps Vitest's), resolved against `rootDir`; the worker's `setupFiles` stays `[]`.
- **Loader conditions** come from calling the policy's `orchestrator.environmentConditions` behaviour in the coordinator, with the environment's *name* only. An `Environment` object's own `conditions` live in the worker and are not seen here.
- **Every failure is a `ConfigError`.** Policy errors (`resolvePolicy`, `serializePolicy`), a throwing dialect `detect` or factory or schema, and an unloadable behaviour are wrapped with the original as `cause`.
- **Node caches imports by URL,** so loading one path twice in a process returns the first contents. Watch mode (T9.8) must bust it.
- Tests use small fake dialects (`defineDialect`) and real config files written to `$TMPDIR` at test time (no `.js` is committed, D13). The package may not import `@provino/dialect-jest` (not in its manifest deps), so the real Jest dialect is exercised in `provino`'s tests.

## Not built yet

- `defineConfig`, validation of unknown keys, and the Oxc fallback for a `.ts` file Node can't strip (T1.4).
- `projects`, `plugins`, `alsoServe` (T1.4); `RunRequest` and CLI flags layered over a config (T11.13, B14).
- `tsconfig` / `mappers` / `typescript` options (the loader block is the bench's defaults, with `tsconfig: 'auto'`); resolver aliases (T1.4, U9).
