/**
 * @license React
 * react-is 18.3.1, cjs/react-is.production.min.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// provino: ported to TypeScript, and only the predicates `pretty-format`'s `ReactElement` plugin calls.

const ELEMENT = Symbol.for('react.element')
const PORTAL = Symbol.for('react.portal')
const FRAGMENT = Symbol.for('react.fragment')
const STRICT_MODE = Symbol.for('react.strict_mode')
const PROFILER = Symbol.for('react.profiler')
const PROVIDER = Symbol.for('react.provider')
const CONTEXT = Symbol.for('react.context')
const SERVER_CONTEXT = Symbol.for('react.server_context')
const FORWARD_REF = Symbol.for('react.forward_ref')
const SUSPENSE = Symbol.for('react.suspense')
const SUSPENSE_LIST = Symbol.for('react.suspense_list')
const MEMO = Symbol.for('react.memo')
const LAZY = Symbol.for('react.lazy')

function typeOf(object: any): unknown {
  if (typeof object === 'object' && object !== null) {
    const $$typeof = object.$$typeof
    switch ($$typeof) {
      case ELEMENT: {
        const type = object.type
        switch (type) {
          case FRAGMENT:
          case PROFILER:
          case STRICT_MODE:
          case SUSPENSE:
          case SUSPENSE_LIST:
            return type
          default: {
            const typeTypeof = type && type.$$typeof
            switch (typeTypeof) {
              case SERVER_CONTEXT:
              case CONTEXT:
              case FORWARD_REF:
              case LAZY:
              case MEMO:
              case PROVIDER:
                return typeTypeof
              default:
                return $$typeof
            }
          }
        }
      }
      case PORTAL:
        return $$typeof
    }
  }
  return undefined
}

export const isContextConsumer = (object: unknown): boolean => typeOf(object) === CONTEXT
export const isContextProvider = (object: unknown): boolean => typeOf(object) === PROVIDER
export const isElement = (object: unknown): boolean =>
  typeof object === 'object' && object !== null && (object as any).$$typeof === ELEMENT
export const isForwardRef = (object: unknown): boolean => typeOf(object) === FORWARD_REF
export const isFragment = (object: unknown): boolean => typeOf(object) === FRAGMENT
export const isMemo = (object: unknown): boolean => typeOf(object) === MEMO
export const isSuspense = (object: unknown): boolean => typeOf(object) === SUSPENSE
