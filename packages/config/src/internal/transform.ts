import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { NeutralProject, SerializedTransformConfig } from '@provino/types'
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
 * `undefined` for a project with none, whose every file takes the Oxc pipeline.
 * @internal
 */
export function resolveTransforms(neutral: NeutralProject): SerializedTransformConfig | undefined {
  if (neutral.transforms.length === 0) return undefined
  neutral.transformIgnorePatterns.forEach((pattern, index) => {
    assertRegExp(pattern, `transformIgnorePatterns[${index}]`)
  })
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
    ignorePatterns: [...neutral.transformIgnorePatterns],
    config: neutral.transformConfig ?? {},
    hoistedMarkers: [...(neutral.transformHoistedMarkers ?? [])],
  }
}
