// Runs a TypeScript compiler over a throwaway project inside this package, so `@provino/lazy`
// resolves through the package's own `exports` (the `provino-source` condition) as it does for
// the real type tests.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The two compilers every type check runs on. */
export type Compiler = 'typescript' | 'typescript-5.9'
export const COMPILERS: readonly Compiler[] = ['typescript', 'typescript-5.9']

const here = dirname(fileURLToPath(import.meta.url))
const testDir = resolve(here, '..')

/** One compiler error: its code and its whole message, continuation lines joined by a space. */
export interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly code: string
  readonly message: string
}

export interface TscResult {
  readonly diagnostics: readonly Diagnostic[]
  readonly stdout: string
  readonly status: number | null
}

/** The `bin/tsc` of a compiler, found in the nearest `node_modules` above this file. */
export function compilerBin(compiler: Compiler): string {
  let dir = here
  for (;;) {
    const candidate = join(dir, 'node_modules', compiler, 'bin', 'tsc')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `the ${compiler} compiler is not installed (looked for node_modules/${compiler}/bin/tsc above ${here})`,
      )
    }
    dir = parent
  }
}

const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

/** Reads `tsc --pretty false` output: an error line, then indented lines that continue it. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const found: Array<{ -readonly [K in keyof Diagnostic]: Diagnostic[K] }> = []
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line)
    if (match !== null) {
      found.push({
        file: match[1] ?? '',
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4] ?? '',
        message: match[5] ?? '',
      })
    } else if (/^\s+\S/.test(line)) {
      const last = found.at(-1)
      if (last !== undefined) {
        last.message = `${last.message} ${line.trim()}`
      }
    }
  }
  return found
}

/**
 * Compiles `files` (name to source, written side by side in a temporary directory under `test/`)
 * with the strict options of `tsconfig.base.json`, no emit, and returns what the compiler said.
 */
export function compileFiles(
  compiler: Compiler,
  files: Readonly<Record<string, string>>,
  extraArgs: readonly string[] = [],
): TscResult {
  const dir = mkdtempSync(join(testDir, '.tsc-'))
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source)
    }
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../../../tsconfig.base.json',
        compilerOptions: {
          noEmit: true,
          rootDir: '../../..',
          composite: false,
          declaration: false,
          declarationMap: false,
          emitDeclarationOnly: false,
          isolatedDeclarations: false,
        },
        include: Object.keys(files),
      }),
    )
    const run = spawnSync(
      process.execPath,
      [compilerBin(compiler), '-p', join(dir, 'tsconfig.json'), '--pretty', 'false', ...extraArgs],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (run.error !== undefined) {
      throw run.error
    }
    return {
      diagnostics: parseDiagnostics(run.stdout),
      stdout: run.stdout,
      status: run.status,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
