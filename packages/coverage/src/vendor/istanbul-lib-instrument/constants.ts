import { createHash } from "node:crypto";

// provino: upstream reads its package.json for the name; Provino has no package.json here. The name is
// the original package's, so `_coverageSchema` is the value istanbul-lib-instrument 6 (Jest 30.5.2's,
// through babel-plugin-istanbul) writes: a report reader or merge that checks the schema sees Jest's
const PACKAGE_NAME = "istanbul-lib-instrument";
// provino: the fork's own value, which @vitest/istanbul-lib-instrument 2.1.0 writes
const FORK_PACKAGE_NAME = "@vitest/istanbul-lib-instrument";
// TODO: increment this version if there are schema changes
// that are not backwards compatible:
const VERSION = "4";

export const SHA = "sha1";
export const MAGIC_KEY = "_coverageSchema";
export const MAGIC_VALUE = createHash(SHA)
  .update(PACKAGE_NAME + "@" + VERSION)
  .digest("hex");

// provino: the reader accepts the fork's value too, so a file the fork already instrumented is read,
// not instrumented again; babel-plugin-istanbul's (a project whose babel-jest instruments,
// `canInstrument`) is `MAGIC_VALUE` itself
export const READABLE_MAGIC_VALUES: readonly string[] = [
  MAGIC_VALUE,
  createHash(SHA)
    .update(FORK_PACKAGE_NAME + "@" + VERSION)
    .digest("hex"),
];
