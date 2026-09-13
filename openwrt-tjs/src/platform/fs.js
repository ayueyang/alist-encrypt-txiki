import { Buffer } from 'buffer'

const decoder = new TextDecoder()

async function exists(filePath) {
  try {
    await tjs.stat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function mkdir(filePath, options = {}) {
  return await tjs.makeDir(filePath, { recursive: Boolean(options.recursive), mode: options.mode || 0o755 })
}

async function readFile(filePath, encoding) {
  const data = await tjs.readFile(filePath)
  return encoding ? decoder.decode(data) : Buffer.from(data)
}

async function writeFile(filePath, data) {
  await tjs.writeFile(filePath, typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
}

async function readdir(filePath) {
  const result = []
  const directory = await tjs.readDir(filePath)
  try {
    for await (const entry of directory) {
      result.push(entry.name)
    }
  } finally {
    await directory.close()
  }
  return result
}

async function stat(filePath) {
  const value = await tjs.stat(filePath)
  return {
    ...value,
    isDirectory() {
      return value.isDirectory
    },
    isFile() {
      return value.isFile
    },
  }
}

async function rename(oldPath, newPath) {
  await tjs.rename(oldPath, newPath)
}

async function rm(filePath, options = {}) {
  await tjs.remove(filePath, { recursive: Boolean(options.recursive) })
}

async function createReadStream(filePath) {
  const file = await tjs.open(filePath, 'r')
  return file.readable
}

async function createWriteStream(filePath) {
  const file = await tjs.open(filePath, 'w')
  return file.writable
}

const fs = { exists, mkdir, readFile, writeFile, readdir, stat, rename, rm, createReadStream, createWriteStream }

export { exists, mkdir, readFile, writeFile, readdir, stat, rename, rm, createReadStream, createWriteStream }
export default fs
