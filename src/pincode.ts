import { createHash, randomInt } from 'node:crypto'

/** A pairing PIN as OpenCPN uses it: an integer from 1 to 9999. */
export function createPin(): number {
  return randomInt(1, 10000)
}

/** The PIN as shown to the user: always four digits, zero-padded. */
export function pinToString(pin: number): string {
  return String(pin).padStart(4, '0')
}

/**
 * API key for OpenCPN 5.9 and later: the first 12 hex digits of the SHA-256
 * of the zero-padded PIN string (OpenCPN `Pincode::Hash`).
 */
export function pinHash(pin: number): string {
  return createHash('sha256').update(pinToString(pin)).digest('hex').slice(0, 12)
}

const LCG_MULTIPLIER = 48271n
const LCG_MODULUS = 0xffffffffffffffffn

/**
 * API key for OpenCPN 5.8 clients (OpenCPN `Pincode::CompatHash`): the first
 * output of std::linear_congruential_engine<uint64, 48271, 0, 2^64-1> seeded
 * with the PIN, printed as uppercase hex without padding.
 */
export function pinCompatHash(pin: number): string {
  return ((BigInt(pin) * LCG_MULTIPLIER) % LCG_MODULUS).toString(16).toUpperCase()
}

/**
 * OpenCPN picks the key scheme from what the client sent: keys shorter than
 * 10 characters come from 5.8 clients and get the compat hash.
 */
export function apiKeyForPin(pin: number, clientKey: string): string {
  return clientKey.length < 10 ? pinCompatHash(pin) : pinHash(pin)
}
