import { Database } from 'tjs:sqlite'

/**
 * 封装新方法
 */
class Nedb {
  constructor(dbFile) {
    this.dbFile = dbFile
    this.database = null
    this.setStatement = null
    this.getStatement = null
    this.removeStatement = null
  }

  async load() {
    if (this.database) {
      return
    }
    this.database = new Database(this.dbFile)
    this.database.exec('PRAGMA journal_mode = WAL;')
    this.database.exec('CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, expire INTEGER NOT NULL, value TEXT)')
    this.setStatement = this.database.prepare('INSERT OR REPLACE INTO data (key, expire, value) VALUES (?, ?, ?)')
    this.getStatement = this.database.prepare('SELECT expire, value FROM data WHERE key = ?')
    this.removeStatement = this.database.prepare('DELETE FROM data WHERE key = ?')
    this.expiredStatement = this.database.prepare('SELECT key, expire FROM data WHERE expire > 0 AND expire < ?')
  }

  async setValue(key, value) {
    await this.load()
    console.log('@@setValue', key, value)
    this.setStatement.run(key, -1, JSON.stringify(value))
  }

  async setExpire(key, value, second = 6 * 10) {
    await this.load()
    const expire = Date.now() + second * 1000
    this.setStatement.run(key, expire, JSON.stringify(value))
  }

  async getValue(key) {
    await this.load()
    // NeDB 允许用任意值查询并返回空结果；SQLite 预处理语句无法绑定 undefined/对象，
    // 这里对齐 NeDB 语义，避免上游「未登录返回 401」变成 500。
    if (typeof key !== 'string' && typeof key !== 'number') {
      return null
    }
    const data = this.getStatement.all(key)[0]
    if (!data) {
      return null
    }
    if (data.expire < 0 || (data.expire && data.expire > Date.now())) {
      return JSON.parse(data.value)
    }
    this.removeStatement.run(key)
    return null
  }

  // 过期的数据，供定时清理使用（对齐原 NeDB 实现里 find({}) 的调用点）
  expiredData() {
    return this.expiredStatement.all(Date.now())
  }

  // 删除某条数据
  removeByKey(key) {
    this.removeStatement.run(key)
  }
}

const nedb = new Nedb(process.cwd() + '/data.sqlite')

// 定时清除过期的数据
setInterval(async () => {
  const allData = await nedb.expiredData()
  for (const data of allData) {
    const { key, expire } = data
    if (expire && expire > 0 && expire < Date.now()) {
      console.log('@@expire:', key, expire, Date.now())
      nedb.removeByKey(key)
    }
  }
}, 30 * 1000)

export default nedb
