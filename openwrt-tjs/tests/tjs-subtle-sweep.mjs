// subtle AES-CTR per-call latency sweep
import { Buffer } from 'buffer'

const MIB = 1024 * 1024
const subtle = globalThis.crypto.subtle
const keyBytes = Buffer.alloc(16, 0x3a)
const counter = Buffer.alloc(16, 0x5c)
const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt'])
await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, Buffer.alloc(16)) // warm-up

for (const size of [1024, 16384, 65536, 262144, 1048576]) {
  const total = Math.max(1, Math.round((4 * MIB) / size))
  const chunk = Buffer.alloc(size, 0x77)
  const start = Date.now()
  for (let i = 0; i < total; i++) {
    await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, chunk)
  }
  const elapsed = (Date.now() - start) / 1000
  const rate = (total * size) / elapsed / MIB
  const perCall = (elapsed / total) * 1000
  console.log(`[sweep] size=${size}B calls=${total} time=${elapsed.toFixed(2)}s rate=${rate.toFixed(2)} MiB/s perCall=${perCall.toFixed(3)}ms`)
}
console.log('[sweep] done')
