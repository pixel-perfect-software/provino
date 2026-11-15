// The same flows in a second file on the same worker, with the fake clock installed afresh.
import { screen, waitFor } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'

beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

test('second: a click whose effect lands on a timer', async () => {
  document.body.innerHTML = '<button type="button">go</button><p id="out"></p>'
  const button = screen.getByRole('button', { name: 'go' })
  button.addEventListener('click', () => {
    setTimeout(() => {
      const out = document.getElementById('out')
      if (out !== null) out.textContent = 'clicked in second'
    }, 500)
  })
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  await user.click(button)
  await waitFor(() => expect(screen.getByText('clicked in second').id).toBe('out'))
})
test('second: typing with a delay between keys', async () => {
  document.body.innerHTML = '<input aria-label="name" />'
  const user = userEvent.setup({ delay: 100, advanceTimers: jest.advanceTimersByTime })
  const input = screen.getByLabelText('name') as HTMLInputElement
  const before = jest.now()
  await user.type(input, 'xyz')
  expect(input.value).toBe('xyz')
  expect(jest.now() - before).toBeGreaterThanOrEqual(300)
})
test('second: waitFor times out on the fake clock', async () => {
  document.body.innerHTML = '<p>only this</p>'
  await waitFor(() => expect(screen.getByText('never shown')).toBeTruthy(), { timeout: 200 })
})
