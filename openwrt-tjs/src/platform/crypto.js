import { ctr as nobleCtr } from '@noble/ciphers/aes.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'
import { createHash as createTjsHash } from 'tjs:hashing'

function createHash(type) {
  const hash = createTjsHash(type)
  return {
    update(data) {
      hash.update(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      return this
    },
    digest(encoding) {
      if (encoding === 'hex') {
        return hash.digest()
      }
      const data = Buffer.from(hash.bytes())
      return encoding ? data.toString(encoding) : data
    },
  }
}

function pbkdf2Sync(password, salt, iterations, keyLength, digest) {
  if (digest.toLowerCase() !== 'sha256') {
    throw new Error('Only sha256 PBKDF2 is supported')
  }
  return Buffer.from(pbkdf2(sha256, password, salt, { c: iterations, dkLen: keyLength }))
}

function incrementCounter(iv, increment) {
  const result = Buffer.from(iv)
  let carry = BigInt(increment)
  for (let index = result.length - 1; index >= 0 && carry > 0n; index--) {
    const value = BigInt(result[index]) + (carry & 0xffn)
    result[index] = Number(value & 0xffn)
    carry = (carry >> 8n) + (value >> 8n)
  }
  return result
}

const subtleCiphers = typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle

// CryptoKey import is async, so keys are cached by hex bytes and shared
// through their import promise. Import once, reuse across cipher instances.
const ctrKeyCache = new Map()

function ctrKey(keyBytes) {
  const hex = Buffer.from(keyBytes).toString('hex')
  let entry = ctrKeyCache.get(hex)
  if (!entry) {
    entry = globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt'])
    ctrKeyCache.set(hex, entry)
  }
  return entry
}

// Async variant backed by the runtime's WebCrypto implementation (~15 MiB/s
// in the txiki guest vs ~35 KB/s for the pure-JS noble fallback). update()
// returns a Promise<Buffer>; callers in the stream adapters await it.
function createSubtleCipheriv(key, iv) {
  const keyPromise = ctrKey(key)
  const baseIv = Buffer.from(iv)
  let position = 0
  return {
    update(data) {
      const input = Buffer.from(data)
      const offset = position % 16
      const counter = incrementCounter(baseIv, Math.floor(position / 16))
      position += input.length
      const aligned = offset === 0 ? input : Buffer.concat([Buffer.alloc(offset), input])
      return keyPromise
        .then((cryptoKey) => globalThis.crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, cryptoKey, aligned))
        .then((output) => Buffer.from(output).subarray(offset))
    },
    final() {
      return Buffer.alloc(0)
    },
  }
}

// Sync fallback for runtimes without WebCrypto (pure JS, slow but correct).
function createNobleCipheriv(key, iv) {
  const sourceKey = Buffer.from(key)
  const sourceIv = Buffer.from(iv)
  let position = 0
  return {
    update(data) {
      const input = Buffer.from(data)
      const offset = position % 16
      const counter = incrementCounter(sourceIv, Math.floor(position / 16))
      const prefixed = Buffer.alloc(offset + input.length)
      input.copy(prefixed, offset)
      const output = nobleCtr(sourceKey, counter).encrypt(prefixed)
      position += input.length
      return Buffer.from(output.subarray(offset))
    },
    final() {
      return Buffer.alloc(0)
    },
  }
}

function createCipheriv(algorithm, key, iv) {
  if (algorithm !== 'aes-128-ctr') {
    throw new Error('Only aes-128-ctr is supported')
  }
  if (subtleCiphers) {
    return createSubtleCipheriv(key, iv)
  }
  return createNobleCipheriv(key, iv)
}

function randomUUID() {
  return globalThis.crypto.randomUUID()
}

const crypto = { createHash, pbkdf2Sync, createCipheriv, randomUUID }

export { createHash, pbkdf2Sync, createCipheriv, randomUUID }
export default crypto
