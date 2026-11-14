// The run's totals per metric, as `istanbul-lib-coverage` sums them (what the text reports and the
// thresholds read).
import type { CoverageMetric, CoverageSummary, CoverageTotals } from '@provino/types'
import type libCoverage from 'istanbul-lib-coverage'

/**
 * The totals of `map`. A metric with nothing to count is 100%, where Istanbul writes `Unknown`.
 * @public
 */
export function coverageTotals(map: libCoverage.CoverageMap): CoverageSummary['totals'] {
  const summary = map.getCoverageSummary()
  const of = (metric: CoverageMetric): CoverageTotals => {
    const { total, covered, pct } = summary[metric]
    return { total, covered, pct: typeof pct === 'number' ? pct : 100 }
  }
  return {
    statements: of('statements'),
    branches: of('branches'),
    functions: of('functions'),
    lines: of('lines'),
  }
}
