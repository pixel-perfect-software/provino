// @provino/env-jsdom: Provino's own jsdom test environment (Track 8, T8.3). Realm `worker` only;
// realm `context` comes with the `realm` isolation tier (T2.8).
export type { JsdomEnvironmentOptions } from './environment.ts'
export { jsdomEnvironment } from './environment.ts'
export { JsdomEnvironmentError, type JsdomEnvironmentErrorCode } from './errors.ts'
