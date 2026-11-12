// The public API of @provino/env-jsdom.
import {
  JsdomEnvironmentError,
  type JsdomEnvironmentErrorCode,
  type JsdomEnvironmentOptions,
  jsdomEnvironment,
} from '@provino/env-jsdom'
import type {
  Environment,
  EnvironmentInstance,
  EnvironmentOptionsMap,
  EnvironmentRealm,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(jsdomEnvironment).toEqualTypeOf<Environment<'jsdom', JsdomEnvironmentOptions>>()
expectTypeOf(jsdomEnvironment.name).toEqualTypeOf<'jsdom'>()
expectTypeOf(jsdomEnvironment.realms).toEqualTypeOf<readonly EnvironmentRealm[]>()
expectTypeOf<JsdomEnvironmentOptions>().toEqualTypeOf<EnvironmentOptionsMap['jsdom']>()
expectTypeOf<JsdomEnvironmentOptions['customExportConditions']>().toEqualTypeOf<
  readonly string[] | undefined
>()
expectTypeOf<JsdomEnvironmentError['code']>().toEqualTypeOf<JsdomEnvironmentErrorCode>()
expectTypeOf<JsdomEnvironmentErrorCode>().toEqualTypeOf<
  'ENV_JSDOM_NOT_INSTALLED' | 'ENV_JSDOM_NOT_PREPARED' | 'ENV_JSDOM_REALM_UNSUPPORTED'
>()
expectTypeOf<ReturnType<typeof jsdomEnvironment.setup>>().toEqualTypeOf<
  EnvironmentInstance | Promise<EnvironmentInstance>
>()

const options: JsdomEnvironmentOptions = {
  url: 'http://example.test/',
  html: '<p>',
  customExportConditions: ['browser'],
}
void options

declare function useNode(environment: Environment<'node'>): void

// @ts-expect-error the jsdom environment is not the node one
useNode(jsdomEnvironment)
// @ts-expect-error not an option of the jsdom environment
const bad: JsdomEnvironmentOptions = { width: 3 }
void bad
// @ts-expect-error customExportConditions is a list of strings
const notAList: JsdomEnvironmentOptions = { customExportConditions: 'browser' }
void notAList
// @ts-expect-error not a code
new JsdomEnvironmentError('ENV_JSDOM_NOPE', 'message')
// @ts-expect-error a restore failure is reported by teardown, not thrown (D22)
new JsdomEnvironmentError('ENV_JSDOM_RESTORE_FAILED', 'message')
// @ts-expect-error the name is read-only
jsdomEnvironment.name = 'jsdom'
