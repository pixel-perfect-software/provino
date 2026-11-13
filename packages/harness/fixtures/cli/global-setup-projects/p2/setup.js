module.exports = async function globalSetup() {
  require('node:fs').appendFileSync('order.txt', 'setup p2\n')
}
