// The public API of @provino/coverage/runtime: the Istanbul instrumenter and the initial coverage
// reader.
import {
  type InitialCoverage,
  type IstanbulInstrumenterOptions,
  loadInstrumenter,
} from '@provino/coverage/runtime'
import type { CoverageInstrumenter, IstanbulFileCoverageData, SourceMapV3 } from '@provino/types'
import { expectTypeOf } from 'expect-type'

const { istanbulInstrumenter, readInitialCoverage } = await loadInstrumenter()

expectTypeOf(istanbulInstrumenter).returns.toEqualTypeOf<CoverageInstrumenter>()
expectTypeOf(istanbulInstrumenter()).toEqualTypeOf<CoverageInstrumenter>()
istanbulInstrumenter({ coverageVariable: '__coverage__' })
istanbulInstrumenter({})

expectTypeOf<IstanbulInstrumenterOptions>().toEqualTypeOf<{
  readonly coverageVariable?: string
}>()

// What the pipeline hands over, and gets back.
expectTypeOf(istanbulInstrumenter().instrument).parameters.toEqualTypeOf<
  [code: string, filename: string, inputMap: SourceMapV3 | null]
>()
expectTypeOf(
  istanbulInstrumenter().instrument('', '', null).map,
).toEqualTypeOf<SourceMapV3 | null>()

expectTypeOf(readInitialCoverage).parameters.toEqualTypeOf<[code: string]>()
expectTypeOf(readInitialCoverage('')).toEqualTypeOf<InitialCoverage | null>()
expectTypeOf<InitialCoverage['coverageData']>().toEqualTypeOf<IstanbulFileCoverageData>()

// @ts-expect-error: the variable is a name, not a number
istanbulInstrumenter({ coverageVariable: 1 })
// @ts-expect-error: no such option (the instrumenter's other knobs are fixed to Jest's)
istanbulInstrumenter({ produceSourceMap: false })
// @ts-expect-error: the input map is `null` or a map, not omitted
istanbulInstrumenter().instrument('', '')
// @ts-expect-error: the code is text
readInitialCoverage(1)
