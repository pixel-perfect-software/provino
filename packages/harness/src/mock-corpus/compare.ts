// What B13a's corpus check asks of a run: each case (one `observe` line, named by its `id`) is the
// golden's text exactly. One function, so the comparison is itself under unit test.

/** One case of a fixture under one profile. */
export interface CaseResult {
  readonly id: string
  readonly matches: boolean
  /** The golden's line, or `undefined` for a case the run made that the golden lacks. */
  readonly want: string | undefined
  /** The run's line, or `undefined` for a case the golden has that the run never made. */
  readonly got: string | undefined
}

/** The `id` of an observation line, or the whole line when it is not one. */
export function caseId(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      const { id } = parsed
      if (typeof id === 'string') return id
    }
  } catch {
    // Not JSON: the text names itself.
  }
  return line
}

/**
 * Pairs the golden's lines with the run's by case id, in the golden's order, then the run's extra
 * cases. A case is listed once; a repeated id is a fixture bug and throws.
 */
export function compareObservations(
  golden: readonly string[],
  run: readonly string[],
): CaseResult[] {
  const byId = (lines: readonly string[], label: string): Map<string, string> => {
    const map = new Map<string, string>()
    for (const line of lines) {
      const id = caseId(line)
      if (map.has(id)) throw new Error(`the ${label} observes "${id}" twice`)
      map.set(id, line)
    }
    return map
  }
  const wanted = byId(golden, 'golden')
  const got = byId(run, 'run')
  const results: CaseResult[] = []
  for (const [id, want] of wanted) {
    const line = got.get(id)
    results.push({ id, matches: line === want, want, got: line })
  }
  for (const [id, line] of got) {
    if (!wanted.has(id)) results.push({ id, matches: false, want: undefined, got: line })
  }
  return results
}
