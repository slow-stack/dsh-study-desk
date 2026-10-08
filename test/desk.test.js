import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addTask,
  dayKey,
  daysUntil,
  dueQueue,
  gradeTask,
  heatmap,
  journalRecent,
  logSession,
  normalize,
  normalizeTags,
  reorderTask,
  reviewStats,
  scheduleTask,
  setJournal,
  streak,
  subjectBreakdown,
  summary,
  todayMinutes,
  updateSettings,
  weeklyReport,
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

// ---------------------------------------------------------------- 间隔重复

test('间隔重复：三档打分推进间隔，「忘了」清零但留在今晚', () => {
  const s = normalize(null)
  const a = addTask(s, { title: '名词解释：新公共管理', tags: '#名词解释, 错题', review: true }, T0)
  assert.deepEqual(a.tags, ['名词解释', '错题'])
  assert.equal(a.review.due, '2026-10-08')

  gradeTask(s, a.id, 'good', T0)
  assert.equal(a.review.intervalDays, 1)
  assert.equal(a.review.due, '2026-10-09')
  assert.equal(a.review.reps, 1)

  // 第二天再「记得」：按难度 2.5 倍乘，且一定比上一次长
  const day2 = new Date(2026, 9, 9, 9, 0, 0).getTime()
  gradeTask(s, a.id, 'good', day2)
  assert.equal(a.review.intervalDays, 3)
  assert.equal(a.review.due, '2026-10-12')

  // 「忘了」：间隔清零、难度下调、次数归零，今天之内再来一遍
  const day3 = new Date(2026, 9, 12, 9, 0, 0).getTime()
  gradeTask(s, a.id, 'again', day3)
  assert.equal(a.review.intervalDays, 0)
  assert.equal(a.review.due, '2026-10-12')
  assert.equal(a.review.reps, 0)
  assert.equal(a.review.lapses, 1)
  assert.equal(a.review.ease, 2.3)

  // 「很简单」：首次就给 4 天，难度上调
  const b = addTask(s, { title: '英语单词：ambiguous' })
  scheduleTask(s, b.id, null, T0)
  gradeTask(s, b.id, 'easy', T0)
  assert.equal(b.review.intervalDays, 4)
  assert.equal(b.review.due, '2026-10-12')
  assert.equal(b.review.ease, 2.65)

  assert.equal(s.reviews.length, 4)
  assert.equal(s.reviews[0].grade, 'good')
  assert.equal(s.reviews[0].taskId, a.id)
})

test('到期队列按逾期程度排，已完成的卡也照样复习', () => {
  const s = normalize(null)
  const late = addTask(s, { title: '马原原理' })
  const fresh = addTask(s, { title: '当代中国政府' })
  const done = addTask(s, { title: '英语阅读技巧', status: 'done' })
  scheduleTask(s, late.id, '2026-10-06', T0)
  scheduleTask(s, fresh.id, '2026-10-08', T0)
  scheduleTask(s, done.id, '2026-10-07', T0)
  assert.deepEqual(dueQueue(s, T0).map((t) => t.title), ['马原原理', '英语阅读技巧', '当代中国政府'])

  const st = reviewStats(s, T0)
  assert.equal(st.scheduled, 3)
  assert.equal(st.due, 3)
  assert.equal(st.overdue, 2)
  assert.equal(st.dueToday, 1)
  assert.equal(st.doneToday, 0)

  // 打完一张就少一张：due 是「还没过的」，doneToday 是「今天已经过的」
  gradeTask(s, late.id, 'good', T0)
  const after = reviewStats(s, T0)
  assert.equal(after.due, 2)
  assert.equal(after.doneToday, 1)
  assert.equal(after.weekDone, 1)

  const sum = summary(s, T0)
  assert.equal(sum.review.due, 2)
  assert.equal(sum.due[0].title, '英语阅读技巧')
  assert.equal(sum.due[0].overdueDays, 1)
  assert.equal(sum.journal.today, '')
})

// ---------------------------------------------------------------- 标签 / 复盘 / 周报

test('标签归一化：吃串、去井号、去重、有上限', () => {
  assert.deepEqual(normalizeTags('#名词解释, 错题,, 名词解释'), ['名词解释', '错题'])
  assert.deepEqual(normalizeTags([' 带空格 ', '带空格']), ['带空格'])
  assert.deepEqual(normalizeTags(null), [])
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => 't' + i)).length, 12)
})

test('日复盘：写今天、按日期倒序、空文本即删除', () => {
  const s = normalize(null)
  setJournal(s, '政治选择题错 8 个，都在马原', undefined, T0)
  setJournal(s, '上午效率还行', '2026-10-06', T0)
  assert.equal(s.journal['2026-10-08'], '政治选择题错 8 个，都在马原')
  assert.deepEqual(journalRecent(s, T0, 5).map((x) => x.date), ['2026-10-08', '2026-10-06'])

  setJournal(s, '   ', '2026-10-06', T0)
  assert.equal(s.journal['2026-10-06'], undefined)
  assert.throws(() => setJournal(s, 'x', '10月6号', T0), /YYYY-MM-DD/)
})

test('周报：按周聚合时长与科目，并给出与上周的增减', () => {
  const s = normalize(null)
  updateSettings(s, { dailyGoalMin: 180 })
  logSession(s, { minutes: 100, at: T0, subject: '631 公共管理' })
  logSession(s, { minutes: 20, at: T0, subject: '政治' })
  const lastWeek = new Date(2026, 8, 30, 10, 0, 0).getTime()
  logSession(s, { minutes: 60, at: lastWeek, subject: '英语' })

  const rep = weeklyReport(s, 2, T0)
  assert.equal(rep.weeks.length, 2)
  assert.equal(rep.weeks[0].key, '2026-09-28')
  assert.equal(rep.weeks[0].minutes, 60)
  assert.equal(rep.weeks[0].deltaPct, null)
  assert.equal(rep.weeks[1].minutes, 120)
  assert.equal(rep.weeks[1].deltaPct, 100)
  assert.equal(rep.weeks[1].current, true)
  assert.equal(rep.weeks[1].daysActive, 1)
  assert.deepEqual(rep.weeks[1].bySubject, [
    { label: '631 公共管理', minutes: 100 },
    { label: '政治', minutes: 20 },
  ])
  assert.equal(rep.goalWeekly, 1260)
})

test('老数据没有 review / tags / journal 字段也能补齐', () => {
  const s = normalize({ version: 1, tasks: [{ id: 'a', title: '旧卡', status: 'doing' }], sessions: [] })
  assert.deepEqual(s.tasks[0].tags, [])
  assert.equal(s.tasks[0].review.due, null)
  assert.equal(s.tasks[0].review.ease, 2.5)
  assert.deepEqual(s.reviews, [])
  assert.deepEqual(s.journal, {})
  assert.equal(s.settings.reviewQueueSize, 10)
})
