const { mock, mockClear, mockDeep, mockReset } =
  require('jest-mock-extended') as typeof import('jest-mock-extended')

interface Service {
  db: { users: { find(id: number): string | undefined } }
  name(): string
}

describe('mockDeep and the resets', () => {
  it('answers a nested calledWith', () => {
    const service = mockDeep<Service>()
    service.db.users.find.calledWith(1).mockReturnValue('ann')
    expect(service.db.users.find(1)).toBe('ann')
    expect(service.db.users.find(2)).toBeUndefined()
  })

  it('mockReset drops the calledWith answers and the calls', () => {
    const service = mock<Service>()
    service.name.mockReturnValue('first')
    expect(service.name()).toBe('first')
    mockReset(service)
    expect(service.name()).toBeUndefined()
    expect(service.name).toHaveBeenCalledTimes(1)
  })

  it('mockClear drops the calls and keeps the answers', () => {
    const service = mock<Service>()
    service.name.mockReturnValue('kept')
    service.name()
    mockClear(service)
    expect(service.name).toHaveBeenCalledTimes(0)
    expect(service.name()).toBe('kept')
  })

  it('fails toHaveBeenCalledTimes on a nested member', () => {
    const service = mockDeep<Service>()
    service.db.users.find(1)
    expect(service.db.users.find).toHaveBeenCalledTimes(2)
  })
})
