// Runs before the test file: the globals must already be there.
const scope = globalThis as Record<string, unknown>
scope.__seenInSetup = { version: scope.__APP_VERSION__, flags: scope.__FLAGS__ }
