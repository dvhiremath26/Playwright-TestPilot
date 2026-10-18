/**
 * Shared helpers for the browser layer: output redaction and spawn error handling.
 *
 * Browser tools return page content, which routinely contains credentials — a URL with
 * userinfo, an Authorization header echoed into a snapshot, or a token sitting in an
 * element attribute. Every result crosses this boundary redacted.
 *
 * Kept local to this package so the browser layer stays independently usable rather than
 * coupling to provider-abstraction just to reach a helper.
 */

/** URL patterns that embed credentials, e.g. https://user:pass@host. */
const CREDS_IN_URL_RE = /(https?:\/\/)([^:@\s]+):([^@\s]+)@/g

/**
 * Authorization-style headers, consuming the rest of the line.
 *
 * Consuming to end-of-line rather than matching a token pattern is deliberate: a
 * narrower pattern like `\S+` stops at the first space, so `Authorization: Bearer <token>`
 * would redact the word "Bearer" and leave the actual secret on screen. Headers here are
 * line-oriented, so the safe behaviour is to eat the whole tail.
 */
const AUTH_HEADER_RE = /\b(Authorization|Bearer)\b[^\n]*/gi

/**
 * Redact credential-bearing substrings.
 * Safe on any text; returns the input unchanged when there is nothing to scrub.
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    .replace(CREDS_IN_URL_RE, '$1***@')
    .replace(AUTH_HEADER_RE, (_all, scheme: string) => `${scheme} [REDACTED]`)
}

/**
 * Extract a spawn error code ('ENOENT' etc.) from an unknown thrown value.
 *
 * `child_process` errors carry a `code` property, but throw sites type the argument as
 * `Error`, so it must be read defensively rather than asserted.
 */
export function spawnErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Friendly message for a spawn failure, given a command name. */
export function spawnErrorMessage(err: unknown, command: string): string {
  return spawnErrorCode(err) === 'ENOENT'
    ? `Command not found: ${command}`
    : String(err)
}
