// Row 12's process half: read the package's test script, run node --test over the files before the
// rewrite and Provino over them after it, and turn what each reported into records.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONDITIONS_FLAG, SCRIPT_JOIN, SHARED_CONFIG_VALUES, TEST_RUNNER } from '../dogfood.ts'
import { runCommandAsync } from '../exec.ts'
import { MigrateError } from './errors.ts'
import {
  type ReporterLine,
  recordsFromProvino,
  recordsFromReporter,
  type TestRecord,
} from './node-test-compare.ts'

const REPORTER = fileURLToPath(new URL('./node-test-reporter.ts', import.meta.url))
/** Both runs can be long: a package's whole suite, with no deadline of its own. */
const TIMEOUT_MS = 30 * 60_000

/**
 * What a package's `test` script says: the node flags that change how a file loads, and the globs
 * of its test files.
 * @internal
 */
export interface TestScript {
  readonly flags: readonly string[]
  readonly globs: readonly string[]
}

/** Flags that take their value as the next word when it is not joined with `=`. */
const LOAD_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--conditions',
  '-C',
  '--loader',
  '--experimental-loader',
])
/** `--test-*` flags that pick tests, shards or reporters: not the run's loading, so dropped. */
const TEST_VALUE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-concurrency',
  '--test-timeout',
  '--test-coverage-include',
  '--test-coverage-exclude',
])
/** The wrapper `provino`'s script runs through: it adds `--test` itself. */
const WRAPPER = /(^|\/)node-test\.ts$/

function scriptError(script: string, why: string): MigrateError {
  return new MigrateError('MIGRATE_SCRIPT', `cannot read the test script "${script}": ${why}`)
}

