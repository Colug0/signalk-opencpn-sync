import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { apiKeyForPin, createPin, pinCompatHash, pinHash, pinToString } from '../src/pincode.js'

describe('pincode', () => {
  it('pads the PIN to four digits', () => {
    expect(pinToString(7)).toBe('0007')
    expect(pinToString(9999)).toBe('9999')
  })

  it('hashes the zero-padded PIN string like OpenCPN 5.9+', () => {
    const expected = createHash('sha256').update('0123').digest('hex').slice(0, 12)
    expect(pinHash(123)).toBe(expected)
    expect(pinHash(123)).toHaveLength(12)
  })

  // Reference values from std::linear_congruential_engine<unsigned long long,
  // 48271, 0, 0xFFFFFFFFFFFFFFFF> compiled with g++, as OpenCPN uses it.
  it.each([
    [1, 'BC8F'],
    [123, '5A98B5'],
    [4711, 'D8DEB89'],
    [9999, '1CC4D561']
  ])('compat hash of %i is %s', (pin, hex) => {
    expect(pinCompatHash(pin)).toBe(hex)
  })

  it('picks the scheme from the length of the key the client sent', () => {
    expect(apiKeyForPin(123, '1')).toBe(pinCompatHash(123))
    expect(apiKeyForPin(123, '0123456789abc')).toBe(pinHash(123))
  })

  it('creates PINs from 1 to 9999', () => {
    for (let i = 0; i < 1000; i++) {
      const pin = createPin()
      expect(pin).toBeGreaterThanOrEqual(1)
      expect(pin).toBeLessThanOrEqual(9999)
    }
  })
})
