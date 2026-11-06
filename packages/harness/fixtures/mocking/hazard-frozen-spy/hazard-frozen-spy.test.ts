// Spying on a frozen object fails. Jest registers the restorer before it installs the spy, so the
// failed spy stays registered and every later restoreAllMocks() throws too (Track 4 L55 and the
// hazard row); Vitest leaves its registry clean. Two observations, in this order.
const M = typeof jest === 'undefined' ? vi : jest

test('spyOn a frozen object throws', () =>
  observe('spyOn a frozen object', () => {
    const frozen = Object.freeze({ m: () => 'frozen' })
    M.spyOn(frozen, 'm')
    return 'did not throw'
  }))

test('restoreAllMocks afterwards', () =>
  observe('restoreAllMocks after the failed spy', () => {
    M.restoreAllMocks()
    return 'did not throw'
  }))