/** Splits on blanks, keeping single- and double-quoted text together; refuses shell syntax. */
function words(script: string): string[] {
  const found: string[] = []
  let word = ''
  let open = false
  let quote: string | null = null
  for (const char of script) {
    if (quote !== null) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      open = true
    } else if (/\s/.test(char)) {
      if (open || word !== '') found.push(word)
      word = ''
      open = false
    } else if (/[&|;<>`$(){}]/.test(char)) {
      throw scriptError(script, `shell syntax (${char})`)
    } else {
      word += char
    }
  }
  if (quote !== null) throw scriptError(script, 'an unclosed quote')
  if (open || word !== '') found.push(word)
  return found
}

const LOOKS_LIKE_PATH = /[*/]|\.[cm]?[jt]sx?$/

/**
 * Reads `node [flags] --test [flags] <globs…>` (or the same through `node-test.ts`). The flags that
 * load code (`--import`, `--require`, `--conditions`, loaders, in both spellings) are kept with their
 * values; the test-selection ones are dropped; the first path or glob starts the patterns. A script
 * that is anything else fails with `MIGRATE_SCRIPT`: guessing globs would migrate the wrong files.
 * @internal
 */
export function parseTestScript(script: string | undefined): TestScript {
  if (script === undefined || script.trim() === '') {
    throw new MigrateError('MIGRATE_SCRIPT', 'the package has no test script')
  }
  // An already-migrated package (B27g2): `<runner> [&& node --test <bootstrap files>]`. Its Provino
  // part has nothing for the codemod to rewrite; the node:test part is read as any other script.
  if (script === TEST_RUNNER) return { flags: [], globs: [] }
  if (script.startsWith(`${TEST_RUNNER}${SCRIPT_JOIN}`)) {
    return parseTestScript(script.slice(TEST_RUNNER.length + SCRIPT_JOIN.length))
  }
  const tokens = words(script)
  if (tokens[0] !== 'node') throw scriptError(script, 'it does not start with node')
  const flags: string[] = []
  const globs: string[] = []
  let sawTest = false
  for (let at = 1; at < tokens.length; at++) {
    const token = tokens[at] ?? ''
    if (globs.length > 0) {
      if (token.startsWith('-')) throw scriptError(script, `${token} after the test patterns`)
      globs.push(token)
    } else if (token === '--test') {
      sawTest = true
    } else if (token.startsWith('-')) {
      const name = token.split('=')[0] ?? token
      const joined = token.includes('=')
      if (name.startsWith('--test-')) {
        if (TEST_VALUE_FLAGS.has(name) && !joined) at++
      } else if (LOAD_FLAGS.has(name) && !joined) {
        const value = tokens[++at]
        if (value === undefined) throw scriptError(script, `${token} has no value`)
        flags.push(token, value)
      } else {
        flags.push(token)
      }
    } else if (WRAPPER.test(token)) {
      sawTest = true
    } else if (LOOKS_LIKE_PATH.test(token)) {
      globs.push(token)
    } else {
      throw scriptError(script, `"${token}" is neither a flag nor a test path`)
    }
  }
  if (!sawTest) throw scriptError(script, 'it does not run node --test')
  if (globs.length === 0) throw scriptError(script, 'it names no test files')
  return { flags, globs }
}

/** `--experimental-strip-types` where Node needs it to run a `.ts` file (before 22.18). */
export function stripFlags(version: string = process.versions.node): string[] {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major < 22 || (major === 22 && minor < 18) ? ['--experimental-strip-types'] : []
}

/** The environment a node:test child needs: its parent's, but not the parent's test context. */
function childEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  return env
}

/**
 * Runs `node --test` over the files, as the package's test script does (`flags`), and returns what
 * it reported. A run where some test fails is still a baseline; a run that reports nothing is not.
 * @internal
 */
export async function recordNodeTest(
  packageDir: string,
  files: readonly string[],
  flags: readonly string[],
): Promise<TestRecord[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'provino-migrate-'))
  try {
    const destination = join(scratch, 'events.jsonl')
    const ended = await runCommandAsync(
      process.execPath,
      [
        ...stripFlags(),
        '--test',
        ...flags,
        `--test-reporter=${REPORTER}`,
        `--test-reporter-destination=${destination}`,
        ...files.map(escapeNodeGlob),
      ],
      { cwd: packageDir, env: childEnv(), timeoutMs: TIMEOUT_MS },
    )
    const text = await readFile(destination, 'utf8').catch(() => '')
    const lines = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ReporterLine)
    if (lines.length === 0) {
      throw new MigrateError(
        'MIGRATE_BASELINE',
        `node --test reported no tests (exit ${String(ended.status)}):\n${ended.output}`,
      )
    }
    return recordsFromReporter(lines, packageDir)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * A path as a pattern for `node --test`, which reads its file arguments as globs and (unlike
 * Provino's) does not take a backslash escape: each special character becomes a one-character class.
 */
export function escapeNodeGlob(path: string): string {
  return path.replaceAll(/[*?[{}()!+@]/g, '[$&]')
}

/** A path as a glob that matches only itself: `[slug].test.ts` is a file, not a character class. */
export function escapeGlob(path: string): string {
  return path.replaceAll(/[\\*?[\]{}()!+@]/g, '\\$&')
}

/**
 * Runs Provino's `run` over exactly the files, with a minimal config written outside the tree
 * (or the `config` given), and returns what its json reporter reported.
 * @internal
 */
export async function recordProvino(options: {
  readonly packageDir: string
  readonly files: readonly string[]
  readonly runner: string
  readonly config: string | undefined
}): Promise<TestRecord[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'provino-migrate-'))
  try {
    let config = options.config
    if (config === undefined) {
      config = join(scratch, 'provino.config.mjs')
      const body = {
        root: options.packageDir,
        include: options.files.map(escapeGlob),
        // The shared base config's values: the 5 s default would fail the long tests the package's own config passes.
        ...SHARED_CONFIG_VALUES,
      }
      await writeFile(config, `export default ${JSON.stringify(body)}\n`)
    }
    const report = join(scratch, 'report.json')
    const ended = await runCommandAsync(
      process.execPath,
      [
        ...stripFlags(),
        ...(options.runner.endsWith('.ts') ? [CONDITIONS_FLAG] : []),
        resolve(options.runner),
        'run',
        '--config',
        resolve(config),
        '--reporter',
        'json',
        '--outputFile',
        report,
      ],
      { cwd: options.packageDir, env: childEnv(), timeoutMs: TIMEOUT_MS },
    )
    let text: string
    try {
      text = await readFile(report, 'utf8')
    } catch (cause) {
      throw new MigrateError(
        'MIGRATE_RUN',
        `Provino wrote no report (exit ${String(ended.status)}):\n${ended.output}`,
        { cause },
      )
    }
    return recordsFromProvino(JSON.parse(text))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
