// The mock-hoisting step (Track 3 R1 step 3). B05 leaves it a no-op hook point; T3.4 (B13b)
// fills it with the oxc hoister, behind a `mock(` prefilter (§6 "Gates").
import type { HoistPolicy, SourceMapV3, StaticMockCall } from '@provino/types'

/** What the hoist step hands to the next step. */
export interface HoistOutput {
  readonly code: string
  /** `null` when the step didn't move code. */
  readonly map: SourceMapV3 | null
  readonly staticMocks: readonly StaticMockCall[]
}

/** Hoists mock calls in `code` under `policy`. A no-op until T3.4. */
export function hoistMocks(code: string, _policy: HoistPolicy): HoistOutput {
  return { code, map: null, staticMocks: [] }
}
