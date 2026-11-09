test('file snapshots', async () => {
  await expect('first file\n').toMatchFileSnapshot('./out/first.txt')
  await expect({ a: 1 }).toMatchFileSnapshot('./out/second.txt', 'a hint')
})
