import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { NeutralProject, SerializedTransformConfig, TransformClaims } from '@provino/types'
import { ConfigError } from '../errors.ts'
import { describe, messageOf } from './input.ts'

/** A pattern that doesn't compile is a config error here, not a failure in every worker. */
function assertRegExp(source: string, path: string): void {
  try {
    new RegExp(source)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${path} is not a regular expression: ${messageOf(cause)}`,
      { cause },
    )
  }
}

/**
 * Checks `transformIgnorePatterns`: each pattern, then all of them joined with `|`, the one regular
 * expression Jest builds (`ScriptTransformer.ts` `calcIgnorePatternRegExp`, L1072-L1081) and the
 * loader and a transformer host build, whether or not a transform is configured. Two patterns that
 * compile alone can fail joined (`\k<b>` and `(?<a>x)`: the second makes the first a reference to
 * a group that isn't there). Jest fails every test file on it; here it is one config error.
 */
function assertIgnorePatterns(neutral: NeutralProject): void {
  const patterns = neutral.transformIgnorePatterns
  patterns.forEach((pattern, index) => {
    assertRegExp(pattern, `transformIgnorePatterns[${index}]`)
  })
  if (patterns.length > 1) {
    assertRegExp(
      patterns.join('|'),
      'transformIgnorePatterns (joined with "|", as Jest joins them)',
    )
  }
}

/**
 * Ignore patterns that match every path with a `node_modules` directory in it (Jest's default is
 * `/node_modules/`): with one, no `node_modules` file is any transform's, so there are no claims to
 * ask a worker about.
 */
const IGNORES_EVERY_PACKAGE: ReadonlySet<string> = new Set([
  '/node_modules/',
  '/node_modules',
  'node_modules/',
  'node_modules',
])

/**
 * A transformer's module as the absolute path a worker can import (D21). A path stays as it is; a
 * package name (a transformer a dialect left bare, such as Jest's own `babel-jest` with no Jest
 * install to resolve it from) resolves from the project's root, as a transformer is the project's
 * own dependency.
 */
function resolveTransformer(module: string, rootDir: string, path: string): string {
  if (isAbsolute(module) || module.startsWith('file:')) return module
  try {
    return createRequire(join(rootDir, 'noop.js')).resolve(module)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${path}: cannot resolve the transformer ${describe(module)} from ${rootDir}: ${messageOf(cause)}`,
      { cause },
    )
  }
}

/**
 * The project's `transform` entries as the worker's `SerializedTransformConfig` (T3.8), or
 * `undefined` for a project with none, whose every file takes the Oxc pipeline. It checks
 * `transformIgnorePatterns` first (`assertIgnorePatterns`), for `resolveTransformClaims` too, which
 * a project resolves after it.
 * @internal
 */
export function resolveTransforms(neutral: NeutralProject): SerializedTransformConfig | undefined {
  assertIgnorePatterns(neutral)
  if (neutral.transforms.length === 0) return undefined
  return {
    rules: neutral.transforms.map((rule, index) => {
      const path = `transform[${index}]`
      assertRegExp(rule.pattern, `${path}.pattern`)
      return {
        pattern: rule.pattern,
        transformer: {
          module: resolveTransformer(rule.module, neutral.rootDir, path),
          export: 'default',
        },
        options: rule.options,
      }
    }),
    ignorePatterns: neutral.transformIgnorePatterns,
    config: neutral.transformConfig ?? {},
    hoistedMarkers: [...(neutral.transformHoistedMarkers ?? [])],
  }
}

/**
 * The files the project's transforms take (`SerializedLoaderConfig.transformClaims`): the rules'
 * patterns and the ones Provino's pipeline stands in for (`standInTransformPatterns`), with
 * `transformIgnorePatterns`. `undefined` for a project with no transform, whose `node_modules`
 * files are all loaded by Node, and for one whose ignore patterns take every `node_modules` file
 * out (Jest's default `/node_modules/`), where a worker has nothing to ask. The stand-in patterns
 * are checked here; the ignore patterns by `resolveTransforms`, which runs first.
 * @internal
 */
export function resolveTransformClaims(neutral: NeutralProject): TransformClaims | undefined {
  const standIns = neutral.standInTransformPatterns ?? []
  standIns.forEach((pattern, index) => {
    assertRegExp(pattern, `standInTransformPatterns[${index}]`)
  })
  if (neutral.transforms.length === 0 && standIns.length === 0) return undefined
  if (neutral.transformIgnorePatterns.some((pattern) => IGNORES_EVERY_PACKAGE.has(pattern))) {
    return undefined
  }
  return {
    patterns: [...neutral.transforms.map((rule) => rule.pattern), ...standIns],
    ignorePatterns: neutral.transformIgnorePatterns,
  }
}
