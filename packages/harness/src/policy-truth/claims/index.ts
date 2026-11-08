// Every claim, by leaf or group path (T1.7). One file per slice; `policy-truth.test.ts` reads this.
import type { Claims } from '../evidence.ts'
import { coreClaims, lazyClaims } from './core.ts'
import { mockClaims } from './mock.ts'
import { hoistClaims, moduleClaims } from './module.ts'
import { coverageClaims, globalsClaims, orchestratorClaims, reportClaims } from './orchestrator.ts'
import { expectClaims, snapshotClaims } from './snapshot.ts'
import { timersClaims } from './timers.ts'

/** The claims of every slice, the hoisting rules and the globals' names. */
export const CLAIMS: Claims = {
  ...coreClaims,
  ...lazyClaims,
  ...mockClaims,
  ...timersClaims,
  ...moduleClaims,
  ...hoistClaims,
  ...snapshotClaims,
  ...expectClaims,
  ...orchestratorClaims,
  ...reportClaims,
  ...coverageClaims,
  ...globalsClaims,
}
