// The Spikes C check (T6.5): every behaviour under every policy, on the real core. The result is
// the one JSON line `{"checks":N,"failed":F}` that the spike printed.
import { BEHAVIOURS } from './behaviours.ts'
import { VARIANTS } from './run.ts'

/** One behaviour under one policy. */
export interface CheckResult {
  readonly behaviour: string
  readonly policy: string
  readonly ok: boolean
  /** The failure, when it did not pass. */
  readonly failure: string | undefined
}

/** What a check run found. */
export interface CheckSummary {
  readonly checks: number
  readonly failed: number
  readonly results: readonly CheckResult[]
}

/** Runs every behaviour under every policy, one after another. */
export async function runLazyCheck(): Promise<CheckSummary> {
  const results: CheckResult[] = []
  for (const behaviour of BEHAVIOURS) {
    for (const variant of VARIANTS) {
      try {
        await behaviour.check(variant.policy)
        results.push({
          behaviour: behaviour.name,
          policy: variant.name,
          ok: true,
          failure: undefined,
        })
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        results.push({ behaviour: behaviour.name, policy: variant.name, ok: false, failure })
      }
    }
  }
  return { checks: results.length, failed: results.filter((r) => !r.ok).length, results }
}
