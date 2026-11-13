// Stands in for the bin's `main`: says it is running and keeps the event loop alive with a timer
// until the run's signal is aborted (a Ctrl+C), and then lets go of every handle and never
// settles. That is a run whose reporter promise never settles once its workers are gone: nothing
// holds the loop open, and what Node does with an unsettled top-level `await` is end the process
// with 13, unless the bin has already set its own exit code.
//
// With `UNSETTLED_MAIN_HOLD=force` it lets go only when the force signal (the second Ctrl+C) is
// aborted, and says `cancelled` when the first signal arrives: a run that is slow to stop, so a
// test can send the second signal while the first is still being dealt with.
export async function main(
  _argv: readonly string[],
  io: { readonly signal?: AbortSignal; readonly forceSignal?: AbortSignal },
): Promise<number> {
  const keepAlive = setInterval(() => {}, 1000)
  const holdForForce = process.env.UNSETTLED_MAIN_HOLD === 'force'
  io.signal?.addEventListener(
    'abort',
    () => {
      if (holdForForce) process.stdout.write('cancelled\n')
      else clearInterval(keepAlive)
    },
    { once: true },
  )
  if (holdForForce) {
    io.forceSignal?.addEventListener('abort', () => clearInterval(keepAlive), { once: true })
  }
  process.stdout.write('ready\n')
  await new Promise<never>(() => {})
  return 0
}
