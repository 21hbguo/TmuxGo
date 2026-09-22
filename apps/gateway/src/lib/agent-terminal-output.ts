import { gunzipSync, gzipSync } from 'zlib'

// Agent upstream terminal-output pre-compression helpers (PROTOCOL.extend.md A).
// Wire form when compressed: encoding='gzip', data=base64(gzip(utf8)).

export const AGENT_COMPRESS_THRESHOLD = 256

export function maybeCompressAgentOutput(
  data: string,
  enabled: boolean,
  threshold: number = AGENT_COMPRESS_THRESHOLD,
): { data: string; encoding?: 'gzip' } {
  if (!enabled || !data) return { data }
  const raw = Buffer.from(data, 'utf8')
  if (raw.length < threshold) return { data }
  try {
    const compressed = gzipSync(raw)
    const encoded = compressed.toString('base64')
    // base64 inflates 4/3; only ship gzip when the wire form is actually smaller
    if (encoded.length >= raw.length) return { data }
    return { data: encoded, encoding: 'gzip' }
  } catch {
    return { data }
  }
}

/**
 * Decode an agent terminal-output payload.
 * Returns null when gzip is negotiated but decompress fails (frame should be dropped).
 * Plaintext frames (no gzip encoding) pass through unchanged.
 */
export function decodeAgentOutput(data: string, encoding?: string): string | null {
  if (encoding !== 'gzip') return data
  try {
    return gunzipSync(Buffer.from(data, 'base64')).toString('utf8')
  } catch {
    return null
  }
}
