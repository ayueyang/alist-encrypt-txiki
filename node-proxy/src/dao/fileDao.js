import levelDB from '../utils/levelDB'
import crypto from 'crypto'

export const fileInfoTable = 'fileInfoTable_'

// 缓存多少分钟
const cacheTime = 60 * 24

export async function initFileTable() {
  console.log('init db')
}

// 目录路径末尾的斜杠不参与身份判断：MKCOL 可能不带尾斜杠、PROPFIND 带尾斜杠，
// 两者必须落到同一个缓存键，否则目录建出来了却查不到（U-07）。
function normalizePathKey(key) {
  return key.length > 1 ? key.replace(/\/+$/, '') : key
}

// 缓存文件信息，存储文件的云盘真实路径，去掉decodeURIComponent，兼容带%符号的路径
export async function cacheFileInfo(fileInfo, decodeExc = false) {
  if (decodeExc) fileInfo.path = decodeURI(fileInfo.path)
  const pathKey = normalizePathKey(fileInfoTable + fileInfo.path)
  fileInfo.table = fileInfoTable
  await levelDB.setExpire(pathKey, fileInfo, 1000 * 60 * cacheTime)
}

// 获取文件信息，偶尔要清理一下缓存，这里存储的是真实的文件路径，云盘的路径
export async function getFileInfo(path, decodeExc = false) {
  let pathKey = fileInfoTable + path
  if (decodeExc) pathKey = decodeURI(pathKey)
  pathKey = normalizePathKey(pathKey)
  const value = await levelDB.getValue(pathKey)
  return value
}

// 获取文件信息
export async function getAllFileInfo() {
  const value = await levelDB.getValue({ table: fileInfoTable })
  return value
}
