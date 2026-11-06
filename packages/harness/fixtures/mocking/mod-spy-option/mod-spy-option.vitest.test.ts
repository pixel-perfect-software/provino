import { add, holder } from './subject.ts'

vi.mock('./subject.ts', { spy: true })

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('spy: true calls through, records the calls, and leaves getters and values real', () => {
  const sum = add(2, 3)
  return {
    sum,
    isMock: vi.isMockFunction(add),
    calls: vi.mocked(add).mock.calls,
    twice: holder.twice(4),
    twiceIsMock: vi.isMockFunction(holder.twice),
    getter: holder.computed,
    label: holder.label,
  }
})
