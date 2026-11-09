/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Jest 30.5.2, packages/jest-snapshot/src/utils.ts L25-L135: how `toMatchSnapshot({ id: expect.any(Number) })`
 * merges the property matchers into the received value before it is serialized.
 */

// provino: ported to TypeScript under `noImplicitAny` (`unknown` and a record type in place of
// `any`); the logic is Jest's.
type Dict = Record<string, unknown>

function isObject(item: unknown): item is Dict {
  return item != null && typeof item === 'object' && !Array.isArray(item)
}

function isAnyOrAnything(input: object): boolean {
  return (
    '$$typeof' in input &&
    input.$$typeof === Symbol.for('jest.asymmetricMatcher') &&
    ['Any', 'Anything'].includes(input.constructor.name)
  )
}

function deepMergeArray(target: readonly unknown[], source: readonly unknown[]): unknown[] {
  const mergedOutput = [...target]

  for (const [index, sourceElement] of source.entries()) {
    const targetElement = mergedOutput[index]

    if (Array.isArray(target[index]) && Array.isArray(sourceElement)) {
      mergedOutput[index] = deepMergeArray(target[index] as unknown[], sourceElement)
    } else if (isObject(targetElement) && !isAnyOrAnything(sourceElement as object)) {
      mergedOutput[index] = deepMerge(target[index], sourceElement)
    } else {
      // Source does not exist in target or target is primitive and cannot be deep merged
      mergedOutput[index] = sourceElement
    }
  }

  return mergedOutput
}

/**
 * Merges `source` (a snapshot's property matchers) into `target` (the received value).
 * @public
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (isObject(target) && isObject(source)) {
    const mergedOutput: Dict = { ...target }

    for (const key of Object.keys(source)) {
      const value = source[key]
      if (isObject(value) && !value.$$typeof) {
        if (key in target) {
          mergedOutput[key] = deepMerge(target[key], value)
        } else {
          Object.assign(mergedOutput, { [key]: value })
        }
      } else if (Array.isArray(value)) {
        mergedOutput[key] = deepMergeArray(target[key] as unknown[], value)
      } else {
        Object.assign(mergedOutput, { [key]: value })
      }
    }

    return mergedOutput
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    return deepMergeArray(target, source)
  }

  return target
}
