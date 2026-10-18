import { createHash } from 'node:crypto'

/** SHA-256 fingerprint of file content, used for incremental indexing. */
export function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function fingerprintFile(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}
