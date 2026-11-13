// The larger of the two test files, so Jest's sequencer puts p1 first: with no history, files are
// ordered by size, the larger first. The project's cache directory is inside its own root, so there
// is never a history from an earlier recording.
test('project one runs', () => {})
