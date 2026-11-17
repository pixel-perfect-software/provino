// @provino/reporters/live: Provino's own terminal output (B26). Loaded by dynamic import only when
// the `provino` reporter is chosen, and never in a worker. Phase 1: the renderer core and the live
// footer.

export {
  type LiveTerminal,
  type ProvinoReporter,
  type ProvinoReporterOptions,
  provinoReporter,
} from './reporter.ts'
export {
  detectGlyphs,
  detectHyperlinks,
  type GlyphOptions,
  type HyperlinkOptions,
} from './terminal/capabilities.ts'
export { GLYPHS, type GlyphSet, type Glyphs } from './terminal/glyphs.ts'
export {
  createFrameScheduler,
  type FrameScheduler,
  type SchedulerOptions,
} from './terminal/scheduler.ts'
export type { TerminalStream } from './terminal/writer.ts'
