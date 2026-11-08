// The mock-hoisting step (Track 3 R1 step 3, T3.4): one engine driven entirely by a `HoistPolicy`.
// It never names a runner. `hoistMocks` is pure: it reads nothing but its arguments.
import type { HoistPolicy, SourceMapV3, StaticMockCall, TransformDiagnostic } from '@provino/types'
import { analyse } from './analyse.ts'
import { applyHoist } from './apply.ts'
import { parseForHoist } from './parse.ts'
import { prefilterFor } from './prefilter.ts'

/**
 * What {@link hoistMocks} needs beyond the code and the policy.
 * @public
 */
export interface HoistOptions {
  /** The file the code came from: for parsing and for diagnostics. */
  readonly filename: string
  /**
   * The source before the transform that produced `code` (JSX, TypeScript). A name a mock
   * factory reads that is generated (`_jsxDEV`, a lowering helper) is absent from it, and is not
   * an out-of-scope reference: real Jest's plugin sees the code before it is lowered. Without it,
   * nothing extra is allowed.
   */
  readonly original?: string
}

/**
 * What the hoist step hands to the next step.
 * @public
 */
export interface HoistOutput {
  readonly code: string
  /** `null` when the step didn't move code. */
  readonly map: SourceMapV3 | null
  /** Hoisted mock calls with literal specifiers, in source order. */
  readonly staticMocks: readonly StaticMockCall[]
  /** Hoisting violations (`HOIST_*`), which fail the file as a real runner's transform would. */
  readonly diagnostics: readonly TransformDiagnostic[]
  /** Whether static imports became `await import()` (D36), so the code has top-level await. */
  readonly rewroteImports: boolean
}

/**
 * Hoists mock calls in `code` under `policy`. A pure function: it reads nothing but its arguments.
 * `code` is JavaScript (the pipeline's stripped output). On any error, including a failure of the
 * step itself, the code comes back unchanged, with the errors as diagnostics: it never throws.
 * @public
 */
export function hoistMocks(code: string, policy: HoistPolicy, options: HoistOptions): HoistOutput {
  const unchanged: HoistOutput = {
    code,
    map: null,
    staticMocks: [],
    diagnostics: [],
    rewroteImports: false,
  }
  try {
    const prefilter = prefilterFor(policy)
    if (prefilter === null || !prefilter.test(code)) return unchanged

    const parsed = parseForHoist(options.filename, code)
    if (!parsed.ok) return { ...unchanged, diagnostics: parsed.diagnostics }

    const { program } = parsed
    const analysis = analyse(code, program, policy, options.original)
    if (analysis.diagnostics.length > 0) return { ...unchanged, diagnostics: analysis.diagnostics }

    const applied = applyHoist(code, options.filename, policy, program, analysis)
    if (applied === null) return unchanged
    return {
      code: applied.code,
      map: applied.map,
      staticMocks: analysis.staticMocks,
      diagnostics: [],
      rewroteImports: applied.rewroteImports,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ...unchanged,
      diagnostics: [
        {
          severity: 'error',
          code: 'TRANSFORMER_FAILED',
          message: `Hoisting mocks in ${options.filename} failed: ${reason}`,
        },
      ],
    }
  }
}
