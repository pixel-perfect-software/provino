import { who as scoped } from '@scope/manual-scoped'
import { who as plain } from 'manual-pkg'

vi.mock('manual-pkg')
vi.mock('@scope/manual-scoped')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('mock(pkg) with no factory uses the root __mocks__ file, not an automock', () => ({
  value: plain(),
  isMock: vi.isMockFunction(plain),
}))

c('the same for a scoped package', () => ({
  value: scoped(),
  isMock: vi.isMockFunction(scoped),
}))
