// T3.7: the one switch for every code cache. `module.enableCompileCache` (Node's own, for modules
// it compiles) and `createV8Cache` (ours, for the `vm.Script`s the loader compiles) both read it.

/**
 * Whether a code cache may be read and written: `'on'` or `'off'`.
 * @public
 */
export type CacheMode = 'on' | 'off'

/**
 * The cache mode a run needs: `'off'` whenever coverage is on, else `'on'` (build-plan §6, T3.7).
 * With a consumed code cache V8's precise coverage reports block-level ranges only for the
 * functions that were compiled in this run (229 against 542 on the research probe, `local`): a
 * function restored from the cache has no source ranges to report. So one switch turns both the
 * vm cache and Node's native compile cache off when coverage is on.
 * @public
 */
export function cacheModeFor(options: { readonly coverage: boolean }): CacheMode {
  return options.coverage ? 'off' : 'on'
}
