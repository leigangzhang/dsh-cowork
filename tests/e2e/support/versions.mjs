/**
 * DSH host compatibility for one E2E manifest.
 *
 * The manifest pins the host patch line it was written against and the major.minor
 * line it claims. A different major.minor is a hard failure; an untested patch
 * inside the same line is a warning unless the caller asks for strictness.
 */

/** Split `x.y.z[-pre...]` into its leading numeric fields. */
export function parseHostVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: String(value).trim() }
}

/**
 * Decide whether one `dsh --version` value is acceptable for this manifest.
 *
 * @param {{tested: string[], compatibleMajorMinor: string}} host Manifest host block.
 * @param {string} version Output of `dsh --version`.
 * @returns {{supported: boolean, tested: boolean, reason: string}}
 */
export function hostSupport(host, version) {
  const parsed = parseHostVersion(version)
  if (parsed === null) return { supported: false, tested: false, reason: `unparseable DSH version "${version}"` }
  const [major, minor] = String(host.compatibleMajorMinor).split('.')
  const compatible = parsed.major === Number(major) && parsed.minor === Number(minor)
  if (!compatible) {
    return {
      supported: false,
      tested: false,
      reason: `DSH ${version} is outside ${host.compatibleMajorMinor}.x (manifest tested: ${host.tested.join(', ')})`,
    }
  }
  const tested = host.tested.includes(parsed.text)
  return {
    supported: true,
    tested,
    reason: tested ? `DSH ${parsed.text} is the tested host` : `DSH ${version} is inside ${host.compatibleMajorMinor}.x but not tested`,
  }
}
