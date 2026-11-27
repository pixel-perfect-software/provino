/**
 * @license React
 * react-is 19.3.1, cjs/react-is.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// provino: ported to TypeScript, and only the predicates `pretty-format`'s `ReactElement` plugin calls.

const ELEMENT = Symbol.for('react.transitional.element')
const PORTAL = Symbol.for('react.portal')
const FRAGMENT = Symbol.for('react.fragment')
const STRICT_MODE = Symbol.for('react.strict_mode')
const PROFILER = Symbol.for('react.profiler')
const CONSUMER = Symbol.for('react.consumer')
const CONTEXT = Symbol.for('react.context')
const FORWARD_REF = Symbol.for('react.forward_ref')
const SUSPENSE = Symbol.for('react.suspense')
const SUSPENSE_LIST = Symbol.for('react.suspense_list')
const MEMO = Symbol.for('react.memo')
const LAZY = Symbol.for('react.lazy')
const VIEW_TRANSITION = Symbol.for('react.view_transition')

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
          case VIEW_TRANSITION:
            return type
          default: {
            const typeTypeof = type && type.$$typeof
            switch (typeTypeof) {
              case CONTEXT:
              case FORWARD_REF:
              case LAZY:
              case MEMO:
                return typeTypeof
              case CONSUMER:
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

export const isContextConsumer = (object: unknown): boolean => typeOf(object) === CONSUMER
export const isContextProvider = (object: unknown): boolean => typeOf(object) === CONTEXT
export const isElement = (object: unknown): boolean =>
  typeof object === 'object' && object !== null && (object as any).$$typeof === ELEMENT
export const isForwardRef = (object: unknown): boolean => typeOf(object) === FORWARD_REF
export const isFragment = (object: unknown): boolean => typeOf(object) === FRAGMENT
export const isMemo = (object: unknown): boolean => typeOf(object) === MEMO
export const isSuspense = (object: unknown): boolean => typeOf(object) === SUSPENSE
