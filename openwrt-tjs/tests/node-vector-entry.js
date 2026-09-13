import crypto from 'node:crypto'
// 向量入口按算法名从 node-proxy 原版源码取，用于与适配版逐字节对照。
// 这 5 个文件与上游 upstream/alist-encrypt 对应文件逐字节相同（cmp 校验），
// 故一律指向仓库内副本，避免对仓库外目录的依赖，保证独立检出即可构建/运行。
import AesCTR from '../../node-proxy/src/utils/aesCTR'
import Rc4Md5 from '../../node-proxy/src/utils/rc4Md5'
import ChaCha20 from '../../node-proxy/src/utils/chaCha20'
import MixEnc from '../../node-proxy/src/utils/mixEnc'
import { encodeName, decodeName, encodeFromFolder, decodeFromFolder } from '../../node-proxy/src/utils/commonUtil'
import { runVectorSuite } from './vector-suite.js'

async function main() {
  const result = await runVectorSuite({ AesCTR, Rc4Md5, ChaCha20, MixEnc, crypto, encodeName, decodeName, encodeFromFolder, decodeFromFolder })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
