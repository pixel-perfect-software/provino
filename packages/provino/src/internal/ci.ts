/**
 * Whether `env` says this is a CI run: `CI` is set to something other than the empty string,
 * `false` or `0`.
 * @internal
 */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI
  return value !== undefined && value !== '' && value !== 'false' && value !== '0'
}
