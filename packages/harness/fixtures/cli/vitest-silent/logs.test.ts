it('logs', () => {
  console.log('MARKER stdout')
  console.error('MARKER stderr')
  expect(1).toBe(1)
})
