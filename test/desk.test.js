import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addTask,
  dayKey,
  daysUntil,
  heatmap,
  logSession,
  normalize,
  reorderTask,
  streak,
  subjectBreakdown,
  todayMinutes,
  updateSettings,
} from '../desk.js'
import { completeTimer, pauseTimer, reconcileTimer, remainingMs, startTimer } from '../timer.js'

const T0 = new Date(2026, 9, 8, 12, 0, 0).getTime() // 2026-10-08 12:00 本地
const MIN = 60000

test('dayKey / daysUntil 按本地日期算', () => {
  assert.equal(dayKey(T0), '2026-10-08')
  assert.equal(daysUntil('2026-12-19', T0), 72)
  assert.equal(daysUntil('2026-10-08', T0), 0)
  assert.equal(daysUntil('2026-10-07', T0), -1)
  assert.equal(daysUntil('不是日期', T0), null)
})

test('新建卡片进待办列，move 到已完成会盖上完成时间', () => {
  const s = normalize(null)
  const a = addTask(s, { title: '开题报告第三章', subject: '631 公共管理' })
  assert.equal(a.status, 'todo')
  assert.equal(a.doneAt, null)
  assert.equal(s.tasks.length, 1)

  reorderTask(s, a.id, 'done', null)
  assert.equal(s.tasks[0].status, 'done')
  assert.ok(s.tasks[0].doneAt > 0)

  reorderTask(s, a.id, 'doing', null)
  assert.equal(s.tasks[0].doneAt, null)
})

test('三列排序各自独立', () => {
  const s = normalize(null)
  const a = addTask(s, { title: 'A' })
  const b = addTask(s, { title: 'B' })
  const c = addTask(s, { title: 'C' })
  reorderTask(s, c.id, 'todo', a.id) // C 插到 A 之前
  const col = s.tasks.filter((t) => t.status === 'todo').sort((x, y) => x.order - y.order).map((t) => t.title)
  assert.deepEqual(col, ['C', 'A', 'B'])
  assert.equal(b.status, 'todo')
})

test('热力图按分钟分档，超过每日目标为最高档', () => {
  const s = normalize(null)
  updateSettings(s, { dailyGoalMin: 180 })
  // 今天 200 分钟、往前依次 100/60/20，再往前一天没学（level 0）
  const mins = [200, 100, 60, 20]
  mins.forEach((m, offset) => {
    logSession(s, { minutes: m, at: T0 - offset * 86400000, title: 'x' })
  })
  const hm = heatmap(s, 2, T0)
  const flat = hm.weeks.flatMap((w) => w.days).filter(Boolean)
  const byKey = new Map(flat.map((d) => [d.key, d]))
  assert.equal(byKey.get('2026-10-08').level, 4) // 200 >= 180
  assert.equal(byKey.get('2026-10-07').level, 3) // 100 < 180 但 >= 90
  assert.equal(byKey.get('2026-10-06').level, 2) // 60
  assert.equal(byKey.get('2026-10-05').level, 1) // 20
  assert.equal(byKey.get('2026-10-04').level, 0) // 0 分钟
  assert.equal(hm.total, 380)
  assert.equal(hm.activeDays, 4)
})

test('连续打卡：门槛以下不算，今天没学不断昨天的连击', () => {
  const s = normalize(null)
  updateSettings(s, { streakMin: 10 })
  // 昨天、前天各 30 分钟，今天还没开始
  logSession(s, { minutes: 30, at: T0 - 86400000 })
  logSession(s, { minutes: 30, at: T0 - 2 * 86400000 })
  assert.equal(streak(s, T0), 2)

  // 今天只学了 5 分钟，不够门槛，连击不变
  logSession(s, { minutes: 5, at: T0 })
  assert.equal(streak(s, T0), 2)
  assert.equal(todayMinutes(s, T0), 5)
})

test('休息时长不计入热力图与统计', () => {
  const s = normalize(null)
  logSession(s, { minutes: 25, at: T0, kind: 'focus', subject: '英语' })
  logSession(s, { minutes: 5, at: T0, kind: 'break' })
  assert.equal(todayMinutes(s, T0), 25)
  assert.equal(heatmap(s, 1, T0).total, 25)
  const brk = subjectBreakdown(s, 7, T0)
  assert.deepEqual(brk, [{ label: '英语', minutes: 25 }])
})

test('番茄钟走完会把专注补记进去，并自动摆上休息', () => {
  const s = normalize(null)
  updateSettings(s, { focusMin: 25, shortBreakMin: 5, roundsBeforeLong: 4 })
  startTimer(s, { kind: 'focus' }, T0)
  assert.equal(s.timer.endsAt, T0 + 25 * MIN)

  // 还没到点：什么都不发生
  assert.equal(reconcileTimer(s, T0 + 24 * MIN), false)
  assert.equal(s.sessions.length, 0)

  // 到点：记 25 分钟，切成 5 分钟短休
  assert.equal(reconcileTimer(s, T0 + 25 * MIN), true)
  assert.equal(s.sessions.length, 1)
  assert.equal(s.sessions[0].minutes, 25)
  assert.equal(s.sessions[0].kind, 'focus')
  assert.equal(s.timer.kind, 'break')
  assert.equal(s.timer.minutes, 5)

  // 短休也到点：清空
  assert.equal(reconcileTimer(s, T0 + 30 * MIN), true)
  assert.equal(s.timer, null)
})

test('关掉页面很久后回来，不会摆一个已经过期的计时器', () => {
  const s = normalize(null)
  updateSettings(s, { focusMin: 25, shortBreakMin: 5 })
  startTimer(s, { kind: 'focus' }, T0)
  reconcileTimer(s, T0 + 6 * 3600 * 1000) // 六小时后才回来
  assert.equal(s.timer, null)
  assert.equal(s.sessions.length, 1)
})

test('暂停过的一段按真实投入记账，不虚报整段', () => {
  const s = normalize(null)
  updateSettings(s, { focusMin: 25, shortBreakMin: 5 })
  startTimer(s, { kind: 'focus' }, T0)
  pauseTimer(s, T0 + 10 * MIN)      // 跑了 10 分钟就暂停
  assert.equal(remainingMs(s.timer, T0 + 60 * MIN), 15 * MIN)
  completeTimer(s, T0 + 20 * MIN)   // 暂停期间不算时间
  assert.equal(s.sessions.length, 1)
  assert.equal(s.sessions[0].minutes, 10)
  assert.equal(s.timer.kind, 'break')
})

test('连续四轮专注后是长休息', () => {
  const s = normalize(null)
  updateSettings(s, { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsBeforeLong: 4 })
  let now = T0
  for (let i = 0; i < 4; i += 1) {
    startTimer(s, { kind: 'focus' }, now)
    reconcileTimer(s, now + 25 * MIN)   // 专注结束 → 休息
    const breakMin = s.timer ? s.timer.minutes : 0
    if (i < 3) assert.equal(s.timer.kind, 'break')
    assert.equal(breakMin, i === 3 ? 15 : 5)
    now += (25 + breakMin) * MIN
    reconcileTimer(s, now)              // 休息结束
  }
  assert.equal(s.sessions.filter((x) => x.kind === 'focus').length, 4)
})
