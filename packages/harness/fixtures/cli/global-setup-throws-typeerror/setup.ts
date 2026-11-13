module.exports = async function globalSetup(): Promise<void> {
  throw new TypeError('setup failed\nsecond line of the message')
}
