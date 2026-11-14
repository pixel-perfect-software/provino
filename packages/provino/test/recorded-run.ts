// A recorded fixture run by `provino jest`, and the comparison with its Jest 30.5.2 golden, shared
// by every test that holds `provino jest` to a `run` recording (`jest-json`, and B23e's ecosystem
// and IDE replays). `provinoOn` does what the recorder does around the runner: the project under
// `.work/` (so packages resolve from this package's devDependencies), each `before` entry first,
// then the captured run; `assertMatchesGolden` reads every capture through the same steps the
// recorder applies (roots, `keepLines`, `mask`, times) and compares it with the golden's.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Json, normalizedJson, observedText } from './mask.ts'
import { loadFixture, materialize, type RecordedFixture } from './recorded.ts'
import { spawnCli } from './support.ts'

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
  /** The same files parsed and not normalized, plus the recorder's own `RESULTS` when it was asked for. */
  readonly raw: Readonly<Record<string, Json | null>>
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The recorder's `sortStdout` on already-kept lines. */
function sortedLines(text: string, mode: true | 'json', what: string): string {
  const lines = text.split('\n')
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

/** The environment the recorder gives the runner, with the fixture's `env` on top. */
function envOf(fixture: RecordedFixture): Record<string, string> {
  const env: Record<string, string> = { CI: '1', NO_COLOR: '1', TZ: 'UTC' }
  for (const [name, value] of Object.entries(fixture.manifest.env ?? {})) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

async function readJson(file: string): Promise<Json | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  return text === null ? null : (JSON.parse(text) as Json)
}

/**
 * Runs the fixture's project through `provino jest` as the recorder runs Jest: each `before` entry
 * (their output dropped, and the results they wrote removed), then the captured run. Under
 * `run.exact` the arguments are exactly the fixture's, started in the project's root where the
 * recorder's `jest.config.json` is found; else `--config`, `--ci`, the fixture's arguments and
 * `--json --outputFile=.harness-out/jest.json`, as the recorder passes them.
 */
export async function provinoOn(id: string, options: ProvinoOnOptions = {}): Promise<RecordedRun> {
  const fixture = await loadFixture(id)
  const spec = fixture.manifest.run
  const project = await materialize(fixture, { parent: options.parent ?? WORK })
  const exact = spec?.exact === true
  const { root } = project
  try {
    await mkdir(join(root, '.harness-out'), { recursive: true })
    const argvFor = (extra: readonly string[]): string[] =>
      exact
        ? ['jest', ...extra]
        : [
            'jest',
            `--config=${join(root, 'jest.config.json')}`,
            '--ci',
            ...extra,
            '--json',
            `--outputFile=${RESULTS}`,
          ]
    const start = (extra: readonly string[]) =>
      spawnCli(argvFor(extra), {
        cwd: join(root, spec?.cwd ?? '.'),
        env: envOf(fixture),
        deadlineMs: options.deadlineMs ?? 120_000,
      })
    for (const entry of fixture.manifest.before ?? []) {
      await start(entry.argv)
      await rm(join(root, RESULTS), { force: true })
    }
    const ended = await start(spec?.argv?.jest ?? [])

    const roots = [root]
    const steps = { roots, mask: spec?.mask }
    const stream = (text: string): string => {
      const kept = observedText(text, { ...steps, keepLines: spec?.keepLines, mask: undefined })
      const sorted = spec?.sortStdout === undefined ? kept : sortedLines(kept, spec.sortStdout, id)
      return observedText(sorted, { roots: [], mask: spec?.mask })
    }
    const files: Record<string, string | null> = {}
    const json: Record<string, Json | null> = {}
    const raw: Record<string, Json | null> = {}
    for (const entry of spec?.capture ?? []) {
      const file = entry.slice(entry.indexOf(':') + 1)
      if (entry.startsWith('file:')) {
        const text = await readFile(join(root, file), 'utf8').catch(() => null)
        files[file] =
          text === null
            ? null
            : observedText(
                spec?.sortStdout === 'json' ? sortedLines(text, 'json', file) : text,
                steps,
              )
      } else if (entry.startsWith('json:')) {
        const value = await readJson(join(root, file))
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
    // The recorder's own results file, for a test that reads Jest's whole report.
    if (!exact && !(RESULTS in raw)) raw[RESULTS] = await readJson(join(root, RESULTS))
    return {
      fixture,
      code: ended.code,
      stdout: stream(ended.stdout),
      stderr: stream(ended.stderr),
      files,
      json,
      raw,
    }
  } finally {
    await project.dispose()
  }
}

/** A difference a test accepts, pinned: it fails when either side moves or the two agree. */
export interface DeclaredDifference {
  /** What the golden holds (the recording still has to say this). */
  readonly golden: unknown
  /** What Provino gives (it still has to give this). */
  readonly provino: unknown
  readonly reason: string
}

/** Jest lists a run's files in the order they finished: compare them by name. */
function inFileOrder(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const results = (value as { testResults?: unknown }).testResults
  if (!Array.isArray(results)) return value
  return {
    ...value,
    testResults: results.toSorted((a: { name?: string }, b: { name?: string }) =>
      byCodePoint(String(a.name), String(b.name)),
    ),
  }
}

/**
 * Holds every capture of `run` to the golden's: the exit code, each stream, each `file:` and
 * `json:`. `declared` names the captures (`exitCode`, `stdout`, `stderr`, `file:<path>`,
 * `json:<path>`) where Provino differs on purpose: each pins what both sides hold, so the entry
 * fails when the golden is re-recorded, Provino changes, or the difference goes away.
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
      compare(entry, inFileOrder(golden), inFileOrder(run.json[file]))
    }
  }
}
