# @provino/snapshot

The snapshot engine (Track 7 R4; B17b: T7.9 and T7.10). Neutral: it never names `jest` or `vitest`. A dialect gives it three things through the `snapshot` policy slice: the values (header, key and hint joins, update and obsolete rules, error body, pretty-format options), a **printer** (`SnapshotPrinter`: the dialect's pretty-format with its built-in plugins, and the words of its failed matchers; `snapshot.printer`, a `ModuleRef`), and the key function (`snapshot.key`). The matchers that use it are `@provino/expect`'s (`src/snapshot-matchers.ts`).

## Map (three entries, as the manifest has them)

| Path | Entry | Runs in | Role |
|---|---|---|---|
| `src/index.ts` and its files | `.` | both | `SnapshotError` (codes), `SnapshotUpdateMode`, the `.snap` format (`serializeSnapFile`: header, then entries in natural order; `evaluateSnapFile`: runs the file as `exports[...] = ...`; `checkSnapHeader`; `keyToTestName`), the text rules (`escapeBacktickString`, `addExtraLineBreaks`, `removeExtraLineBreaks`, `normalizeNewlines`), `defaultSnapshotPath`, and the two vendored pieces (`vendor/`, see its `UPSTREAM.md`): `naturalCompare` and `deepMerge` |
| `src/runtime/state.ts` | `./runtime` | worker | `SnapshotState`, one per test file: Jest 30.5.2's `State.ts` step for step. `match`, `matchRaw` (a file snapshot), `fail`, `clearTest`, `markCheckedForTest`, `addSerializer`, `finish`, and `testName` (the title path and hint joined by the policy's joins) |
| `src/runtime/lifecycle.ts` | `./runtime` | worker | `trackSnapshots(state, { keyJoin })`: feed it the file's `RuntimeEvent`s. A later attempt or repeat takes back the earlier one's work (Jest 30.5 #16344); a test that didn't pass (skipped, todo, failed, or `test.failing` that passed) has its stored snapshots marked checked (#16348); `finish()` returns the report, or `null` for a file that never collected |
| `src/runtime/open.ts`, `files.ts` | `./runtime` | worker | `openFileSnapshots` (path, state, lifecycle in one call; a policy with no printer opens and fails only at the first snapshot, `SNAPSHOT_NO_PRINTER`); `readSnapFile` (header check) and `writeFileAtomically` (temp file, then rename) |
| `src/node/` | `./node` | coordinator | `resolveUpdateMode` (`-u`, CI, the policy's update variable), `createSnapshotAggregate` (Jest's `addResult` sums) and `snapshotRunFails` (the obsolete rule) |

## Rules that aren't obvious

- **A difference between the dialects is a policy value or the printer, or it isn't reproduced.** What is reproduced from policy: header, key join, hint join, error body (`message` plus the cause chain, or the error itself), obsolete rules (`failLocal` for mode `new`, `failCI` for mode `none`; mode `all` never fails), `ciUpdate`, the update variable, the pretty-format options. What isn't, and follows Jest in both (DIVERGENCES drafts in `bundles/B17.md`): Vitest compares trimmed text, marks only skipped tests' snapshots as checked (a failed test's unreached ones count as obsolete there), re-saves an existing `.snap` that is not in canonical form, and doesn't validate the header locally.
- **The mode decides what is written.** `new` writes a snapshot that doesn't exist; `all` (`-u`) also rewrites one that differs and removes the obsolete; `none` (CI) writes nothing and a missing snapshot fails (the dialect's `notWritten` message). `FileJob.updateSnapshots` carries it; `runProject` resolves it once.
- **Inline snapshots compare in place and never write (T7.11).** A match passes, a mismatch fails. One that would be written (missing, no CI; or differing under `-u`) fails with a message naming T7.11 and counts as unmatched, so nothing passes silently. Under `none` a missing one fails as in Jest.
- **The `.snap` is the worker's.** It resolves the path, reads and writes the file (`CoordinatorMethods` has no snapshot RPC any more; the inline-edit RPC is T7.11's). The coordinator only receives `SnapshotFileReport`s on `fileDone` and adds them up.
- **A failed assertion throws at the call** (until T7.8 reads `suppressedErrors` at the end of a test, Jest's `dontThrow`): the test fails either way, but its later snapshots aren't checked, and the lifecycle marks a failed test's snapshots checked so they aren't reported obsolete.
- **Serializers are per file.** `expect.addSnapshotSerializer(plugin)` adds to the running file's state, ahead of the others; the project's `snapshotSerializers` (absolute paths, `snapshot.serializers`) are imported through the file's own registry before its setup files, in reverse so the first listed is tried first. A plugin may be new-style (`serialize`) or old (`print`, `jest-serializer-vue`).
- **`snapshot.format.extra`** carries the other pretty-format options of a project's `snapshotFormat` (`indent`, `maxDepth`, ...); `escapeString`, `printBasicPrototype` and `maxOutputLength` have their own keys. Provino's own key.
- **A report is sent only when it says something:** a file with no snapshot activity and no `.snap` adds nothing to the run (`isEmptyReport` in the worker's runner), so a run without snapshots has no `summary.snapshots` and prints no `Snapshots:` line.

## Tests

- `src/**/*.test.ts`: natural-compare against the original package (a seeded set of keys), the `.snap` format, `SnapshotState` in temp directories (writing, `none`, `all`, obsolete, retry rollback, headers, inline, `test.failing`, file snapshots), the lifecycle over synthetic events, the update mode, the aggregate and the failure rule. They use a JSON printer, never a dialect's.
- The dialects' printers are tested in their packages (`snapshot-printer.test.ts`); the matchers in `@provino/expect`.
- **The corpus is `@provino/harness`'s `snapshot-corpus.test.ts`**: 23 fixtures (`fixtures/snapshot/`, recorded from Jest 30.5.2 and Vitest 5.0.5) run through `run()` and a forked worker, and the `.snap` bytes, test statuses and exit codes held to the goldens, under the Jest dialect and under the Jest dialect with Vitest's snapshot slice. `pnpm record:expect --check` is the recorder's check.

## Not built yet

- The inline writer and its RPC (T7.11), `snapshotResolver` (a Jest module; `snapshot.resolvePath` takes a ref but no reader builds one), obsolete snapshot *files* (Jest's `cleanup()` over the haste map), `provino snapshot convert` (T7.14), the Vitest renderer's diff and domain snapshots (T7.6), Prettier for the inline edit (T7.11, `snapshot.inline.formatter` is pending on it).
