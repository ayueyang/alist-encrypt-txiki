import levelDB from '../../node-proxy/src/utils/levelDB'

function assertEqual(name, actual, expected) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${name}: expected ${expectedJson}, got ${actualJson}`)
  }
  console.log(`DAO_PASS ${name} ${actualJson}`)
}

const phase = tjs.args.at(-1)

if (phase === 'write') {
  assertEqual('missing', await levelDB.getValue('missing'), null)
  await levelDB.setValue('permanent', { version: 1 })
  await levelDB.setValue('permanent', { version: 2 })
  assertEqual('overwrite', await levelDB.getValue('permanent'), { version: 2 })

  await levelDB.setExpire('ttl-live', { value: 'live' }, 600)
  assertEqual('ttl-live', await levelDB.getValue('ttl-live'), { value: 'live' })
  await levelDB.setExpire('ttl-expired', { value: 'expired' }, -1)
  assertEqual('ttl-expired', await levelDB.getValue('ttl-expired'), null)

  const emptyValues = { emptyString: '', zero: 0, falseValue: false, nullValue: null }
  for (const [key, value] of Object.entries(emptyValues)) {
    await levelDB.setValue(key, value)
    assertEqual(key, await levelDB.getValue(key), value)
  }

  await Promise.all(Array.from({ length: 16 }, (_, index) => levelDB.setValue(`concurrent-${index}`, { index })))
  const concurrent = await Promise.all(Array.from({ length: 16 }, (_, index) => levelDB.getValue(`concurrent-${index}`)))
  assertEqual(
    'concurrent',
    concurrent,
    Array.from({ length: 16 }, (_, index) => ({ index }))
  )

  await levelDB.setExpire('restart-expire', { value: 'short' }, 1)
  console.log('DAO_PHASE write complete')
} else if (phase === 'read') {
  // write 阶段最后一条是 1 秒 TTL 的 restart-expire；两个阶段是两个进程，
  // 进程启动开销可能小于 1 秒，会让本断言变成时序竞态。显式等过 TTL 再断言。
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assertEqual('restart-permanent', await levelDB.getValue('permanent'), { version: 2 })
  assertEqual('restart-expired', await levelDB.getValue('restart-expire'), null)
  assertEqual('restart-live-ttl', await levelDB.getValue('ttl-live'), { value: 'live' })
  // 与上游定时清理同形：遍历过期数据后逐条删除
  for (const data of await levelDB.expiredData()) {
    levelDB.removeByKey(data.key)
  }
  console.log('DAO_PHASE read complete')
} else {
  throw new Error(`Unknown DAO test phase: ${phase}`)
}

tjs.exit(0)
