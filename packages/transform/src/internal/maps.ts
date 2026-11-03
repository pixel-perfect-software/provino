// Source maps (Track 3 R1 step 6): composed with @jridgewell/remapping only when more than one
// step changed the code.
import remapping from '@jridgewell/remapping'
import type { SourceMapV3 } from '@provino/types'

/** The fields every source map has, as oxc-transform and remapping produce them. */
interface RawMap {
  readonly file?: string | null | undefined
  readonly sourceRoot?: string | undefined
  readonly sources: readonly (string | null)[]
  readonly sourcesContent?: readonly (string | null | undefined)[] | undefined
  readonly names: readonly string[]
  readonly mappings: string
  readonly ignoreList?: readonly number[] | undefined
}

/** Normalizes a map to `SourceMapV3`, dropping absent optional fields. */
export function toSourceMapV3(map: RawMap): SourceMapV3 {
  return {
    version: 3,
    ...(map.file === undefined ? {} : { file: map.file }),
    ...(map.sourceRoot === undefined ? {} : { sourceRoot: map.sourceRoot }),
    sources: [...map.sources],
    ...(map.sourcesContent === undefined
      ? {}
      : { sourcesContent: map.sourcesContent.map((content) => content ?? null) }),
    names: [...map.names],
    mappings: map.mappings,
    ...(map.ignoreList === undefined ? {} : { ignoreList: [...map.ignoreList] }),
  }
}

/**
 * Composes the maps of successive steps into one map from the last output to the original
 * source. `maps` is in step order (first step first); `null` entries (steps that kept positions)
 * are skipped.
 */
export function composeMaps(maps: readonly (SourceMapV3 | null)[]): SourceMapV3 | null {
  const present = maps.filter((map): map is SourceMapV3 => map !== null)
  if (present.length <= 1) return present[0] ?? null
  // remapping wants the last step first; JSON input sidesteps readonly-array typing.
  const composed = remapping(
    present.toReversed().map((map) => JSON.stringify(map)),
    () => null,
  )
  const mappings = composed.mappings
  if (typeof mappings !== 'string') throw new Error('remapping returned decoded mappings')
  return toSourceMapV3({ ...composed, mappings })
}
