/**
 * Keeps a closed reader from killing the process. When the other end of a pipe goes away (`| head`),
 * the next write to the stream emits an `'error'` (EPIPE), and with no listener that is an uncaught
 * exception, which would lose a record the run is about to save. This adds a listener that
 * swallows EPIPE and throws anything else, as an unhandled `'error'` would have.
 * @internal
 */
export function ignoreBrokenPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}
