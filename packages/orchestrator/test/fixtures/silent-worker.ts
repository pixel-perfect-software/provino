// A worker that connects but never says `ready`. Its open port keeps it alive until it is killed.
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = (port) => {
  port.onMessage(() => {})
}
export default main
