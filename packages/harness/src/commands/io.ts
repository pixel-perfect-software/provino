/**
 * Where a command writes: `out` for its result (JSON, or nothing), `err` for what a person reads.
 * The CLI passes the process's streams; tests pass collectors.
 * @internal
 */
export interface CommandIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

/**
 * The process's own streams.
 * @internal
 */
export const processIo: CommandIo = {
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
}
