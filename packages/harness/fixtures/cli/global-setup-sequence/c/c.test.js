// The largest of the three test files, so Jest's sequencer puts project c first, though it is the
// last in the config: with no history, the files are ordered by size, the larger first. The
// project's cache directory is inside its own root, so there is never a history from an earlier
// recording.
test('c', () => {})
