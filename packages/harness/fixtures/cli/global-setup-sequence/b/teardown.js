module.exports = async function globalTeardown(_globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `teardown shared (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
