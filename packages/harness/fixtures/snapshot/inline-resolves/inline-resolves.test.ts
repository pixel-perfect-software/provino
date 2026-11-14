test('resolves and rejects', async () => {
  await expect(Promise.resolve({ ok: true })).resolves.toMatchInlineSnapshot()
  await expect(Promise.reject(new Error('no'))).rejects.toThrowErrorMatchingInlineSnapshot()
})
