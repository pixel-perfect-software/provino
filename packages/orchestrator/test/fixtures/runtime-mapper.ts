// A module mapper that never maps. The resolver asks the mappers first, for every specifier it
// resolves, so recording what they are asked shows how many times the loader resolved each module.
import { basename } from 'node:path'
import type { ModuleMapper } from '@provino/types'
import { trace } from './runtime-env.ts'

export function recordingMapper(): ModuleMapper {
  return {
    id: 'recording',
    map(specifier) {
      trace(`resolve ${basename(specifier)}`)
      return null
    },
  }
}
