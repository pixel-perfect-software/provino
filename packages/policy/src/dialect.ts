import type { Dialect } from '@provino/types'

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
