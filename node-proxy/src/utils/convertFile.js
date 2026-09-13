'use strict'
import fs from 'fs'
import path from 'path'

import FlowEnc from './flowEnc'
import { encodeName, decodeName } from './commonUtil'

export async function searchFile(filePath) {
  const fileArray = []
  const files = await fs.readdir(filePath)
  for (const child of files) {
    const filePath2 = path.join(filePath, child),
      info = await fs.stat(filePath2)
    if (info.isDirectory()) {
      const deepArr = await searchFile(filePath2)
      fileArray.push(...deepArr)
    } else {
      const data = { size: info.size, filePath: filePath2 }
      fileArray.push(data)
    }
  }
  return fileArray
}

// encrypt
export async function encryptFile(password, encType, enc, encPath, outPath, encName) {
  const start = Date.now()
  const interval = setInterval(() => {
    console.log(new Date(), 'waiting finish!!!')
  }, 2000)
  if (!path.isAbsolute(encPath)) {
    encPath = path.join(process.cwd(), encPath)
  }
  outPath = outPath || path.join(process.cwd(), 'outFile', Date.now().toString())
  console.log('you input:', password, encType, enc, encPath)
  if (!(await fs.exists(encPath))) {
    console.log('you input filePath is not exists ')
    return
  }
  // init outpath dir
  if (!(await fs.exists(outPath))) {
    await fs.mkdir(outPath, { recursive: true })
  }
  // input file path
  const allFilePath = await searchFile(encPath)
  const tempDir = path.join(outPath, '.temp')
  if (!(await fs.exists(tempDir))) {
    await fs.mkdir(tempDir, { recursive: true })
  }
  let promiseArr = []
  for (const fileInfo of allFilePath) {
    const { filePath, size } = fileInfo
    let relativePath = filePath.substring(encPath.length)
    const fileName = path.basename(relativePath),
      ext = path.extname(relativePath),
      childPath = path.dirname(relativePath)
    if (enc === 'enc' && encName) {
      const newFileName = encodeName(password, encType, fileName) + ext
      relativePath = path.join(childPath, newFileName)
    }
    if (enc === 'dec' && encName) {
      const newFileName = decodeName(password, encType, ext !== '' ? fileName.substring(0, fileName.length - ext.length) : fileName)
      if (newFileName) {
        relativePath = path.join(childPath, newFileName)
      }
    }
    const outFilePath = path.join(outPath, relativePath)
    const outFilePathTemp = path.join(tempDir, relativePath)
    await fs.mkdir(path.dirname(outFilePathTemp), { recursive: true })
    await fs.mkdir(path.dirname(outFilePath), { recursive: true })
    // 开始加密
    if (size === 0) {
      continue
    }
    const flowEnc = new FlowEnc(password, encType, size)
    // console.log('@@outFilePath', outFilePath, encType, size)
    const writeStream = await fs.createWriteStream(outFilePathTemp)
    const readStream = await fs.createReadStream(filePath)
    const transform = enc === 'enc' ? flowEnc.encryptTransform() : flowEnc.decryptTransform()
    const promise = readStream.pipeThrough(transform.stream).pipeTo(writeStream).then(async () => {
      console.log('@@finish filePath', filePath, outFilePathTemp)
      await fs.rename(outFilePathTemp, outFilePath)
    })
    promiseArr.push(promise)
    if (promiseArr.length > 50) {
      await Promise.all(promiseArr)
      promiseArr = []
    }
  }
  await Promise.all(promiseArr)
  await fs.rm(tempDir, { recursive: true })
  console.log('@@all finish', ((Date.now() - start) / 1000).toFixed(2) + 's')
  clearInterval(interval)
}

export function convertFile(...args) {
  const statTime = Date.now()
  if (args.length > 3) {
    encryptFile(...args).then(() => {
      console.log('all file finish enc!!! time:', Date.now() - statTime)
      process.exit(0)
    })
  } else {
    console.error('input error， example param:nodejs-linux passwd12345 rc4 enc ./myfolder /tmp/outPath encname  ')
    process.exit(1)
  }
}
