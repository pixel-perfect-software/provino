describe('formatted', () => {
  test('new snapshots', async () => {
    expect({ a: 1, b: ['x', 'y'] }).toMatchInlineSnapshot()
    expect('one line').toMatchInlineSnapshot()
    await expect(Promise.resolve({ deep: { ok: true } })).resolves.toMatchInlineSnapshot()
  })
})
