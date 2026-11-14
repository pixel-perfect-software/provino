// The Istanbul instrumenter, behind a dynamic import: a worker uses it for the files its tests load,
// the coordinator for the files no test loaded (Jest's `generateEmptyCoverage`).

/**
 * The Istanbul instrumenter and the initial-coverage reader, loaded on demand: they bring the
 * parser and the code writer, which a process running V8 coverage (or none) never loads.
 * @public
 */
export async function loadInstrumenter(): Promise<{
  readonly istanbulInstrumenter: typeof import('./instrument.ts').istanbulInstrumenter
  readonly readInitialCoverage: typeof import('./initial-coverage.ts').readInitialCoverage
}> {
  const [{ istanbulInstrumenter }, { readInitialCoverage }] = await Promise.all([
    import('./instrument.ts'),
    import('./initial-coverage.ts'),
  ])
  return { istanbulInstrumenter, readInitialCoverage }
}
