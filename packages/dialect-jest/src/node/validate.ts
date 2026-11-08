// T11.6's validation: what `jest-config` `normalize.ts` L546-L565 runs before normalizing,
// `jest-validate` 30.5.1's `validate` (`validate.ts`) with jest-config's options. Every key is
// checked against the example config: a deprecated key warns with its message, a known key of the
// wrong type throws Jest's error, an unknown key warns with "did you mean" (the first example key
// fewer than 3 edits away). Inside `projects`, a global-only key warns that it belongs in the root
// config instead (`unknownProjectOption`, L72-L105). Known objects are walked, except the keys on
// the deny list. Warnings come back as diagnostics whose message is Jest's `console.warn` text.
import { getType } from '@jest/get-type'
import type { Diagnostic } from '@provino/types'
import { JestConfigError } from './errors.ts'
import {
  DEPRECATION_TITLE,
  DOCUMENTATION_NOTE,
  didYouMean,
  formatValue,
  VALIDATE_ERROR_TITLE,
  validationText,
  WARNING_TITLE,
  warningText,
} from './text.ts'
import {
  exampleValues,
  GLOBAL_ONLY_OPTIONS,
  VALID_CONFIG,
  VALID_PROJECT_CONFIG,
} from './valid-config.ts'

/**
 * `jest-config` `Deprecated.ts` (L19-L107): each deprecated key's message, uncoloured.
 * @internal
 */
export const DEPRECATED_CONFIG: Readonly<Record<string, () => string>> = {
  browser: () =>
    `  Option "browser" has been deprecated. Please install "browser-resolve" and use the "resolver" option in Jest configuration as shown in the documentation: https://jestjs.io/docs/configuration#resolver-string`,
  collectCoverageOnlyFrom:
    () => `  Option "collectCoverageOnlyFrom" was replaced by "collectCoverageFrom".

    Please update your configuration.`,
  extraGlobals: () => `  Option "extraGlobals" was replaced by "sandboxInjectedGlobals".

  Please update your configuration.`,
  init: () =>
    `  Option "init" has been deprecated. Please use "create-jest" package as shown in the documentation: https://jestjs.io/docs/getting-started#generate-a-basic-configuration-file`,
  moduleLoader: () => `  Option "moduleLoader" was replaced by "runtime".

  Please update your configuration.`,
  preprocessorIgnorePatterns:
    () => `  Option "preprocessorIgnorePatterns" was replaced by "transformIgnorePatterns", which support multiple preprocessors.

  Please update your configuration.`,
  scriptPreprocessor:
    () => `  Option "scriptPreprocessor" was replaced by "transform", which support multiple preprocessors.

  Please update your configuration.`,
  setupTestFrameworkScriptFile:
    () => `  Option "setupTestFrameworkScriptFile" was replaced by configuration "setupFilesAfterEnv", which supports multiple paths.

  Please update your configuration.`,
  testPathDirs: () => `  Option "testPathDirs" was replaced by "roots".

  Please update your configuration.
  `,
  testPathPattern: () =>
    [
      'Option "testPathPattern" was replaced by "--testPathPatterns". "--testPathPatterns" is only available as a command-line option.',
      '',
      'Please update your configuration.',
    ]
      .map((line) => `  ${line}`)
      .join('\n'),
  testURL:
    () => `  Option "testURL" was replaced by passing the URL via "testEnvironmentOptions.url".

  Please update your configuration.`,
  timers: () => `  Option "timers" was replaced by "fakeTimers".

  Please update your configuration.`,
}

/** What validation found: warnings, and whether a deprecated key was among them. */
export interface ValidationOutcome {
  readonly diagnostics: readonly Diagnostic[]
  readonly hasDeprecationWarnings: boolean
}

interface Walk {
  readonly isProject: boolean
  readonly denylist: readonly string[]
  readonly diagnostics: Diagnostic[]
  deprecated: boolean
}

const objectTag = Object.prototype.toString

/** `validationConditionSingle` (`condition.ts` L12-L21). */
function matchesExample(option: unknown, example: unknown): boolean {
  return (
    option === null ||
    option === undefined ||
    (typeof option === 'function' && typeof example === 'function') ||
    objectTag.call(option) === objectTag.call(example)
  )
}

function dotted(path: readonly string[], key: string): string {
  return `${path.length > 0 ? `${path.join('.')}.` : ''}${key}`
}

/** `formatPrettyObject` (`jest-validate` `utils.ts` L23-L28). */
function formatPrettyObject(value: unknown): string {
  if (typeof value === 'function') return value.toString()
  if (value === undefined) return 'undefined'
  return (JSON.stringify(value, null, 2) ?? 'undefined').split('\n').join('\n    ')
}

