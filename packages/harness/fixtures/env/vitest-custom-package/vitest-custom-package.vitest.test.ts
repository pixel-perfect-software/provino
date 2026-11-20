// The custom environment's setup ran once, with the whole environmentOptions object.
declare const __customOptions: string
declare const __customSetups: number

test('setup got the whole environmentOptions object', () => {
  expect(JSON.parse(__customOptions)).toEqual({ 'provino-custom': { flag: 'on' } })
})

test('setup ran once for the file', () => {
  expect(__customSetups).toBe(1)
})

test('there is no document', () => {
  expect(typeof document).toBe('undefined')
})
