import crypto from 'crypto'
import AesCTR from '../../node-proxy/src/utils/aesCTR'
import Rc4Md5 from '../../node-proxy/src/utils/rc4Md5'
import ChaCha20 from '../../node-proxy/src/utils/chaCha20'
import MixEnc from '../../node-proxy/src/utils/mixEnc'
import { encodeName, decodeName, encodeFromFolder, decodeFromFolder } from '../../node-proxy/src/utils/commonUtil'
import { runVectorSuite } from './vector-suite.js'

const result = await runVectorSuite(
  { AesCTR, Rc4Md5, ChaCha20, MixEnc, crypto, encodeName, decodeName, encodeFromFolder, decodeFromFolder },
  (step) => console.log(`VECTOR_STEP ${step}`)
)
console.log(JSON.stringify(result))
if (!result.ok) {
  throw new Error('OpenWrt vector suite failed')
}
tjs.exit(0)
