// The setupFiles module mocks HTMLCanvasElement.prototype.getContext with a recording context.
const context = (): CanvasRenderingContext2D =>
  document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D

test('drawing calls are recorded as events', () => {
  const ctx = context()
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 10, 10)
  ctx.beginPath()
  ctx.arc(5, 5, 3, 0, Math.PI * 2)
  ctx.stroke()
  expect((ctx as unknown as { __getEvents(): unknown }).__getEvents()).toMatchSnapshot()
})
test('the context methods are jest.fn mocks', () => {
  const ctx = context()
  ctx.fillRect(1, 2, 3, 4)
  expect(ctx.fillRect).toHaveBeenCalledWith(1, 2, 3, 4)
  expect(ctx.fillRect).toHaveBeenCalledTimes(1)
})
test('a wrong call count fails', () => {
  const ctx = context()
  ctx.clearRect(0, 0, 1, 1)
  expect(ctx.clearRect).toHaveBeenCalledTimes(2)
})
