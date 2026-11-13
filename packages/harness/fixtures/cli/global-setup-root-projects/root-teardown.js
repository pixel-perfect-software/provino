module.exports = async function rootTeardown(globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `teardown root (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
