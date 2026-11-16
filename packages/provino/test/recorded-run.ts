// A recorded fixture run by `provino jest`, and the comparison with its Jest 30.5.2 golden, shared
// by every test that holds `provino jest` to a `run` recording (`jest-json`, and B23e's ecosystem
// and IDE replays). `provinoOn` does what the recorder does around the runner: the project under
// `.work/` (so packages resolve from this package's devDependencies), the recorder's environment
// (`replayEnv`), each `before` entry first, then the captured run; `assertMatchesGolden` reads
// every capture through the same steps the recorder applies (roots, `keepLines`, `sortStdout`,
// `mask`, times) and compares it with the golden's, with no step of its own.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Json, normalizedJson, observedText } from './mask.ts'
import {
  loadFixture,
  materialize,
  type RecordedFixture,
  type RecordedManifest,
} from './recorded.ts'
import { outputFree, spawnCli } from './support.ts'

// The recorder's text normalizer, loaded by path: `provino` may not import `@provino/harness` (the
// harness depends on it), as `watch-goldens.ts` loads the harness's watch pieces.
const { createNormalizer } = (await import(
  new URL('../../harness/src/normalize.ts', import.meta.url).href
)) as {
  readonly createNormalizer: (context: {
    readonly rootDir: string
    readonly extraRoots?: readonly string[]
  }) => { readonly text: (text: string) => string }
}

/** Inside this package, so the packages a fixture's config names resolve from `node_modules`. */
export const WORK: string = fileURLToPath(new URL('../.work/', import.meta.url))

/** Where the recorder's own run writes Jest's results. */
export const RESULTS = '.harness-out/jest.json'

/** What `provinoOn` takes. */
export interface ProvinoOnOptions {
  /** Where the project goes (default `.work/` of this package). */
  readonly parent?: string
  /** A run still going after this is killed (default 120 s). */
  readonly deadlineMs?: number
}

/** One `provino jest` run of a fixture, read as the recorder reads its own. */
export interface RecordedRun {
  readonly fixture: RecordedFixture
  readonly code: number | null
  /** Each captured stream as the recording holds it: roots, kept lines, sorted, masked. */
  readonly stdout: string
  readonly stderr: string
  /** Each `file:` capture's text as the recording holds it, `null` when the run left none. */
  readonly files: Readonly<Record<string, string | null>>
  /** Each `json:` capture, normalized as the recorder does (`<root>`, `<frames>`, times, masks). */
  readonly json: Readonly<Record<string, Json | null>>
  /**
   * A `json:` capture parsed and not normalized, or (outside `run.exact`) the recorder's own
   * `RESULTS`; `null` when the run wrote none. It **throws** for a file that was never read, so a
   * test of an exact run can't compare a missing `RESULTS` with a missing `RESULTS` and pass.
   */
  rawJson(file: string): Json | null
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The recorder's `sortStdout`, on kept lines (a stream) or on a whole file (as one line). */
function sortedLines(lines: readonly string[], mode: true | 'json', what: string): string {
  if (mode === true) return lines.toSorted(byCodePoint).join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(lines.join('\n'))
  } catch {
    parsed = undefined
  }
  assert.ok(
    Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
    `${what}: sortStdout is "json" but the kept lines are not one JSON array of strings`,
  )
  return (parsed as string[]).toSorted(byCodePoint).join('\n')
}

type RunSpec = NonNullable<RecordedManifest['run']>

/**
 * The text as the recorder normalized it before anything else (`record.ts`): under `run.raw` the
 * roots as `<root>` alone, else the harness's normalizer's `text` (the roots, and the code frames,
 * durations, placeholders and stacks it reduces).
 */
function normalizedForRecording(
  text: string,
  spec: RunSpec | undefined,
  roots: readonly string[],
): string {
  if (spec?.raw === true) return observedText(text, { roots })
  const [rootDir = '', ...extraRoots] = roots
  return createNormalizer({ rootDir, extraRoots }).text(text)
}

