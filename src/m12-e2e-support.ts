/**
 * Compatibility barrel for the M12 real-host E2E support. The implementation
 * lives in `m12-e2e-contract.ts` (vocabularies and types),
 * `m12-e2e-prompts.ts` (prompt text) and `m12-e2e-evidence.ts` (readers,
 * plans and assertions); the driver and the contract tests keep importing the
 * historical module name so no call site changes.
 */
export * from './m12-e2e-contract.js'
export * from './m12-e2e-prompts.js'
export * from './m12-e2e-evidence.js'
