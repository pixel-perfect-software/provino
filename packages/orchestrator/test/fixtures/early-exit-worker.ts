// A worker that exits with code 5 before it says `ready`.
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = () => {
  process.exit(5)
}
export default main