/**
 * A captured stream as the recorder records it (`observedOf`): normalized as the recorder did
 * (`normalizedForRecording`), the lines `keepLines` keeps, `sortStdout` (`true` sorts the lines, `'json'` the elements of the one array
 * they make), then `mask`.
 */
export function recordedStream(
  text: string,
  spec: RunSpec | undefined,
  roots: readonly string[],
  what = 'a stream',
): string {
  const kept = observedText(normalizedForRecording(text, spec, roots), {
    roots: [],
    keepLines: spec?.keepLines,
  })
  const sorted =
    spec?.sortStdout === undefined ? kept : sortedLines(kept.split('\n'), spec.sortStdout, what)
  return observedText(sorted, { roots: [], mask: spec?.mask })
}

/**
 * A `file:` capture as the recorder records it: normalized as the recorder did, then (only under
 * `sortStdout: "json"`, which the recorder applies to every captured file too) the elements of the
 * one array the text is, sorted, then `mask`. `sortStdout: true` leaves a file alone.
 */
export function recordedFile(
  text: string,
  spec: RunSpec | undefined,
  roots: readonly string[],
  what = 'a file',
): string {
  const rooted = normalizedForRecording(text, spec, roots)
  const sorted = spec?.sortStdout === 'json' ? sortedLines([rooted], 'json', what) : rooted
  return observedText(sorted, { roots: [], mask: spec?.mask })
}

