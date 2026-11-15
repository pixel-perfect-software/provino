// `--notify` (B23d A4): the notify reporter, the loader it takes, Jest's missing-module error and the
// text a leaking file is failed with.
import type {
  AggregatedResult,
  JestNotifier,
  JestNotifierLoad,
  JestNotifyConfig,
} from '@provino/dialect-jest/node'
import {
  createNotifyReporter,
  type JestNotifierMissingError,
  LEAK_MESSAGE,
  loadJestNotifier,
} from '@provino/dialect-jest/node'
import type { Reporter } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(loadJestNotifier).parameters.toEqualTypeOf<[rootDir: string]>()
expectTypeOf(loadJestNotifier).returns.toEqualTypeOf<JestNotifierLoad>()
expectTypeOf<JestNotifierLoad['notifier']>().toEqualTypeOf<JestNotifier>()
expectTypeOf<JestNotifierLoad['icon']>().toEqualTypeOf<string | undefined>()
expectTypeOf(createNotifyReporter).returns.toEqualTypeOf<Reporter>()
expectTypeOf<JestNotifyConfig>().toEqualTypeOf<{
  readonly rootDir: string
  readonly notifyMode: string
}>()
expectTypeOf<JestNotifierMissingError>().toExtend<Error>()
expectTypeOf(LEAK_MESSAGE).toBeString()

declare const notifier: JestNotifier
declare const loaded: JestNotifierLoad
declare const aggregated: () => AggregatedResult

createNotifyReporter({
  globalConfig: { rootDir: '/', notifyMode: 'always' },
  // @ts-expect-error a notifier is loaded with `loadJestNotifier`, not passed bare
  notifier,
  aggregated,
})
// @ts-expect-error the mode is part of the config the reporter reads
createNotifyReporter({ globalConfig: { rootDir: '/' }, loaded, aggregated })
// @ts-expect-error the notifier takes the notification's options, not a string
notifier.notify('failed')
// @ts-expect-error the root directory is a path, not a config
loadJestNotifier({ rootDir: '/' })
// @ts-expect-error the message is a constant
LEAK_MESSAGE.length = 0
