// T6.3's guard: a chain of N `.let`s, three overrides and N reads must compile with no error and
// within a budget of type instantiations on both compilers. The Oct 29 `Omit & Record` encoding
// failed at 50 with TS2589; the flat intersection is what keeps 60 cheap.
import { type Compiler, compileFiles } from './tsc.ts'

/** T6.3's bar at N = 60. */
export const MAX_INSTANTIATIONS = 150_000
export const DEFAULT_LETS = 60

/** The source of a chain of `lets` definitions (each reads the one before), three overrides, and a read of every key. */
export function generateChain(lets: number): string {
  const lines: string[] = ["import { lazy } from '@provino/lazy'", '', 'const $ = lazy']
  for (let i = 0; i < lets; i += 1) {
    lines.push(
      i === 0
        ? "  .let('k0', () => ({ n: 0, label: 'k0' }))"
        : `  .let('k${i}', ({ k${i - 1} }) => ({ n: k${i - 1}.n + 1, label: 'k${i}' }))`,
    )
  }
  const overridden = [Math.floor(lets / 4), Math.floor(lets / 2), Math.floor((lets * 3) / 4)]
  lines.push('')
  lines.push('const $over = $')
  for (const index of overridden) {
    lines.push(
      `  .override('k${index}', (_deps, ctx) => ({ n: ctx.parent().n + 1, label: 'o${index}' }))`,
    )
  }
  lines.push('')
  for (let i = 0; i < lets; i += 1) {
    lines.push(`export const r${i}: number = $over.k${i}.n`)
  }
  lines.push('')
  return lines.join('\n')
}

export interface TypePerf {
  readonly compiler: Compiler
  readonly lets: number
  readonly errors: number
  readonly instantiations: number
}

/** `Instantiations:` in TS 5.9's `--extendedDiagnostics`, and the label TS 7 prints. */
export function parseInstantiations(output: string): number | undefined {
  const match = /^\s*Instantiations:\s+(\d+)\s*$/m.exec(output)
  return match === null ? undefined : Number(match[1])
}

/** Compiles the chain of `lets` and reports its errors and instantiations; throws when the count is not printed. */
export function measure(compiler: Compiler, lets: number): TypePerf {
  const result = compileFiles(compiler, { 'chain.ts': generateChain(lets) }, [
    '--extendedDiagnostics',
  ])
  const instantiations = parseInstantiations(result.stdout)
  if (instantiations === undefined) {
    throw new Error(`${compiler} printed no "Instantiations:" line:\n${result.stdout}`)
  }
  return { compiler, lets, errors: result.diagnostics.length, instantiations }
}

/** The problems with a measurement against a budget of `max` instantiations; empty when it is within it. */
export function budgetProblems(result: TypePerf, max: number = MAX_INSTANTIATIONS): string[] {
  const problems: string[] = []
  if (result.errors > 0) {
    problems.push(`${result.compiler}: ${result.errors} compile errors at ${result.lets} lets`)
  }
  if (result.instantiations > max) {
    problems.push(
      `${result.compiler}: ${result.instantiations} instantiations at ${result.lets} lets is over ${max}`,
    )
  }
  return problems
}
