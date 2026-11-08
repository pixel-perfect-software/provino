// @provino/dialect-vitest/node: what the Vitest dialect runs in the coordinator. A stub until the
// config reader and the CLI flags are built (T11.15, T11.16, Phase 2): it hands back the dialect
// value, so the entry exists for the manifest's edges and the type entries.

import { vitestDialect } from '@provino/dialect-vitest'
import type { Dialect } from '@provino/types'

/**
 * The Vitest dialect as the coordinator sees it. Today it is `vitestDialect` itself: no config
 * reader and no flags yet.
 * @public
 */
export const vitestNodeDialect: Dialect<'vitest'> = vitestDialect
