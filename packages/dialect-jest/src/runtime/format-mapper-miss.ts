// jest-resolve 30.5.2 `createNoMappedModuleFoundError` (`resolver.ts` L1024-L1052): the text of a
// `moduleNameMapper` rule that matched with no target resolving. Recorded: `resolve/mapper-miss`.
import type { FormatMapperMiss } from '@provino/types'

/**
 * jest-resolve prints a one-element target list as that target, and a longer one as JSON, nested
 * one level below the config object's key so its brackets line up there.
 * @public
 */
export const formatMapperMiss: FormatMapperMiss = ({
  specifier,
  rule,
  declared,
  tried,
  resolver,
}) => {
  const single = declared.length === 1 ? declared[0] : undefined
  const target = single ?? JSON.stringify(tried, null, 2)
  const configured = single ?? `${JSON.stringify(declared, null, 6).slice(0, -1)}    ]`
  return [
    'Configuration error:',
    '',
    `Could not locate module ${specifier} mapped as:`,
    `${target}.`,
    '',
    'Please check your configuration for these entries:',
    '{',
    '  "moduleNameMapper": {',
    `    "${rule}": "${configured}"`,
    '  },',
    `  "resolver": ${resolver ?? 'undefined'}`,
    '}',
  ].join('\n')
}
