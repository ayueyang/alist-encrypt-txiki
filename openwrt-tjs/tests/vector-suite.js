const offsets = [0, 1, 7, 15, 16, 17, 63, 64, 65, 999999, 1000000, 1000001]
const chunks = [1, 7, 15, 16, 17, 63, 64, 65, 1024, 65535]
const size = 1000065
const password = 'password'

function sourceData() {
  const data = Buffer.alloc(size)
  for (let index = 0; index < data.length; index++) {
    data[index] = (index * 31 + 7) & 0xff
  }
  return data
}

function digest(crypto, data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function transformByChunks(instance, method, data) {
  const output = []
  let position = 0
  let chunkIndex = 0
  while (position < data.length) {
    const length = chunks[chunkIndex++ % chunks.length]
    const end = Math.min(data.length, position + length)
    // AesCTR may resolve asynchronously (WebCrypto-backed adapter);
    // awaiting also covers the synchronous algorithms unchanged.
    output.push(Buffer.from(await instance[method](Buffer.from(data.subarray(position, end)))))
    position = end
  }
  return Buffer.concat(output)
}

async function algorithmResult(name, create, encryptMethod, decryptMethod, setPosition, crypto, onProgress) {
  onProgress(`${name}:encrypt-chunked`)
  const plain = sourceData()
  const encrypted = await transformByChunks(create(), encryptMethod, plain)
  onProgress(`${name}:encrypt-one-chunk`)
  const encryptedOneChunk = Buffer.from(await create()[encryptMethod](Buffer.from(plain)))
  onProgress(`${name}:decrypt`)
  const decrypted = await transformByChunks(create(), decryptMethod, encrypted)
  const range = {}
  for (const offset of offsets) {
    onProgress(`${name}:range:${offset}`)
    const ranged = create()
    await setPosition(ranged, offset)
    const plainRange = await transformByChunks(ranged, decryptMethod, encrypted.subarray(offset))
    range[offset] = Buffer.compare(plainRange, plain.subarray(offset)) === 0
  }
  return {
    name,
    encryptedSha256: digest(crypto, encrypted),
    chunkInvariant: Buffer.compare(encrypted, encryptedOneChunk) === 0,
    decryptOk: Buffer.compare(decrypted, plain) === 0,
    range,
  }
}

export async function runVectorSuite(
  { AesCTR, Rc4Md5, ChaCha20, MixEnc, crypto, encodeName, decodeName, encodeFromFolder, decodeFromFolder },
  onProgress = () => {}
) {
  const results = []
  results.push(
    await algorithmResult(
      'aesctr',
      () => new AesCTR(password, size),
      'encrypt',
      'decrypt',
      (instance, offset) => instance.setPositionAsync(offset),
      crypto,
      onProgress
    )
  )
  results.push(
    await algorithmResult(
      'rc4',
      () => new Rc4Md5(password, size),
      'encrypt',
      'encrypt',
      (instance, offset) => instance.setPositionAsync(offset),
      crypto,
      onProgress
    )
  )
  results.push(
    await algorithmResult(
      'chacha20',
      () => new ChaCha20(password, size),
      'encrypt',
      'decrypt',
      (instance, offset) => instance.setPositionAsync(offset),
      crypto,
      onProgress
    )
  )
  results.push(
    await algorithmResult('mix', () => new MixEnc(password), 'encodeData', 'decodeData', async () => {}, crypto, onProgress)
  )

  const plainName = '测试 文件.2026.txt'
  const encodedName = encodeName(password, 'aesctr', plainName)
  const folderNameEnc = 'my-video_' + encodeFromFolder(password, 'aesctr', 'folder-password', 'chacha20')
  const name = {
    encodedName,
    decodedName: decodeName(password, 'aesctr', encodedName),
    folderNameEnc,
    folderDecoded: decodeFromFolder(password, 'aesctr', folderNameEnc),
  }
  const vectors = {
    pbkdf2: crypto.pbkdf2Sync(password, 'AES-CTR', 1000, 16, 'sha256').toString('hex'),
    md5: crypto.createHash('md5').update('alist-encrypt').digest('hex'),
    sha256: crypto.createHash('sha256').update('alist-encrypt').digest('hex'),
  }

  const ok =
    results.every((result) => result.chunkInvariant && result.decryptOk && Object.values(result.range).every(Boolean)) &&
    name.decodedName === plainName &&
    name.folderDecoded.folderPasswd === 'folder-password' &&
    name.folderDecoded.folderEncType === 'chacha20'

  return { ok, size, chunks, offsets, vectors, name, results }
}
