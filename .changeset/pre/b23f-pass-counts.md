---
'provino': patch
---

provino jest: an assertion counted outside a test (at module scope, in a beforeAll, or in an afterAll after a test's end) goes to the next test to end, as Jest counts it, so `numPassingAsserts`, `expect.assertions` and `expect.hasAssertions` agree with Jest (jest-when's load-time assertion).
