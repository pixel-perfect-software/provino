// A support file with an optional dependency that is not installed, and a virtual one that a mock
// stands in for: neither may fail the file before its require runs.
let optional: string
try {
  optional = (require('not-installed-anywhere') as { name: string }).name
} catch (error) {
  optional = `fell back (${(error as { code?: string }).code})`
}

module.exports = {
  optional,
  virtual: () => require('virtual-config') as { level: number },
}
