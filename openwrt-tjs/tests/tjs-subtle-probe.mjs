// Focused probe: crypto.subtle AES-CTR availability + speed in tjs guest.
import { Buffer } from 'buffer'

const MIB = 1024 * 1024
console.log('[probe] subtle exists:', !!(globalThis.crypto && globalThis.crypto.subtle))
const subtle = globalThis.crypto && globalThis.crypto.subtle
if (subtle) {
  try {
    const keyBytes = Buffer.alloc(16, 0x3a)
    const counter = Buffer.alloc(16, 0x5c)
    const t0 = Date.now()
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt'])
    const chunk = Buffer.alloc(MIB, 0x77)
    const out = await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, chunk)
    console.log(`[probe] importKey+1MiB encrypt ok, out=${out.byteLength}, setup+first=${((Date.now() - t0) / 1000).toFixed(2)}s`)
    const start = Date.now()
    for (let i = 0; i < 4; i++) {
      await subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, key, chunk)
    }
    const elapsed = (Date.now() - start) / 1000
    const rate = 4 * MIB / elapsed / MIB
    console.log(`[probe] subtle 4x1MiB time=${elapsed.toFixed(2)}s rate=${rate.toFixed(3)} MiB/s (${Math.round(rate * 1024)} KB/s)`)
  } catch (err) {
    console.log(`[probe] subtle AES-CTR failed: ${err && err.message}`)
  }
}
// Worker availability sanity (for offload option)
try {
  const w = new Worker(new URL('./prga-worker.mjs', import.meta.url))
  await w.terminate()
  console.log('[probe] Worker construct+terminate OK')
} catch (err) {
  console.log(`[probe] Worker failed: ${err && err.message}`)
}
console.log('[probe] done')
