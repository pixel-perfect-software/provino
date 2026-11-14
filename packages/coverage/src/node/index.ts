// @provino/coverage/node: what runs in the coordinator. The merge, the reports and the thresholds
// arrive with B23b's later phases.
export { CoverageError, type CoverageErrorCode } from '@provino/coverage'
export { createCoverageFilter } from '../filter.ts'
export { expandIstanbulData, type KnownMaps } from './expand.ts'
