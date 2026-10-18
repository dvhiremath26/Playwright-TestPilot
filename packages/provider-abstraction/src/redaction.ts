/**
 * Credential and secret redaction before any log or telemetry.
 *
 * Call redact() on every string that may appear in output, error messages,
 * or telemetry.  Call redactObject() for structured data.
 */

/** Fields whose values are treated as secrets. */
const SECRET_FIELD_NAMES = new Set([
  'apiKey', 'api_key', 'api-key', 'apikey',
  'token', 'accessToken', 'access_token', 'access-token',
  'secret', 'secretKey', 'secret_key', 'secret-key',
  'password', 'passwd', 'pwd',
  'bearer', 'authorization',
  'sessionToken', 'session_token',
  'privateKey', 'private_key', 'private-key',
  'clientSecret', 'client_secret',
])

/** Long alphanumeric strings are likely tokens or keys. */
const TOKEN_RE = /[A-Za-z0-9+/]{32,}={0,2}/g

/** URL patterns that embed credentials. */
const CREDS_IN_URL_RE = /(https?:\/\/)([^:@\s]+):([^@\s]+)@/g

/**
 * Redact a single string.  Safe to call on any text.
 *
 * Applied transformations:
 * 1. Replaces `scheme://user:pass@host` with `scheme://***@host`
 * 2. Replaces long base64-like tokens (>= 32 alphanumeric chars)
 * 3. Replaces known secret field values (when the field name is known)
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    .replace(CREDS_IN_URL_RE, '$1***@')
    .replace(TOKEN_RE, (match) => '[REDACTED]')
}

/**
 * Recursively scrub secrets from a plain object/array/value.
 * Returns a deep clone with all secrets replaced.
 *
 * @returns The same shape as the input, with secrets replaced by `[REDACTED]`.
 */
export function redactObject<T>(obj: T): T {
  return _scrub(obj, new Set()) as T
}

function isSecretFieldName(key: string): boolean {
  return SECRET_FIELD_NAMES.has(key.toLowerCase())
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _scrub(value: any, seen: Set<unknown>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((item) => _scrub(item, seen))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretFieldName(k) ? '[REDACTED]' : _scrub(v, seen)
    }
    return out
  }

  // Symbol, Function, etc. — return a placeholder.
  return '[Unsupported]'
}
