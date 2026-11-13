// T2.3: the harness the semantics suite shares. A fixture is a small tree of source files (strings
// written to a temp dir at test time, so no `.js`/`.mjs`/`.cjs` is ever committed, D13) and an
// entry. The entry is run twice and the two observations are diffed:
//
// - natively: a child process (`process.execPath`) imports (`.mjs`) or requires (`.cjs`) the
//   entry. A child keeps Node's module caches, `require.cache` and `process.dlopen` state out of
//   the test process, which is itself running Provino's loader;
// - through Provino: `createLoader(...).createFileRegistry(entry, { tier: 'registry' })` in this
//   process, `import`ing or `require`ing the same entry.
//
// What a fixture observes, on both sides alike: `globalThis.__trace`, an array the fixture's
// modules append to (every value JSON-safe), and the entry's `result` export (awaited, so a
// fixture with top-level await or an async CommonJS entry exports a promise). A load that throws
// is observed as `{ name, code, message }`, which `expectSame` checks whole (`messages: false`
// leaves the message out where Node's text is not stable). Absolute paths are normalised to
// `<root>`. `expectDivergence` pins what Provino does where it differs from Node on purpose or by
// limit, and names the divergence in the test (`// divergence DV7x (pending): …`).
//
// Native Node is whatever runs the tests (22.15 and 24 on CI), so a fixture that depends on the
// version reads the native observation to decide what to expect (`import.meta.main`, the
// `module.exports` name of a CommonJS namespace).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type { FileRegistry, Loader, ModulePolicy } from '@provino/types'
import { createLoader } from '../loader.ts'

/** What one run of an entry observed. JSON round-tripped, so both sides compare as plain data. */
export interface Observation {
  readonly trace: readonly unknown[]
  readonly result?: unknown
  readonly threw?: { readonly name: string; readonly code: unknown; readonly message: string }
}

export interface Fixture {
  /** The tree, by path relative to the temp root. */
  readonly files: Readonly<Record<string, string>>
  /** The entry's path in the tree; `.cjs` is `require`d, anything else is `import`ed. */
  readonly entry: string
  /** The loader's `ModulePolicy.interopDefault`; `node` unless the fixture is about `babel`. */
  readonly interop?: ModulePolicy['interopDefault']
}

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Writes `files` into a fresh temp directory (its real path, as Node reports it) and returns it. */
export function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-semantics-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** The same shape on both sides: JSON text with every absolute path made relative to `<root>`. */
function normalise(root: string, observation: Observation): Observation {
  const text = JSON.stringify(observation).replaceAll(root, '<root>')
  return JSON.parse(text) as Observation
}

/**
 * The child's script. It mirrors `runProvino`: reset the trace, load the entry, await `result`,
 * print one JSON line. (`describe` repeats `describeError` below, in plain JS.)
 */
