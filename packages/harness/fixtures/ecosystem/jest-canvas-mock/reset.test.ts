// The package's documented re-setup after a mock reset: reset every mock, then set the canvas up again.
import { setupJestCanvasMock } from 'jest-canvas-mock'

beforeEach(() => {
  jest.resetAllMocks()
  setupJestCanvasMock()
})

const context = (): CanvasRenderingContext2D =>
  document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D

test('after the re-setup the context still records draw calls', () => {
  const ctx = context()
  ctx.strokeStyle = '#00ff00'
  ctx.strokeRect(2, 2, 6, 6)
  expect((ctx as unknown as { __getDrawCalls(): unknown }).__getDrawCalls()).toMatchSnapshot()
})
test('each test sees a fresh mock', () => {
  const ctx = context()
  ctx.fillRect(0, 0, 2, 2)
  expect(ctx.fillRect).toHaveBeenCalledTimes(1)
})
test('measureText still answers after the reset', () => {
  const ctx = context()
  expect(ctx.measureText('abc').width).toMatchSnapshot()
})
