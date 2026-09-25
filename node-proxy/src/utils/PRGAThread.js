function PRGAExcute(data) {
  let { sbox: S, i, j, position } = data
  for (let k = 0; k < position; k++) {
    i = (i + 1) % 256
    j = (j + S[i]) % 256
    const temp = S[i]
    S[i] = S[j]
    S[j] = temp
  }
  return { sbox: S, i, j }
}

// 与上游 os.cpus().length / 2 + 1 一致：多留一个 worker 供后续 RC4 预加载使用
const workerNum = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2) + 1)
const workerList = []
let index = 0

function createWorker() {
  let worker = null
  try {
    // URL.pathname 在 Windows 下是 '/C:/...'（URL 规范保留前导斜杠），
    // txiki Worker 需要原生路径：剥掉盘符前的斜杠，POSIX 路径不受影响。
    const workerPath = decodeURIComponent(new URL('./prga-worker.mjs', import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
    worker = new Worker(workerPath)
  } catch (error) {
    console.log('@@worker_create_error', error)
    return null
  }
  worker.pending = new Map()
  worker.failed = false
  worker.onmessage = ({ data: { msgId, resData } }) => {
    const pending = worker.pending.get(msgId)
    if (!pending) {
      return
    }
    worker.pending.delete(msgId)
    pending.resolve(resData)
  }
  worker.onerror = (error) => {
    worker.failed = true
    console.log('@@worker_error', error)
    for (const pending of worker.pending.values()) {
      pending.resolve(PRGAExcute(pending.data))
    }
    worker.pending.clear()
  }
  return worker
}

for (let i = 0; i < workerNum; i++) {
  workerList.push(createWorker())
}

export default function PRGAExcuteThread(data) {
  return new Promise((resolve) => {
    const worker = workerList[index++ % workerList.length]
    if (!worker || worker.failed) {
      resolve(PRGAExcute(data))
      return
    }
    const msgId = crypto.randomUUID()
    const timer = setTimeout(() => {
      if (!worker.pending.has(msgId)) {
        return
      }
      worker.pending.delete(msgId)
      resolve(PRGAExcute(data))
    }, 30 * 1000)
    worker.pending.set(msgId, {
      data,
      resolve(result) {
        clearTimeout(timer)
        resolve(result)
      },
    })
    try {
      worker.postMessage({ msgId, data })
    } catch (error) {
      worker.failed = true
      worker.pending.delete(msgId)
      clearTimeout(timer)
      console.log('@@worker_post_error', error)
      resolve(PRGAExcute(data))
    }
  })
}
