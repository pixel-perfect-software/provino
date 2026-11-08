// Where this code runs: a worker thread, the runner's own process (its bin is argv[1]), or a
// child process the runner forked (it has an IPC channel).
export function where(): string {
  const { isMainThread } = process.getBuiltinModule('node:worker_threads')
  if (!isMainThread) return 'threads'
  if (/[/\\](?:jest|vitest)(?:\.m?js)?$/.test(process.argv[1] ?? '')) return 'inline'
  return typeof process.send === 'function' ? 'forks' : 'unknown'
}
