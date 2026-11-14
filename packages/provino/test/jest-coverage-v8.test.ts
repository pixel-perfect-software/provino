// T8.12 through the bin: `provino jest` under `coverageProvider: 'v8'`, against what real Jest
// 30.5.2's v8 provider wrote for the same project (`coverage/v8-*`, recorded with the recorder's
// `--ci --json --outputFile`): the exit code, the text report byte for byte, `coverage-summary.json`
// per file and in total (statements, branches, functions, lines), `coverage-final.json`'s files,
// paths, `all`, counters and statement maps, its function names, and `--json`'s `coverageMap`.
//
// The function and branch ranges are Jest's except where Jest's come through babel's source map
// and not V8's own offsets (`DIFFERENT_RANGES`): there each one is pinned, ours and Jest's, so the
// list changes only on purpose.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { type Json, normalizedJson, observedText } from './mask.ts'
import { loadFixture, materialize, type RecordedFixture } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The recorder's environment for the reports (see `jest-coverage.test.ts`). */
const RECORDER_ENV = { CI: '1', NO_COLOR: '1', COLUMNS: '', GITHUB_ACTIONS: '' }

/**
 * The ranges of ours that are not Jest's, by fixture: `<file> <map>[<key>]` to our range and
 * Jest's, each `start-end (line N)`. Jest's v8 numbers come through babel's source map of
 * babel's own output (babel-jest with `@babel/preset-typescript` and the CommonJS plugin, D123);
 * ours through V8's offsets in the TypeScript file, stripped in place (D116). Four kinds:
 * - a branch that starts at an operator after a space (`??`, `?`, `:`, `&&`): babel maps the
 *   space after the left operand and not the operator, so Jest's starts one column earlier;
 * - a single-parameter arrow (`(entry) =>`): babel prints it `entry =>`, so Jest's starts at the
 *   parameter, one column after the parenthesis;
 * - a block that starts at the end of a line after a statement: babel maps the `;` it adds, so
 *   Jest's starts at that line's end, which v8-to-istanbul writes as column -1 of the next line;
 *   ours falls back to the line's last word (magic-string's `hires: 'boundary'` map);
 * - the end of a `catch` block before `finally {`: Jest's is the `{`, ours the `finally`.
 * The counters, the statements, the summary and the text report are Jest's in every case.
 */
const DIFFERENT_RANGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'coverage/v8-providers-sample': {
    'src/cart.ts branchMap[3]': 'ours 11:23-11:33 (line 11), jest 11:22-11:33 (line 11)',
    'src/cart.ts branchMap[7]': 'ours 15:37-15:70 (line 15), jest 15:38-15:70 (line 15)',
    'src/cart.ts branchMap[12]': 'ours 41:57-41:65 (line 41), jest 41:56-41:65 (line 41)',
    'src/edge.ts branchMap[7]': 'ours 33:8-33:12 (line 33), jest 33:7-33:12 (line 33)',
    'src/edge.ts branchMap[10]': 'ours 34:25-36:1 (line 34), jest 35:-1-36:1 (line 35)',
    'src/edge.ts branchMap[12]': 'ours 41:4-43:4 (line 41), jest 41:4-43:12 (line 41)',
    'src/format.ts branchMap[6]': 'ours 17:36-17:39 (line 17), jest 17:35-17:39 (line 17)',
    'src/format.ts branchMap[7]': 'ours 17:40-17:43 (line 17), jest 17:39-17:43 (line 17)',
    'src/format.ts branchMap[10]': 'ours 24:28-24:33 (line 24), jest 24:27-24:33 (line 24)',
    'src/format.ts branchMap[12]': 'ours 26:25-26:29 (line 26), jest 26:24-26:29 (line 26)',
    'src/format.ts branchMap[16]': 'ours 36:24-36:32 (line 36), jest 36:23-36:32 (line 36)',
    'src/format.ts branchMap[17]': 'ours 36:55-36:64 (line 36), jest 36:54-36:64 (line 36)',
    'src/format.ts branchMap[18]': 'ours 36:90-36:99 (line 36), jest 36:89-36:99 (line 36)',
    'src/pricing.ts fnMap[2]': 'ours 19:19-19:59 (line 19), jest 19:20-19:59 (line 19)',
    'src/pricing.ts branchMap[4]': 'ours 16:21-16:44 (line 16), jest 16:20-16:44 (line 16)',
    'src/pricing.ts branchMap[5]': 'ours 16:45-16:52 (line 16), jest 16:44-16:52 (line 16)',
  },
  'coverage/v8-untested': {
    'src/used.ts branchMap[3]': 'ours 3:27-5:1 (line 3), jest 4:-1-5:1 (line 4)',
  },
}

interface Ran {
  readonly fixture: RecordedFixture
  readonly root: string
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  json(path: string): Promise<Json | null>
}

const disposers: (() => Promise<void>)[] = []
after(async () => {
  await Promise.all(disposers.map((dispose) => dispose()))
})