// A copy of the recorder's `internal/runner-config.ts` (`LOCALE`, `INHERITED_NOISE`, `runnerEnv`)
// and `internal/scm.ts` (`hermeticGitEnv`): `provino` may not import the harness. Change all.
const LOCALE = 'C.UTF-8'
const INHERITED_NOISE: ReadonlySet<string> = new Set([
  'NODE_TEST_CONTEXT',
  'FORCE_COLOR',
  'NODE_ENV',
  'JEST_WORKER_ID',
  'VITEST',
  'COLUMNS',
  'AI_AGENT',
  'AUGMENT_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'COPILOT_AGENT',
  'COPILOT_CLI',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'GITHUB_ACTIONS',
  'GOOSE_PROVIDER',
  'JUNIE_DATA',
  'JUNIE_SHIM_PATH',
  'OPENCODE',
  'REPL_ID',
])
const SCM_DATE = '2026-01-01T00:00:00Z'
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
]
function hermeticGitEnv(ceiling: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: SCM_DATE,
    GIT_COMMITTER_DATE: SCM_DATE,
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
    ...Object.fromEntries(
      GIT_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

/**
 * The environment the recorder gives the runner, for the project at `root`: this process's, minus
 * its `GIT_*` variables, `LC_*`, `LANGUAGE`, the recorder's noise list and what `detectOutput`
 * reads (`outputFree`), then `CI=1`, `NO_COLOR=1`, `TZ=UTC`, the locale, the hermetic git
 * environment (a ceiling at the project's parent, so git can't find the checkout's repository)
 * and the fixture's `env`, and last every `null` of that `env` removed from the result, whether
 * the variable was inherited or the recorder's own.
 */
export function replayEnv(manifest: RecordedManifest, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(outputFree(process.env))) {
    if (name.startsWith('GIT_') || name.startsWith('LC_') || name === 'LANGUAGE') continue
    if (INHERITED_NOISE.has(name)) continue
    env[name] = value
  }
  const given = Object.entries(manifest.env ?? {})
  Object.assign(
    env,
    { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: LOCALE, LC_ALL: LOCALE },
    hermeticGitEnv(dirname(root)),
    Object.fromEntries(given.filter((entry): entry is [string, string] => entry[1] !== null)),
  )
  for (const [name, value] of given) if (value === null) delete env[name]
  return env
}

/** The arguments `provino` is started with for one run, and the flags before its bin. */
export function replayCommand(
  fixture: RecordedFixture,
  root: string,
  extra: readonly string[],
): { readonly args: string[]; readonly nodeArgs: readonly string[] } {
  const exact = fixture.manifest.run?.exact === true
  return {
    args: exact
      ? ['jest', ...extra]
      : [
          'jest',
          `--config=${join(root, 'jest.config.json')}`,
          '--ci',
          ...extra,
          '--json',
          `--outputFile=${RESULTS}`,
        ],
    nodeArgs: fixture.manifest.nodeFlags ?? [],
  }
}

/** `provinoOn` for a fixture already read. */
export async function runFixture(
  fixture: RecordedFixture,
  options: ProvinoOnOptions = {},
): Promise<RecordedRun> {
  const id = fixture.id
  const spec = fixture.manifest.run
  if (fixture.manifest.scm !== undefined) {
    throw new Error(
      `${id}: the fixture has "scm", which provinoOn does not build yet (the recorder runs its steps in the work directory); lift jest-changed.test.ts's runner when a phase needs it`,
    )
  }
  const project = await materialize(fixture, { parent: options.parent ?? WORK })
  const exact = spec?.exact === true
  const { root } = project
  try {
    await mkdir(join(root, '.harness-out'), { recursive: true })
    const baseEnv = replayEnv(fixture.manifest, root)
    const start = (extra: readonly string[]) => {
      const command = replayCommand(fixture, root, extra)
      return spawnCli(command.args, {
        cwd: join(root, spec?.cwd ?? '.'),
        baseEnv,
        nodeArgs: command.nodeArgs,
        deadlineMs: options.deadlineMs ?? 120_000,
      })
    }
    for (const entry of fixture.manifest.before ?? []) {
      await start(entry.argv)
      await rm(join(root, RESULTS), { force: true })
    }
    const ended = await start(spec?.argv?.jest ?? [])

    const roots = [root]
    const files: Record<string, string | null> = {}
    const json: Record<string, Json | null> = {}
    const raw: Record<string, Json | null> = {}
    const readText = (file: string) => readFile(join(root, file), 'utf8').catch(() => null)
    for (const entry of spec?.capture ?? []) {
      const file = entry.slice(entry.indexOf(':') + 1)
      if (entry.startsWith('file:')) {
        const text = await readText(file)
        files[file] = text === null ? null : recordedFile(text, spec, roots, file)
      } else if (entry.startsWith('json:')) {
        // `json:stdout` and `json:stderr` are the stream itself (the recorder's `observedOf`).
        const text =
          file === 'stdout' ? ended.stdout : file === 'stderr' ? ended.stderr : await readText(file)
        // The recorder treats an empty capture as a run that wrote nothing; so does the replay.
        if (text !== null && text.trim() === '') {
          if (spec?.missingJson?.includes(entry) !== true) {
            throw new Error(
              `${id}: "${entry}" is empty: the run wrote no JSON to ${file} (list "${entry}" in "missingJson" if that is what the run shows)`,
            )
          }
        }
        const value = text === null || text.trim() === '' ? null : (JSON.parse(text) as Json)
        raw[file] = value
        json[file] =
          value === null
            ? null
            : normalizedJson(value, {
                roots,
                timeKeys: spec?.timeKeys ?? [],
                maskKeys: spec?.maskKeys,
                mask: spec?.mask,
              })
      }
    }
    // The recorder's own results file exists only when the recorder passed `--outputFile`.
    if (!exact && !(RESULTS in raw)) {
      const text = await readText(RESULTS)
      raw[RESULTS] = text === null ? null : (JSON.parse(text) as Json)
    }
    // The recorder reads only the streams a fixture captures; `sortStdout` must not fail on the rest.
    const captured = (stream: string): boolean => spec?.capture.includes(stream) ?? false
    // Reading a stream the fixture does not capture throws, as `rawJson` does for an uncaptured file.
    const streamOf = (stream: 'stdout' | 'stderr'): string => {
      if (!captured(stream)) {
        throw new Error(
          `${id}: ${stream} was not captured: capture it ("${stream}" in run.capture)`,
        )
      }
      return recordedStream(ended[stream], spec, roots, `${id} ${stream}`)
    }
    return {
      fixture,
      code: ended.code,
      get stdout() {
        return streamOf('stdout')
      },
      get stderr() {
        return streamOf('stderr')
      },
      files,
      json,
      rawJson(file) {
        const value = raw[file]
        if (value === undefined) {
          throw new Error(
            `${id}: "${file}" was not read: capture it as json:${file}${
              exact ? ' (under run.exact the recorder writes no results file of its own)' : ''
            }`,
          )
        }
        return value
      },
    }
  } finally {
    await project.dispose()
  }
}

/**
 * Runs the fixture's project through `provino jest` as the recorder runs Jest: the recorder's
 * environment, each `before` entry (their output dropped, and the results they wrote removed), then
 * the captured run. Under `run.exact` the arguments are exactly the fixture's, started in the
 * project's root where the recorder's `jest.config.json` is found; else `--config`, `--ci`, the
 * fixture's arguments and `--json --outputFile=.harness-out/jest.json`, as the recorder passes
 * them. A fixture with `scm` is refused.
 */
export async function provinoOn(id: string, options: ProvinoOnOptions = {}): Promise<RecordedRun> {
  return runFixture(await loadFixture(id), options)
}

/** A difference a test accepts, pinned: it fails when either side moves or the two agree. */
export interface DeclaredDifference {
  /** What the golden holds (the recording still has to say this). */
  readonly golden: unknown
  /** What Provino gives (it still has to give this). */
  readonly provino: unknown
  readonly reason: string
}

/**
 * Holds every capture of `run` to the golden's: the exit code, each stream, each `file:` and
 * `json:`. Both sides of a `json:` capture are the recorder's own normalization (`mask.ts` is its
 * copy, including the order of `testResults` and of path-keyed maps), so nothing is reordered here.
 * `declared` names the captures (`exitCode`, `stdout`, `stderr`, `file:<path>`, `json:<path>`)
 * where Provino differs on purpose: each pins what both sides hold, so the entry fails when the
 * golden is re-recorded, Provino changes, or the difference goes away.
 */
export function assertMatchesGolden(
  id: string,
  run: RecordedRun,
  options: { readonly declared?: Readonly<Record<string, DeclaredDifference>> } = {},
): void {
  const spec = run.fixture.manifest.run
  assert.ok(spec !== undefined, `${id}: the fixture has no "run" to compare`)
  const observed = run.fixture.golden.observed
  assert.ok(observed !== undefined, `${id}: the golden has no "observed"; record the fixture again`)
  const declared = options.declared ?? {}
  for (const key of Object.keys(declared)) {
    assert.ok(spec.capture.includes(key), `${id}: declared "${key}" is not a capture`)
  }
  const compare = (key: string, golden: unknown, provino: unknown): void => {
    const entry = declared[key]
    if (entry === undefined) {
      assert.deepEqual(provino, golden, `${id}: ${key} differs from Jest's`)
      return
    }
    assert.deepEqual(
      golden,
      entry.golden,
      `${id}: ${key}: the golden is no longer what is declared`,
    )
    assert.deepEqual(provino, entry.provino, `${id}: ${key}: Provino gives something else now`)
    assert.notDeepEqual(provino, golden, `${id}: ${key}: the declared difference is gone`)
  }
  for (const entry of spec.capture) {
    const file = entry.slice(entry.indexOf(':') + 1)
    if (entry === 'exitCode') compare(entry, observed.exitCode, run.code)
    else if (entry === 'stdout') compare(entry, observed.stdout, run.stdout)
    else if (entry === 'stderr') compare(entry, observed.stderr, run.stderr)
    else if (entry.startsWith('file:')) {
      const golden = observed.files?.[file]
      assert.notEqual(golden, undefined, `${id}: the golden has no ${entry}`)
      compare(entry, golden, run.files[file])
    } else {
      const golden = observed.json?.[file]
      assert.notEqual(golden, undefined, `${id}: the golden has no ${entry}`)
      compare(entry, golden, run.json[file])
    }
  }
}
