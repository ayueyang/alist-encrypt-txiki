// Guest-side AES-CTR benchmark for the R-25 upload defect.
// Runs under tjs in the OpenWrt guest; also usable on Node for comparison.
// Reports throughput for the current per-call-recreate cipher shim,
// chunk-size sweeps, and crypto.subtle availability/speed.

import { Buffer } from 'buffer'
import { createCipheriv } from '../src/platform/crypto.js'

const MIB = 1024 * 1024
const TOTAL = 4 * MIB

function keyIv() {
  const key = Buffer.alloc(16, 0x3a)
  const iv = Buffer.alloc(16, 0x5c)
  return { key, iv }
}

async function benchChunked(label, chunkSize, encryptor) {
  const { key, iv } = keyIv()
  const cipher = createCipheriv('aes-128-ctr', key, iv)
  const chunk = Buffer.alloc(chunkSize, 0x77)
  const full = Math.floor(TOTAL / chunkSize)
  const start = Date.now()
  let outLen = 0
  for (let i = 0; i < full; i++) {
    outLen += cipher.update(chunk).length
  }
  const elapsed = (Date.now() - start) / 1000
  const rate = outLen / elapsed / MIB
  console.log(`[bench] ${label} chunk=${chunkSize}B bytes=${outLen} time=${elapsed.toFixed(2)}s rate=${rate.toFixed(3)} MiB/s (${Math.round(rate * 1024)} KB/s)`)
  return rate
}

async function benchSubtle() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) {
    console.log('[bench] crypto.subtle: NOT AVAILABLE')
    return
  }
  try {
    const keyBytes = Buffer.alloc(16, 0x3a)
    const counter = Buffer.alloc(16, 0x5c)
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt'])
    const chunk = Buffer.alloc(MIB, 0x77)
    // warm-up + correctness smoke
    const first = await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, chunk)
    console.log(`[bench] crypto.subtle AES-CTR available, 1MiB block out=${first.byteLength}`)
    const start = Date.now()
    for (let i = 0; i < TOTAL / MIB; i++) {
      await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, chunk)
    }
    const elapsed = (Date.now() - start) / 1000
    const rate = TOTAL / elapsed / MIB
    console.log(`[bench] subtle 1MiB x4 time=${elapsed.toFixed(2)}s rate=${rate.toFixed(3)} MiB/s`)
  } catch (err) {
    console.log(`[bench] crypto.subtle AES-CTR failed: ${err && err.message}`)
  }
}

async function benchTransformOverhead(chunkSize) {
  // Replicates src/platform/stream.js Transform + a sync transform callback,
  // to measure per-chunk Promise/TransformStream scheduling overhead in tjs.
  const { key, iv } = keyIv()
  const cipher = createCipheriv('aes-128-ctr', key, iv)
  const transform = (chunk, encoding, next) => next(null, cipher.update(chunk))
  const stream = new TransformStream({
    transform: (chunk, controller) =>
      new Promise((resolve, reject) => {
        transform(Buffer.from(chunk), 'buffer', (error, data) => {
          if (error) {
            reject(error)
            return
          }
          if (data !== undefined && data !== null) {
            controller.enqueue(Buffer.from(data))
          }
          resolve()
        })
      }),
  })
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const chunk = Buffer.alloc(chunkSize, 0x77)
  const count = TOTAL / chunkSize
  const start = Date.now()
  let outLen = 0
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      outLen += value.length
    }
  })()
  for (let i = 0; i < count; i++) {
    await writer.write(chunk)
  }
  await writer.close()
  await pump
  const elapsed = (Date.now() - start) / 1000
  const rate = outLen / elapsed / MIB
  console.log(`[bench] TransformStream+Promise chunk=${chunkSize}B time=${elapsed.toFixed(2)}s rate=${rate.toFixed(3)} MiB/s`)
}

console.log('[bench] === AES-CTR shim (current per-call recreate) ===')
for (const size of [1024, 4096, 16384, 65536, 262144, TOTAL]) {
  await benchChunked('shim', size, null)
}
console.log('[bench] === TransformStream pipeline overhead ===')
for (const size of [16384, 65536, 262144]) {
  await benchTransformOverhead(size)
}
console.log('[bench] === crypto.subtle (native/WASM path?) ===')
await benchSubtle()
console.log('[bench] done')
