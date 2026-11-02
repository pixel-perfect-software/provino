import type { SchemaVersion } from '@provino/types'

/**
 * The result-model schema version. `@provino/types` exports types only, so the runtime constant
 * lives here. Bump it, and the type in `@provino/types`, together.
 * @public
 */
export const SCHEMA_VERSION: SchemaVersion = 1
