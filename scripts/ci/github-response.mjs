/**
 * Small GitHub API response helpers shared by the trusted CI publishers.
 *
 * The helpers keep the API version, timeout, and error shape in one place.
 * Callers own the request body and the label used in a failed-response error.
 */
const API_TIMEOUT_MS = 15_000

/** Headers for one authenticated GitHub API request. */
export function githubHeaders(token, json = false) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * Decode a GitHub response or throw a labeled error with the response body.
 *
 * @param {Response} response Fetch response.
 * @param {string} label Action label, e.g. `reading current main`.
 * @returns {Promise<unknown>} Parsed JSON body.
 */
export async function readGithubResponse(response, label) {
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${label} failed (${String(response.status)}): ${detail}`)
  }
  return response.json()
}

/**
 * Read current main through the GitHub API.
 *
 * @param {{token: string, repository: string, apiUrl: string,
 *   fetchImpl?: typeof fetch}} input API inputs.
 * @returns {Promise<string|undefined>} Current main SHA.
 */
export async function fetchCurrentMainSha(input) {
  const response = await (input.fetchImpl ?? fetch)(`${input.apiUrl}/repos/${input.repository}/git/ref/heads/main`, {
    headers: githubHeaders(input.token),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  const body = await readGithubResponse(response, 'reading current main')
  return body.object?.sha
}
