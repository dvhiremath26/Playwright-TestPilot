import { expect, test } from 'vitest'

import { redact, spawnErrorCode, spawnErrorMessage } from '../src/redaction-helpers.ts'

test('redacts userinfo credentials in URLs', () => {
  expect(redact('open https://admin:SuperSecret1@erp.example.com/sap/')).toBe(
    'open https://***@erp.example.com/sap/',
  )
})

test('redacts authorization headers in either separator form', () => {
  expect(redact('Authorization: Bearer abc.def-123_ghi')).toBe('Authorization [REDACTED]')
  expect(redact('Authorization=Bearer abc.def-123_ghi')).toBe('Authorization [REDACTED]')
  expect(redact('bearer: xyz123ABC')).toBe('bearer [REDACTED]')
})

test('leaves ordinary text unchanged', () => {
  const plain = 'button "Save" [ref=e15] role=button'
  expect(redact(plain)).toBe(plain)
})

test('handles empty and whitespace-only input without throwing', () => {
  expect(redact('')).toBe('')
  expect(redact('   ')).toBe('   ')
})

test('redacts multiple credential forms in one string', () => {
  const input = 'https://a:SuperSecret1@host  Authorization: Bearer abcdef1234567890'
  const out = redact(input)
  expect(out).not.toMatch(/SuperSecret1|abcdef1234567890/)
  expect(out).toMatch(/\*\*\*@/)
  expect(out).toMatch(/\[REDACTED\]/)
})

test('does not leak the token after redacting an Authorization line', () => {
  const secret = 'abcdef1234567890'
  // `Authorization: Bearer <secret>` must not survive as a partial "Bearer abcdef..." tail.
  const out = redact(`Authorization: Bearer ${secret} trailing`)
  expect(out).not.toMatch(/abcdef/)
  expect(out).toBe('Authorization [REDACTED]')
})

test('a bare token with no credential marker is left alone', () => {
  // Redaction is pattern-driven, not omniscient. A token with no scheme or host context
  // cannot be reliably distinguished from ordinary text, so it is not guessed at.
  expect(redact('abcdef1234567890')).toBe('abcdef1234567890')
})

test('spawnErrorCode reads the code defensively from any thrown value', () => {
  expect(spawnErrorCode({ code: 'ENOENT', message: 'nope' })).toBe('ENOENT')
  expect(spawnErrorCode({ code: 42 })).toBeUndefined()
  expect(spawnErrorCode('a string')).toBeUndefined()
  expect(spawnErrorCode(null)).toBeUndefined()
  expect(spawnErrorCode(undefined)).toBeUndefined()
})

test('spawnErrorMessage reports a friendly message for ENOENT and the original otherwise', () => {
  expect(spawnErrorMessage({ code: 'ENOENT' }, 'playwright')).toBe('Command not found: playwright')
  expect(spawnErrorMessage(new Error('boom'), 'x')).toBe('Error: boom')
})
