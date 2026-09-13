import { Buffer } from 'buffer'

// Coalesce small inbound chunks before handing them to the transform
// callback. FlowEnc algorithms are chunk-boundary invariant (proven by the
// vector suite), so merging is byte-identical while cutting per-chunk
// Promise/crypto-call overhead by orders of magnitude.
const coalesceLimit = 64 * 1024

class Transform {
  constructor(options) {
    this.destroyed = false
    let pending = []
    let pendingLength = 0

    const runTransform = (chunk, controller) =>
      new Promise((resolve, reject) => {
        options.transform(chunk, 'buffer', (error, data) => {
          if (error) {
            reject(error)
            return
          }
          // The data may be a Promise when the crypto adapter is async
          // (WebCrypto-backed cipher.update). Await it before enqueueing.
          Promise.resolve(data)
            .then((resolved) => {
              if (resolved !== undefined && resolved !== null) {
                controller.enqueue(Buffer.from(resolved))
              }
              resolve()
            })
            .catch(reject)
        })
      })

    const flushPending = (controller) => {
      if (pendingLength === 0) {
        return Promise.resolve()
      }
      const merged = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength)
      pending = []
      pendingLength = 0
      return runTransform(merged, controller)
    }

    this.stream = new TransformStream({
      transform: (chunk, controller) => {
        const input = Buffer.from(chunk)
        pending.push(input)
        pendingLength += input.length
        if (pendingLength >= coalesceLimit) {
          return flushPending(controller)
        }
        return Promise.resolve()
      },
      flush: (controller) => flushPending(controller),
    })
    this.readable = this.stream.readable
    this.writable = this.stream.writable
  }

  destroy() {
    this.destroyed = true
  }
}

export { Transform }
export default { Transform }