async function provinoOn(id: string, args: readonly string[] = []): Promise<Ran> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  disposers.push(project.dispose)
  const { root } = project
  await mkdir(join(root, '.harness-out'), { recursive: true })
  const ended = await spawnCli(
    [
      'jest',
      `--config=${join(root, 'jest.config.json')}`,
      '--ci',
      '--json',
      `--outputFile=${join(root, '.harness-out', 'jest.json')}`,
      ...args,
    ],
    { cwd: root, env: RECORDER_ENV },
  )
  return {
    fixture,
    root,
    code: ended.code,
    stdout: ended.stdout,
    stderr: ended.stderr,
    json: async (path) => {
      const file = join(root, path)
      if (!existsSync(file)) return null
      return normalizedJson(JSON.parse(await readFile(file, 'utf8')) as Json, {
        roots: [root],
        timeKeys: fixture.manifest.run?.timeKeys ?? [],
        mask: fixture.manifest.run?.mask,
      })
    },
  }
}

type FileData = Readonly<Record<string, Json>>

function filesOf(value: Json | null | undefined): Readonly<Record<string, FileData>> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), 'an object')
  return value as Readonly<Record<string, FileData>>
}

/** What equals Jest's in every file: the path, `all`, the counters and the statement map. */
function exact(value: Json | null | undefined): Readonly<Record<string, Json>> {
  return Object.fromEntries(
    Object.entries(filesOf(value)).map(([key, data]) => [
      key,
      {
        path: data.path ?? null,
        all: data.all ?? null,
        statementMap: data.statementMap ?? null,
        s: data.s ?? null,
        f: data.f ?? null,
        b: data.b ?? null,
        names: Object.values(filesOf(data.fnMap)).map((fn) => fn.name ?? null),
        branches: Object.keys(filesOf(data.branchMap)).length,
      },
    ]),
  )
}

interface Loc {
  readonly start: { readonly line: number; readonly column: number }
  readonly end: { readonly line: number; readonly column: number }
}

function describeRange(entry: FileData): string {
  const loc = entry.loc as unknown as Loc
  return `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column} (line ${String(entry.line)})`
}

/** Every function and branch entry of ours that is not Jest's, as `DIFFERENT_RANGES` writes it. */
function rangeDifferences(
  ours: Json | null | undefined,
  jest: Json | null | undefined,
): Record<string, string> {
  const theirs = filesOf(jest)
  const found: Record<string, string> = {}
  for (const [file, data] of Object.entries(filesOf(ours))) {
    for (const map of ['fnMap', 'branchMap'] as const) {
      const expected = filesOf(theirs[file]?.[map])
      for (const [key, entry] of Object.entries(filesOf(data[map]))) {
        const other = expected[key]
        if (other !== undefined && JSON.stringify(entry) === JSON.stringify(other)) continue
        const name = `${file.replace('<root>/', '')} ${map}[${key}]`
        found[name] =
          `ours ${describeRange(entry)}, jest ${other === undefined ? 'none' : describeRange(filesOf(other))}`
      }
    }
  }
  return found
}

function asRecorded(ran: Ran, text: string): string {
  return observedText(text, { roots: [ran.root], mask: ran.fixture.manifest.run?.mask })
}

describe("provino jest under coverageProvider: 'v8' writes what Jest 30.5.2's v8 provider wrote", () => {
  // A CommonJS module is run in a wrapper inside a vm script: neither may count, at any worker
  // count (each worker's script runs once, the module once per load).
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['coverage/v8-providers-sample', []],
    ['coverage/v8-untested', []],
    ['coverage/v8-commonjs', ['-w', '1']],
    ['coverage/v8-commonjs', ['-w', '2']],
  ]
  for (const [id, args] of cases) {
    it(`${id}${args.length === 0 ? '' : ` (${args.join(' ')})`}: the text report and json-summary, every file's counters and statements, its ranges but the pinned ones`, async () => {
      const ran = await provinoOn(id, args)
      const golden = ran.fixture.golden.observed
      assert.equal(ran.code, golden?.exitCode, ran.stderr)
      assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
      // Statements, branches, functions and lines, per file and in total.
      assert.deepEqual(
        await ran.json('coverage/coverage-summary.json'),
        golden?.json?.['coverage/coverage-summary.json'],
      )
      const final = await ran.json('coverage/coverage-final.json')
      const expected = golden?.json?.['coverage/coverage-final.json']
      assert.deepEqual(Object.keys(filesOf(final)).sort(), Object.keys(filesOf(expected)).sort())
      assert.deepEqual(exact(final), exact(expected))
      assert.deepEqual(rangeDifferences(final, expected), DIFFERENT_RANGES[id] ?? {})
    })
  }

  it("--json's coverageMap is the same map (v8-providers-sample)", async () => {
    const ran = await provinoOn('coverage/v8-providers-sample')
    const results = filesOf(await ran.json('.harness-out/jest.json'))
    const recorded = filesOf(ran.fixture.golden.observed?.json?.['.harness-out/jest.json'])
    assert.deepEqual(exact(results.coverageMap), exact(recorded.coverageMap))
  })
})
