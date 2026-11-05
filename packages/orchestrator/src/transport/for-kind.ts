// Picks a transport factory by pool kind, so a caller with one options object needn't switch.
import type { PoolKind, TransportFactory } from '@provino/types'
import { type ForksTransportOptions, forksTransport } from './forks.ts'
import { inlineTransport } from './inline.ts'
import { type ThreadsTransportOptions, threadsTransport } from './threads.ts'

/**
 * Options for `transportFor`: the union of every kind's. A kind ignores what it has no use for
 * (`memoryLimitMb` is for threads, `execArgv` and `env` for forks and threads).
 * @public
 */
export type TransportForOptions = ForksTransportOptions & ThreadsTransportOptions

/**
 * The transport factory for `kind`, built from `options`.
 * @public
 */
export function transportFor(kind: PoolKind, options: TransportForOptions): TransportFactory {
  switch (kind) {
    case 'forks':
      return forksTransport(options)
    case 'threads':
      return threadsTransport(options)
    case 'inline':
      return inlineTransport(options)
    default:
      return kind satisfies never
  }
}
