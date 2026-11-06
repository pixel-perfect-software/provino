import type { DefineHoistPolicy, Dialect, HoistPolicy } from '@provino/types'

/**
 * Defines a dialect's mock-hoisting policy, keeping the literal names of its hoisted calls and
 * values so a typo in adapter code is a compile error (Track 3 L563). The value is returned
 * unchanged.
 * @public
 */
export const defineHoistPolicy: DefineHoistPolicy = <
  const Calls extends string,
  const Values extends string = never,
>(
  policy: HoistPolicy<Calls, Values>,
): HoistPolicy<Calls, Values> => policy

/**
 * Defines a dialect, keeping its name as a literal type. Under `isolatedDeclarations`, annotate
 * the export: `export const jest: Dialect<'jest', JestOptions> = defineDialect({...})`.
 * @public
 */
export function defineDialect<const Name extends string, Options = undefined>(
  dialect: Dialect<Name, Options>,
): Dialect<Name, Options> {
  return dialect
}
