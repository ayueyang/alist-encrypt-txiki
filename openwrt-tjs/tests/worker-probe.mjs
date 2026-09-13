const workerPath = new URL('../dist/prga-worker.mjs', import.meta.url).pathname
const worker = new Worker(workerPath)
const input = {
  sbox: Array.from({ length: 256 }, (_, index) => index),
  i: 0,
  j: 0,
  position: 7,
}

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Worker response timeout')), 5000)
  worker.onerror = (error) => {
    clearTimeout(timer)
    reject(error)
  }
  worker.onmessage = ({ data }) => {
    clearTimeout(timer)
    resolve(data)
  }
  worker.postMessage({ msgId: 'worker-probe', data: input })
})

worker.terminate()
console.log(JSON.stringify({ workerPath, result }))
