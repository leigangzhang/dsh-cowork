/**
 * Redact credentials from browser-lane failure evidence.
 *
 * URL query tokens, cookie/authorization headers, and bearer values are the
 * only secrets the lane can encounter. The helper is pure so the redaction
 * contract can be tested without a host or browser.
 */

/** Replace credential-shaped substrings with a stable marker. */
export function sanitizeEvidenceText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|code|access_token)=)[^&\s"'<>]*/gi, '$1[redacted]')
    .replace(/(\b(?:cookie|set-cookie|authorization)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
}