const CHILD = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [entry] = process.argv.slice(1)
const trace = (globalThis.__trace = [])
const describe = (e) => ({ name: e?.name, code: e?.code, message: e?.message })
let observation
try {
  const exports = entry.endsWith('.cjs')
    ? createRequire(entry)(entry)
    : await import(pathToFileURL(entry).href)
  observation = { trace, result: await exports.result }
} catch (error) {
  observation = { trace, threw: describe(error) }
}
process.stdout.write(JSON.stringify(observation))
`

function describeError(error: unknown): NonNullable<Observation['threw']> {
  const e = error as { name?: string; code?: unknown; message?: string } | undefined
  return { name: String(e?.name), code: e?.code, message: String(e?.message) }
}

/** Runs the fixture's entry in a child process on the running Node. */
function runNative(root: string, entry: string): Observation {
  const env = { ...process.env }
  // `node --test` marks its children; this one is not a test.
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD, join(root, entry)], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  })
  assert.equal(run.status, 0, `native child failed (${run.status}): ${run.stderr}`)
  return normalise(root, JSON.parse(run.stdout) as Observation)
}

/** A loader over `root` with the neutral module policy, `interopDefault` as asked. */
export function createLoaderFor(root: string, interop: ModulePolicy['interopDefault']): Loader {
  return createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({
      root,
      mappers: [],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      tsconfig: false,
    }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
    }),
    policy: { ...neutralPolicy.module, interopDefault: interop },
  })
}

/** Runs `entry` through `registry` and observes what `runNative` observes. */
async function observe(registry: FileRegistry, entry: string): Promise<Observation> {
  const previous: unknown = Reflect.get(globalThis, '__trace')
  const trace: unknown[] = []
  Reflect.set(globalThis, '__trace', trace)
  try {
    const exports = entry.endsWith('.cjs')
      ? registry.require<{ result?: unknown }>(entry)
      : await registry.import<{ result?: unknown }>(entry)
    return { trace, result: await exports.result }
  } catch (error) {
    return { trace, threw: describeError(error) }
  } finally {
    Reflect.set(globalThis, '__trace', previous)
  }
}

/** Runs the fixture's entry through Provino's loader, in this process. */
async function runProvino(root: string, fixture: Fixture): Promise<Observation> {
  const loader = createLoaderFor(root, fixture.interop ?? 'node')
  const entry = join(root, fixture.entry)
  // No `using`: the 22.15 leg parses tests as Node 22 does, which has no explicit resource management.
  const registry = loader.createFileRegistry(entry, { tier: 'registry' })
  try {
    return normalise(root, await observe(registry, entry))
  } finally {
    registry.dispose()
  }
}

export interface Compared {
  readonly native: Observation
  readonly provino: Observation
}

/** Writes the fixture and runs it both ways. */
export async function runBoth(fixture: Fixture): Promise<Compared> {
  const root = writeTree(fixture.files)
  const native = runNative(root, fixture.entry)
  const provino = await runProvino(root, fixture)
  return { native, provino }
}

/** The observation without the error's message, for a fixture whose Node text is not stable. */
function withoutMessage(observation: Observation): Observation {
  if (observation.threw === undefined) return observation
  const { message: _message, ...threw } = observation.threw
  return { ...observation, threw: threw as Observation['threw'] & object }
}

/**
 * Provino's observation equals native Node's. A load that throws on both sides is a case that is
 * about the throw (`throws: true`); without it, a throw is a fixture that went wrong the same way
 * twice (a typo, a dead-zone read the case did not mean), and fails here.
 */
export async function expectSame(
  fixture: Fixture,
  options: { messages?: boolean; throws?: boolean } = {},
): Promise<Compared> {
  const both = await runBoth(fixture)
  if (options.throws !== true) {
    assert.equal(
      both.native.threw,
      undefined,
      'native Node threw: the fixture should run to the end (pass { throws: true } if it is about the throw)',
    )
  }
  const pick = options.messages === false ? withoutMessage : (o: Observation) => o
  assert.deepEqual(pick(both.provino), pick(both.native))
  return both
}

/**
 * A listed divergence: Provino's observation is `expected` (pinned, so a change can't drift
 * silently), and it still differs from native Node's. `native` pins what Node does where it is
 * the same on every supported version.
 */
export async function expectDivergence(
  fixture: Fixture,
  expected: { readonly provino: Observation; readonly native?: Observation },
): Promise<Compared> {
  const both = await runBoth(fixture)
  assert.deepEqual(both.provino, expected.provino, 'Provino’s observation (the pinned divergence)')
  if (expected.native !== undefined) assert.deepEqual(both.native, expected.native, 'native Node')
  assert.notDeepEqual(both.provino, both.native, 'this no longer diverges: drop the divergence')
  return both
}

/**
 * The `.node` file of the oxc-parser binding installed for this platform, found the way oxc-parser
 * finds it (a sibling package of `oxc-parser`, which `@provino/transform` depends on), or `null`
 * when no binding is installed. Nothing is compiled: this is an addon already on disk.
 */
export function findInstalledAddon(): string | null {
  let oxcParser: string
  try {
    oxcParser = createRequire(import.meta.resolve('@provino/transform')).resolve('oxc-parser')
  } catch {
    return null // oxc-parser is not installed under @provino/transform
  }
  const { platform, arch } = process
  const names =
    platform === 'linux'
      ? [`linux-${arch}-gnu`, `linux-${arch}-musl`]
      : platform === 'win32'
        ? [`win32-${arch}-msvc`]
        : [`${platform}-${arch}`]
  const fromOxc = createRequire(oxcParser)
  for (const name of names) {
    try {
      return fromOxc.resolve(`@oxc-parser/binding-${name}`)
    } catch {
      // not this one: the binding for another libc is not installed
    }
  }
  return null
}
