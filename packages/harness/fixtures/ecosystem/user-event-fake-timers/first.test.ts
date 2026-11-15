// user-event advances Jest's fake clock between its steps; waitFor advances it while it polls.
import { screen, waitFor } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'

beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

test('first: a click whose effect lands on a timer', async () => {
  document.body.innerHTML = '<button type="button">go</button><p id="out"></p>'
  const button = screen.getByRole('button', { name: 'go' })
  button.addEventListener('click', () => {
    setTimeout(() => {
      const out = document.getElementById('out')
      if (out !== null) out.textContent = 'clicked in first'
    }, 500)
  })
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  await user.click(button)
  await waitFor(() => expect(screen.getByText('clicked in first').id).toBe('out'))
})
test('first: typing with a delay between keys', async () => {
  document.body.innerHTML = '<input aria-label="name" />'
  const user = userEvent.setup({ delay: 100, advanceTimers: jest.advanceTimersByTime })
  const input = screen.getByLabelText('name') as HTMLInputElement
  const before = jest.now()
  await user.type(input, 'abc')
  expect(input.value).toBe('abc')
  expect(jest.now() - before).toBeGreaterThanOrEqual(300)
})
test('first: waitFor times out on the fake clock', async () => {
  document.body.innerHTML = '<p>only this</p>'
  await waitFor(() => expect(screen.getByText('never shown')).toBeTruthy(), { timeout: 200 })
})
