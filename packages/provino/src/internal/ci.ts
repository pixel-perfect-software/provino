/**
 * Whether `env` says this is a CI run: `CI` is set to something other than empty, `0` or `false`,
 * ignoring case and surrounding spaces (as ci-info reads it). `run()` resolves a run's `ci` with
 * this and hands the answer to the reporters, so they and the run never disagree.
 * @internal
 */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}
