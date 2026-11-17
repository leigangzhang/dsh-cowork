/**
 * Bounded, sanitized evidence for the browser panel lane.
 *
 * A failed browser run writes these shapes to disk; they must never carry the
 * bundle source, a page's full HTML, or a credential-shaped value. The module
 * is pure so the redaction and bounding contract can be tested without a host
 * or Chromium.
 */
import { sanitizeEvidenceText } from './evidence-sanitize.mjs'

/** Remove credentials from URL-shaped evidence before it reaches disk. */
export function redactUrl(value) {
  try {
    const url = new URL(value)
    url.searchParams.delete('token')
    return url.toString()
  } catch {
    return value
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function functionRangeCount(functions) {
  let total = 0
  for (const fn of functions) total += asArray(fn.ranges).length
  return total
}

/** Describe one JSCoverage entry by size and range counts, never its source. */
export function coverageEntryEvidence(entry) {
  const functions = asArray(entry.functions)
  const source = entry.source ?? entry.text ?? ''
  return {
    url: redactUrl(entry.url ?? ''),
    generatedLength: source.length,
    functions: functions.length,
    ranges: functionRangeCount(functions),
  }
}

/** Keep only the coverage shape needed to diagnose a failure, never the bundle source. */
export function coverageEvidence(entries) {
  return asArray(entries).map(coverageEntryEvidence)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorStack(error) {
  return error instanceof Error ? error.stack ?? '' : ''
}

/** Redact one console record while keeping its level. */
function consoleEvidence(message) {
  return { type: message.type, text: sanitizeEvidenceText(message.text) }
}

/** Redact one response row while keeping method, URL, and status. */
function networkEvidence(row) {
  return { ...row, url: sanitizeEvidenceText(row.url) }
}

/**
 * The bounded failure report a browser run writes to `failure.json`.
 *
 * Page errors, console records, network rows, host logs, and the coverage
 * summary are all present; raw bundle source and page HTML are not.
 *
 * @param {{error: unknown, pageErrors: string[], consoleMessages: Array<{type: string, text: string}>, network: Array<object>, coverage: object[]|undefined, hostLogs: string|undefined}} input
 * @returns {object}
 */
export function failurePayload({ error, pageErrors, consoleMessages, network, coverage, hostLogs }) {
  return {
    error: sanitizeEvidenceText(errorMessage(error)),
    stack: sanitizeEvidenceText(errorStack(error)),
    pageErrors: pageErrors.map(sanitizeEvidenceText),
    consoleMessages: consoleMessages.map(consoleEvidence),
    network: network.map(networkEvidence),
    hostLogs: sanitizeEvidenceText(hostLogs ?? ''),
    coverage: coverageEvidence(coverage),
  }
}
