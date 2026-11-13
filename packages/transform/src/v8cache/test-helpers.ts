// Helpers for the V8 cache tests: the scripts they compile, and a fresh child process to run a
// scenario in. V8 keeps a compilation cache per isolate, so whether a code cache was read or
// refused (and what coverage reports for a script compiled from one) can only be seen in a process
// that hasn't compiled the same text before. Not part of the package's exports.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The name the test scripts are compiled under. */
export const SCRIPT_NAME = '/virtual/provino-v8cache-test.js'

/**
 * A script of `count` functions, each with a branch, of which the top level calls every tenth. Its
 * value is a number that depends on `count`, so a test can tell a script that ran from one that
 * didn't. The text is the same for the same `count`.
 */
export function manyFunctions(count: number): string {
  const names = Array.from({ length: count }, (_, i) => `fn${i}`)
  const declarations = names.map(
    (name, i) => `function ${name}(a) { if (a > ${i}) { return a * 2 } else { return a + ${i} } }`,
  )
  return [
    '(function () {',
    ...declarations,
    `const fns = [${names.join(', ')}]`,
    'let total = 0',
    `for (let i = 0; i < ${count}; i += 10) { total += fns[i](i + 1) }`,
    'return total',
    '})()',
  ].join('\n')
}

/** What `manyFunctions(count)` evaluates to. */
export function manyFunctionsValue(count: number): number {
  let total = 0
  // `fns[i](i + 1)` takes the `a > i` branch: `(i + 1) * 2`.
  for (let i = 0; i < count; i += 10) total += (i + 1) * 2
  return total
}

/** A temporary directory, and a function that removes it. */
export function tempDir(): { readonly dir: string; readonly remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'provino-v8cache-test-'))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

const CHILD = fileURLToPath(new URL('./test-child.ts', import.meta.url))

export interface ChildOptions {
  /** Extra node flags before the script (a V8 flag changes the cache tag). */
  readonly execArgv?: readonly string[]
  /** Environment variables to set (a string) or remove (`undefined`) from this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Runs `command` of `test-child.ts` with `scenario` (JSON) in a fresh node process and returns the
 * JSON it printed. The child is waited for, so none outlives the call.
 */
export function runChild(command: string, scenario: object, options: ChildOptions = {}): unknown {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const result = spawnSync(
    process.execPath,
    [
      ...(options.execArgv ?? []),
      '--conditions=provino-source',
      CHILD,
      command,
      JSON.stringify(scenario),
    ],
    { encoding: 'utf8', env, timeout: 60_000 },
  )
  if (result.status !== 0) {
    throw new Error(
      `test-child ${command} exited ${result.status ?? result.signal}:\n${result.stderr}${result.stdout}`,
    )
  }
  return JSON.parse(result.stdout)
}
