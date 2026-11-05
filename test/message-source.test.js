/**
 * 消息 source 形状守卫（回归：session-26939e9f 的 `format v4 message requires a producer-owned source kind`）。
 *
 * 背景：宿主会话格式 v4 把旧的共享包装 `{ kind: 'plugin', plugin: … }` 判为退役语法。
 * app.asar 里 lib/types/message-sources.js 的 source() 只要看到 kind === 'plugin' 就抛，
 * 而插件塞进 `agent.followup(...)` 的消息会被原样写进 `agent/inbox/spliced.data.inserted[]`，
 * 于是整条 splice 落盘失败，那个会话从此每一轮都报这行错。
 *
 * 所以这里锁两件事：
 *   1. 番茄钟提醒的 source 是 `plugin:<包名>` 这种生产者自己命名的 kind；
 *   2. 源码里不许再出现裸 `kind: 'plugin'`（静态扫，防回潮）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MESSAGE_SOURCE_KIND, name, timerEndSource } from '../index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 复刻宿主的 v4 准入判据（app.asar: lib/types/message-sources.js 的 source()）。 */
function assertProducerOwnedSource(message) {
  const value = message && message.source
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'source 必须是对象')
  assert.equal(typeof value.kind, 'string', 'source.kind 必须是字符串')
  assert.ok(value.kind.length > 0, 'source.kind 不能是空串')
  assert.notEqual(value.kind, 'plugin', 'source.kind 不许是退役写法 plugin')
}

test('MESSAGE_SOURCE_KIND 是生产者自己命名的 kind', () => {
  assert.equal(MESSAGE_SOURCE_KIND, 'plugin:dsh-study-desk')
  assert.equal(MESSAGE_SOURCE_KIND, `plugin:${name}`)
})

test('番茄钟提醒的 source 能过宿主 v4 准入', () => {
  const at = 1770000000000
  const source = timerEndSource(at)
  assertProducerOwnedSource({ source })
  assert.deepEqual(source, {
    kind: 'plugin:dsh-study-desk',
    plugin: 'dsh-study-desk',
    event: 'timer-end',
    at,
  })
})

test('timerEndSource 的 at 默认取当前时间，且不共享同一个对象', () => {
  const before = Date.now()
  const a = timerEndSource()
  const b = timerEndSource()
  assert.ok(a.at >= before)
  assert.notEqual(a, b, '每次都要新对象：消息 source 会被宿主深冻结')
})

test('源码里不许出现裸 kind: \'plugin\'（静态扫，防回潮）', () => {
  // 只看宿主半边的源码；client.js 是浏览器 bundle，它的 kind 全是诊断/计时器，
  // 但为免以后有人往里面塞会话消息，也一并扫。
  const files = ['index.js', 'desk.js', 'timer.js', 'markdown.js', 'bbdc.js', 'client.js']
  const banned = /kind\s*:\s*(['"`])plugin\1/
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const hit = banned.exec(text)
    assert.equal(hit, null, `${file} 里还有裸 kind 'plugin'：${hit ? hit[0] : ''}`)
  }
})
