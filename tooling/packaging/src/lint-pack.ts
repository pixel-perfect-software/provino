import { binScript, type CommandResult, runCommand, runCommandAsync } from './exec.ts'
import type { PackedPackage } from './pack.ts'

/** One check of one tarball. */
export interface PackProblem {
  readonly tool: 'publint' | 'attw'
  readonly name: string
  readonly output: string
}

/** The two linters, each as the command it runs on a tarball and how it reads the result. */
const LINTS = {
  /**
   * publint: every message, warnings and suggestions too, is a failure (`--strict` makes
   * warnings errors, and a suggestion at level `suggestion` is printed, so output beyond the
   * "All good!" line fails as well).
   */
  publint: {
    args: (packed: PackedPackage) => [
      binScript('publint', 'publint'),
      'run',
      packed.tarball,
      '--strict',
      '--level',
      'suggestion',
    ],
    clean: (result: CommandResult) => result.status === 0 && /All good!/.test(result.output),
  },
  /**
   * `attw --profile esm-only`: how every entry point resolves under the module systems an
   * ESM-only package supports. A package whose only entry point has no types, like a types-only
   * one, still has to resolve.
   */
  attw: {
    args: (packed: PackedPackage) => [
      binScript('@arethetypeswrong/cli', 'attw'),
      '--profile',
      'esm-only',
      '--format',
      'ascii',
      packed.tarball,
    ],
    clean: (result: CommandResult) => result.status === 0,
  },
} as const

type Tool = keyof typeof LINTS

function problem(
  tool: Tool,
  packed: PackedPackage,
  result: CommandResult,
): PackProblem | undefined {
  return LINTS[tool].clean(result) ? undefined : { tool, name: packed.name, output: result.output }
}

/**
 * Runs publint on a tarball.
 * @internal
 */
export function publintTarball(packed: PackedPackage, cwd: string): PackProblem | undefined {
  const result = runCommand(process.execPath, LINTS.publint.args(packed), { cwd })
  return problem('publint', packed, result)
}

/**
 * Runs `attw --profile esm-only` on a tarball.
 * @internal
 */
export function attwTarball(packed: PackedPackage, cwd: string): PackProblem | undefined {
  const result = runCommand(process.execPath, LINTS.attw.args(packed), { cwd })
  return problem('attw', packed, result)
}

/**
 * publint, then attw, on one tarball, beside other work. Returns every problem, not the first.
 * @internal
 */
export async function lintPackAsync(
  packed: PackedPackage,
  cwd: string,
): Promise<readonly PackProblem[]> {
  const problems: PackProblem[] = []
  for (const tool of ['publint', 'attw'] as const) {
    const result = await runCommandAsync(process.execPath, LINTS[tool].args(packed), { cwd })
    const found = problem(tool, packed, result)
    if (found !== undefined) problems.push(found)
  }
  return problems
}
