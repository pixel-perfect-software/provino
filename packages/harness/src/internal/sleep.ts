// The one timer wait of the process code (spawnInGroup's group probes, the pty's group probes,
// the watch recorder's poll). Unit tests inject their own waits instead.

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
