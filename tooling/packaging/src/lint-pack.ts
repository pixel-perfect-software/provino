import { binScript, runCommand } from './exec.ts'
import type { PackedPackage } from './pack.ts'

/** One check of one tarball. */
export interface PackProblem {
  readonly tool: 'publint' | 'attw'
  readonly name: string
  readonly output: string
}

/**
 * Runs publint on a tarball: every message, warnings and suggestions too, is a failure (`--strict`
 * makes warnings errors, and a suggestion at level `suggestion` is printed, so output beyond the
 * "All good!" line fails as well).
 * @internal
 */
export function publintTarball(packed: PackedPackage, cwd: string): PackProblem | undefined {
  const result = runCommand(
    process.execPath,
    [binScript('publint', 'publint'), 'run', packed.tarball, '--strict', '--level', 'suggestion'],
    { cwd },
  )
  const clean = result.status === 0 && /All good!/.test(result.output)
  return clean ? undefined : { tool: 'publint', name: packed.name, output: result.output }
}

/**
 * Runs `attw --profile esm-only` on a tarball: how every entry point resolves under the module
 * systems an ESM-only package supports. A package whose only entry point has no types, like a
 * types-only one, still has to resolve.
 * @internal
 */
export function attwTarball(packed: PackedPackage, cwd: string): PackProblem | undefined {
  const result = runCommand(
    process.execPath,
    [
      binScript('@arethetypeswrong/cli', 'attw'),
      '--profile',
      'esm-only',
      '--format',
      'ascii',
      packed.tarball,
    ],
    { cwd },
  )
  return result.status === 0
    ? undefined
    : { tool: 'attw', name: packed.name, output: result.output }
}

/**
 * publint, then attw, on each tarball. Returns every problem, not the first.
 * @internal
 */
export function lintPacks(packs: readonly PackedPackage[], cwd: string): readonly PackProblem[] {
  const problems: PackProblem[] = []
  for (const packed of packs) {
    for (const check of [publintTarball, attwTarball]) {
      const problem = check(packed, cwd)
      if (problem !== undefined) problems.push(problem)
    }
  }
  return problems
}
