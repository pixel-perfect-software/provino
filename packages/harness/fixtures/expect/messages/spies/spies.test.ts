// Cases that need no mock function, so one file runs under both runners.
const plain = (value: number): number => value

describe('not a mock', () => {
  test('toHaveBeenCalled with a plain function is a matcher error', () => {
    expect(plain).toHaveBeenCalled()
  })

  test('toHaveReturnedWith with a plain function is a matcher error', () => {
    expect(plain).toHaveReturnedWith(1)
  })

  test('not.toHaveBeenCalled with a plain function is a matcher error', () => {
    expect(plain).not.toHaveBeenCalled()
  })
})
