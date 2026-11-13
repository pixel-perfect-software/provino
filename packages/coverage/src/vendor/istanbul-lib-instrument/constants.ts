import { createHash } from "node:crypto";

// provino: upstream reads its package.json for the name; Provino has no package.json here, and keeping
// the name keeps `_coverageSchema` equal to @vitest/istanbul-lib-instrument 2.1.0's
const PACKAGE_NAME = "@vitest/istanbul-lib-instrument";
// TODO: increment this version if there are schema changes
// that are not backwards compatible:
const VERSION = "4";

export const SHA = "sha1";
export const MAGIC_KEY = "_coverageSchema";
export const MAGIC_VALUE = createHash(SHA)
  .update(PACKAGE_NAME + "@" + VERSION)
  .digest("hex");
