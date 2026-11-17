// The public API of @provino/reporters/live.
import {
  createFrameScheduler,
  detectGlyphs,
  detectHyperlinks,
  type FrameScheduler,
  GLYPHS,
  type GlyphSet,
  type Glyphs,
  type LiveTerminal,
  type ProvinoReporter,
  type ProvinoReporterOptions,
  provinoReporter,
  type TerminalStream,
} from '@provino/reporters/live'
import type { Reporter } from '@provino/types'
import { expectTypeOf } from 'expect-type'

const stream: TerminalStream = { write: () => true }
const options: ProvinoReporterOptions = {
  stream,
  live: true,
  colour: false,
  columns: 80,
  glyphs: GLYPHS.emoji,
}

expectTypeOf(provinoReporter(options)).toEqualTypeOf<ProvinoReporter>()
expectTypeOf<ProvinoReporter>().toMatchTypeOf<Reporter>()
expectTypeOf<ProvinoReporter['terminal']>().toEqualTypeOf<LiveTerminal>()
expectTypeOf<LiveTerminal['restore']>().toEqualTypeOf<() => void>()
expectTypeOf<LiveTerminal['resize']>().toEqualTypeOf<(columns: number) => void>()
expectTypeOf(detectGlyphs({ env: {}, platform: 'darwin' })).toEqualTypeOf<GlyphSet>()
expectTypeOf(detectHyperlinks({ env: {}, tty: true, ci: false })).toEqualTypeOf<boolean>()
expectTypeOf(GLYPHS.ascii).toEqualTypeOf<Glyphs>()
expectTypeOf(createFrameScheduler()).toEqualTypeOf<FrameScheduler>()
// A stream is anything with a `write`; a `process.stdout` fits.
expectTypeOf(process.stdout).toMatchTypeOf<TerminalStream>()

// @ts-expect-error `live` is required: the caller says whether there is a terminal
const noLive: ProvinoReporterOptions = { stream, colour: false, columns: 80, glyphs: GLYPHS.emoji }
// @ts-expect-error a glyph set name is not a `Glyphs`
const wrongGlyphs: ProvinoReporterOptions = { ...options, glyphs: 'emoji' }
// @ts-expect-error `columns` is a number
const wrongColumns: ProvinoReporterOptions = { ...options, columns: '80' }
// @ts-expect-error a stream with no `write` is not a terminal stream
const noWrite: ProvinoReporterOptions = { ...options, stream: {} }
// @ts-expect-error only 'emoji', 'unicode' and 'ascii' are glyph sets
const wrongSet: GlyphSet = 'color'
// @ts-expect-error `platform` is required: detection reads no global
detectGlyphs({ env: {} })
// @ts-expect-error `ci` is required: the caller has already decided
detectHyperlinks({ env: {}, tty: true })

void [noLive, wrongGlyphs, wrongColumns, noWrite, wrongSet]