/** `errorMessage` (`jest-validate` `errors.ts` L14-L39): throws Jest's type error. */
function typeError(
  key: string,
  received: unknown,
  example: unknown,
  path: readonly string[],
): never {
  const conditions = exampleValues(example)
  const validTypes = [...new Set(conditions.map(getType))]
  const examples = conditions
    .map(
      (value) => `  {
    "${key}": ${formatPrettyObject(value)}
  }`,
    )
    .join(`

  or

`)
  const message = `  Option "${dotted(path, key)}" must be of type:
    ${validTypes.join(' or ')}
  but instead received:
    ${getType(received)}

  Example:
${examples}`
  throw new JestConfigError(
    'JEST_CONFIG_INVALID',
    validationText(VALIDATE_ERROR_TITLE, message, DOCUMENTATION_NOTE),
  )
}

function warn(walk: Walk, code: string, key: string, title: string, message: string): void {
  walk.diagnostics.push({
    level: 'warning',
    code,
    key,
    message: warningText(title, message, DOCUMENTATION_NOTE),
  })
}

/** `unknownOptionWarning` (`warnings.ts`) and, in a project, `unknownProjectOption`. */
function unknownOption(
  walk: Walk,
  config: Readonly<Record<string, unknown>>,
  example: Readonly<Record<string, unknown>>,
  key: string,
  path: readonly string[],
): void {
  const name = dotted(path, key)
  if (walk.isProject && path.length === 0 && GLOBAL_ONLY_OPTIONS.has(key)) {
    warn(
      walk,
      'JEST_CONFIG_GLOBAL_ONLY_OPTION',
      name,
      WARNING_TITLE,
      `  Option "${name}" is not supported in an individual project configuration.\n  Move it to the root configuration.`,
    )
    return
  }
  const suggestion = didYouMean(key, Object.keys(example))
  warn(
    walk,
    'JEST_CONFIG_UNKNOWN_OPTION',
    name,
    WARNING_TITLE,
    `  Unknown option "${name}" with value ${formatValue(config[key])} was found.${
      suggestion && ` ${suggestion}`
    }\n  This is probably a typing mistake. Fixing it will remove this message.`,
  )
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

/** `_validate` (`validate.ts` L19-L84). */
function walkConfig(walk: Walk, config: unknown, example: unknown, path: readonly string[]): void {
  if (!isObject(config) || !isObject(example)) return
  for (const key in config) {
    const skip = walk.denylist.includes([...path, key].join('.'))
    const value: unknown = config[key]
    const deprecation = DEPRECATED_CONFIG[key]
    if (Object.hasOwn(DEPRECATED_CONFIG, key) && deprecation !== undefined) {
      walk.deprecated = true
      walk.diagnostics.push({
        level: 'warning',
        code: 'JEST_CONFIG_DEPRECATED_OPTION',
        key: dotted(path, key),
        message: warningText(DEPRECATION_TITLE, deprecation(), DOCUMENTATION_NOTE),
      })
    } else if (Object.hasOwn(example, key)) {
      if (key === 'maxWorkers') {
        if (typeof value !== 'number' && typeof value !== 'string') {
          throw new JestConfigError(
            'JEST_CONFIG_INVALID',
            validationText(
              'Validation Error',
              `${key} has to be of type string or number`,
              'maxWorkers=50% or\nmaxWorkers=3',
            ),
          )
        }
      } else if (!exampleValues(example[key]).some((option) => matchesExample(value, option))) {
        typeError(key, value, example[key], path)
      }
    } else if (!skip) {
      unknownOption(walk, config, example, key, path)
    }
    if (!Array.isArray(example[key]) && !skip) {
      walkConfig(walk, value, example[key], [...path, key])
    }
  }
}

/**
 * Validates a config's keys as Jest 30.5 does before normalizing it. `isProject` is a config read
 * only as one of `projects` (Jest's `isProjectOptions`): its table is the project one, and a
 * global-only key gets the "move it to the root configuration" warning. Throws `JestConfigError`
 * (`JEST_CONFIG_INVALID`, Jest's text) for a known key of the wrong type.
 * @public
 */
export function validateJestConfig(
  options: Readonly<Record<string, unknown>>,
  isProject: boolean,
): ValidationOutcome {
  const walk: Walk = {
    isProject,
    denylist: [
      // jest-validate's own default (`defaultConfig.ts` L25), then jest-config's (L554-L563).
      '//',
      ...(isProject ? [] : ['coverageThreshold']),
      'globals',
      'moduleNameMapper',
      'testEnvironmentOptions',
      'transform',
    ],
    diagnostics: [],
    deprecated: false,
  }
  walkConfig(walk, options, isProject ? VALID_PROJECT_CONFIG : VALID_CONFIG, [])
  return { diagnostics: walk.diagnostics, hasDeprecationWarnings: walk.deprecated }
}
