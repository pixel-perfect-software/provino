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
  type MapCells,
  type ProvinoReporter,
  type ProvinoReporterOptions,
  type ProvinoViews,
  provinoReporter,
  type TerminalStream,
  type TreeGuides,
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
  hyperlinks: false,
  cwd: '/project',
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

const withExtras: ProvinoReporterOptions = {
  ...options,
  silent: true,
  noStackTrace: true,
  readSource: () => Promise.resolve(undefined),
}
// B26 Phase 4: the views, and the glyphs they draw with.
const withViews: ProvinoReporterOptions = { ...options, views: { tree: true, map: true } }
const onlyTree: ProvinoViews = { tree: true }
expectTypeOf(GLYPHS.emoji.tree).toEqualTypeOf<TreeGuides>()
expectTypeOf(GLYPHS.ascii.cell).toEqualTypeOf<MapCells>()
expectTypeOf<ProvinoReporterOptions['views']>().toEqualTypeOf<ProvinoViews | undefined>()
// @ts-expect-error a view can only be turned on: `tree: false` is leaving it out
const treeOff: ProvinoReporterOptions = { ...options, views: { tree: false } }
// @ts-expect-error there is no `timeline` view
const unknownView: ProvinoReporterOptions = { ...options, views: { timeline: true } }
// @ts-expect-error `views` is an object, not a list of names
const viewNames: ProvinoReporterOptions = { ...options, views: ['tree'] }
// @ts-expect-error a glyph set must give every guide of the tree
const noGuides: TreeGuides = { branch: '├─ ', last: '└─ ', pipe: '│  ' }
// @ts-expect-error a glyph set must give every cell of the map
const noCells: MapCells = { pass: '.', fail: 'X', skipped: 's' }

// @ts-expect-error `live` is required: the caller says whether there is a terminal
const noLive: ProvinoReporterOptions = { ...options, live: undefined }
// @ts-expect-error `stream` is required
const noStream: ProvinoReporterOptions = { ...options, stream: undefined }
// @ts-expect-error `cwd` is required: code frames are read relative to it
const noCwd: ProvinoReporterOptions = { ...options, cwd: undefined }
// @ts-expect-error `silent` can only be `true`
const loudSilent: ProvinoReporterOptions = { ...options, silent: false }
// @ts-expect-error a source reader returns text or `undefined`, not a number
const badReader: ProvinoReporterOptions = { ...options, readSource: () => Promise.resolve(1) }
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

void [
  withViews,
  onlyTree,
  treeOff,
  unknownView,
  viewNames,
  noGuides,
  noCells,
  withExtras,
  noStream,
  noCwd,
  loudSilent,
  badReader,
  noLive,
  wrongGlyphs,
  wrongColumns,
  noWrite,
  wrongSet,
]
