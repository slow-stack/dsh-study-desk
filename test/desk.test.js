import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addTask,
  dayKey,
  daysUntil,
  dueQueue,
  focusByName,
  gradeTask,
  goalInfo,
  heatmap,
  journalRecent,
  logSession,
  memoryCurve,
  normalize,
  normalizeTags,
  parseMilestones,
  reorderTask,
  reviewForecast,
  reviewPlan,
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
import { completeTimer, makeTimer, pauseTimer, reconcileTimer, remainingMs, startTimer } from '../timer.js'

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

// ---------------------------------------------------------------- 遗忘曲线 / 到期预报 / 今日建议

const DAY = 86400000
const rev = (o = {}) => ({ due: null, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, lastAt: null, ...o })

test('记忆曲线：到期那天正好落到 90%，稳定度高的卡更平', () => {
  const due = memoryCurve(rev({ due: '2026-10-08', intervalDays: 6, reps: 2, lastAt: T0 - 6 * DAY }), T0)
  assert.equal(due.points.length, 31)
  assert.equal(due.spanDays, 30)
  assert.equal(due.stabilityDays, 56.9)
  assert.equal(due.todayRetention, 90)
  assert.equal(due.todayIndex, 6)
  assert.equal(due.dueIndex, 6)
  assert.ok(due.points.every((p) => Number.isInteger(p) && p >= 0 && p <= 100))
  for (let i = 1; i < due.points.length; i += 1) {
    assert.ok(due.points[i] <= due.points[i - 1], `第 ${i} 点比前一点还高：曲线不该回弹`)
  }

  // 横轴一样长，所以「30 天后还剩多少」可以直接比大小 —— 这张图的意义就在这
  const steady = memoryCurve(rev({ due: '2026-11-08', intervalDays: 60, lastAt: T0 }), T0)
  const fresh = memoryCurve(rev({ due: '2026-10-09', intervalDays: 1, lastAt: T0 }), T0)
  assert.equal(steady.points[0], 100)
  assert.equal(fresh.points[0], 100)
  assert.ok(steady.points[30] > fresh.points[30], `稳的 ${steady.points[30]} 该高于脆的 ${fresh.points[30]}`)
})

test('记忆曲线：没排过期的卡按一天一过画，忘过的更陡', () => {
  const plain = memoryCurve(rev(), T0)
  const lapsed = memoryCurve(rev({ lapses: 3 }), T0)
  assert.equal(plain.stabilityDays, 9.5)
  assert.equal(lapsed.stabilityDays, 4.7)
  assert.ok(lapsed.points[15] < plain.points[15])
  assert.equal(plain.todayRetention, 100)

  const blank = memoryCurve(null, T0)
  assert.equal(blank.points.length, 31)
  assert.equal(blank.dueIndex, null)
  assert.equal(blank.todayRetention, 100)
})

test('记忆曲线：逾期很久横轴自动放宽，最多 90 天', () => {
  const long = memoryCurve(rev({ due: '2026-08-08', intervalDays: 6, lastAt: T0 - 60 * DAY }), T0)
  assert.equal(long.spanDays, 67)
  assert.equal(long.todayIndex, 27)
  const ancient = memoryCurve(rev({ intervalDays: 6, lastAt: T0 - 200 * DAY }), T0)
  assert.equal(ancient.spanDays, 90)
  assert.equal(ancient.todayIndex, 30)
  assert.ok(ancient.todayRetention <= 5, `200 天没碰，记忆只剩 ${ancient.todayRetention}%`)
})

test('到期预报：逾期都算今天，7 天之外单独数', () => {
  const s = normalize(null)
  const a = addTask(s, { title: '逾期两天' })
  const b = addTask(s, { title: '今天' })
  const c = addTask(s, { title: '三天后' })
  const d = addTask(s, { title: '一个月后' })
  addTask(s, { title: '压根没排期' })
  scheduleTask(s, a.id, '2026-10-06', T0)
  scheduleTask(s, b.id, '2026-10-08', T0)
  scheduleTask(s, c.id, '2026-10-11', T0)
  scheduleTask(s, d.id, '2026-11-08', T0)

  const f = reviewForecast(s, 7, T0)
  assert.equal(f.days.length, 7)
  assert.equal(f.days[0].key, '2026-10-08')
  assert.equal(f.days[0].isToday, true)
  assert.equal(f.days[0].count, 2)
  assert.equal(f.days[0].overdue, 1)
  assert.equal(f.days[3].key, '2026-10-11')
  assert.equal(f.days[3].count, 1)
  assert.equal(f.days[6].key, '2026-10-14')
  assert.equal(f.later, 1)
  assert.equal(f.total, 3)
  assert.equal(f.max, 2)

  assert.deepEqual(reviewForecast(s, 1, T0).days.map((x) => x.count), [2])
  assert.equal(reviewForecast(s, 99, T0).days.length, 30)
  assert.equal(reviewForecast(normalize(null), 7, T0).total, 0)
})

test('今日建议：按科目轮换、写明理由、量太大劝她别硬扛', () => {
  const s = normalize(null)
  const old631 = addTask(s, { title: '名词解释：新公共管理', subject: '631 公共管理' })
  const old864 = addTask(s, { title: '数字治理', subject: '864' })
  const eng = addTask(s, { title: '长难句拆分', subject: '英语' })
  scheduleTask(s, old631.id, '2026-10-05', T0)
  scheduleTask(s, old864.id, '2026-10-07', T0)
  scheduleTask(s, eng.id, '2026-10-08', T0)

  const p = reviewPlan(s, T0, 3)
  assert.equal(p.due, 3)
  assert.equal(p.cap, 10)
  assert.equal(p.items.length, 3)
  assert.deepEqual(p.items.map((i) => i.subject), ['631 公共管理', '864', '英语'])
  assert.equal(p.items[0].overdueDays, 3)
  assert.equal(p.items[0].reason, '逾期 3 天')
  assert.equal(p.items[2].reason, '新卡 · 先过一遍')
  assert.ok(p.advice.includes('一口气过完'), p.advice)

  // 到期量超过一轮的 1.5 倍 → 建议顺延，而不是硬扛
  updateSettings(s, { reviewQueueSize: 2 })
  for (let i = 0; i < 4; i += 1) {
    const t = addTask(s, { title: `政治补 ${i}`, subject: '政治' })
    scheduleTask(s, t.id, '2026-10-08', T0)
  }
  const heavy = reviewPlan(s, T0, 3)
  assert.equal(heavy.due, 7)
  assert.equal(heavy.cap, 2)
  assert.equal(heavy.items.length, 3)
  assert.ok(heavy.advice.includes('别硬扛'), heavy.advice)
  assert.ok(heavy.advice.includes('3.5 倍'), heavy.advice)

  // 中间档：多于建议张数、但不到 1.5 倍 → 按顺序开头
  const mid = normalize(null)
  const many = []
  for (let i = 0; i < 6; i += 1) {
    const t = addTask(mid, { title: `M${i}` })
    scheduleTask(mid, t.id, '2026-10-08', T0)
    many.push(t)
  }
  assert.ok(reviewPlan(mid, T0, 3).advice.includes('按这个顺序开头'))

  const empty = reviewPlan(normalize(null), T0, 3)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.due, 0)
  assert.equal(empty.advice, null)
})

test('今日建议的理由按「逾期 → 忘过 → 难度 → 新卡 → 今天到期」取第一条', () => {
  const mk = (review) => normalize({
    tasks: [{ id: 'x', title: 'X', subject: '864', status: 'todo', order: 0, review: { lastAt: T0 - 3 * DAY, ...review } }],
    sessions: [],
    reviews: [],
    journal: {},
  })
  const reasonOf = (review) => reviewPlan(mk(review), T0, 1).items[0].reason
  assert.equal(reasonOf({ due: '2026-10-08', intervalDays: 3, ease: 2.5, reps: 3, lapses: 0 }), '今天到期')
  assert.equal(reasonOf({ due: '2026-10-08', intervalDays: 3, ease: 2.5, reps: 3, lapses: 2 }), '忘过 2 次')
  assert.equal(reasonOf({ due: '2026-10-08', intervalDays: 3, ease: 1.8, reps: 3, lapses: 0 }), '难度偏高')
  assert.equal(reasonOf({ due: '2026-10-08', intervalDays: 3, ease: 2.5, reps: 0, lapses: 0 }), '新卡 · 先过一遍')
  assert.equal(reasonOf({ due: '2026-10-05', intervalDays: 3, ease: 2.5, reps: 3, lapses: 0 }), '逾期 3 天')
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

test('目标与节点：默认是开箱示例，节点文案由 desk.js 一处算', () => {
  const s = normalize(null)
  const g = goalInfo(s, T0)
  assert.equal(g.date, '2026-12-19')
  assert.equal(g.days, 72)
  assert.ok(g.milestones.length >= 1)
  const pre = g.milestones.find((m) => m.label === '预报名')
  assert.equal(pre.tone, 'future')
  assert.equal(pre.text, '明天开始')
  assert.equal(g.milestones.find((m) => m.label === '正式报名').approx, false)
  assert.equal(g.milestones.find((m) => m.label === '网上确认').approx, true)
})

test('目标可改成答辩 / 投稿；日期留空就不显示倒计时', () => {
  const s = normalize(null)
  updateSettings(s, { goalLabel: '博士资格考试答辩', goalDate: '2026-10-20', goalEnd: '', goalNote: ' committees 面试', milestonesText: '提交材料 2026-10-12\n答辩 2026-10-20~2026-10-21 约' })
  const g = goalInfo(s, T0)
  assert.equal(g.label, '博士资格考试答辩')
  assert.equal(g.days, 12)
  assert.equal(g.end, '2026-10-20')
  assert.deepEqual(g.milestones.map((m) => m.label), ['提交材料', '答辩'])
  assert.equal(g.milestones[1].approx, true)

  updateSettings(s, { goalDate: '' })
  const off = goalInfo(s, T0)
  assert.equal(off.date, '')
  assert.equal(off.days, null)
})

test('节点文本解析：坏行跳过、倒序区间丢掉、最多 12 条', () => {
  const list = parseMilestones('报名 2026-10-15~2026-10-24\n这行没有日期\n确认 2026-11-05\n倒着写 2026-12-01~2026-11-01\n\n  空白两侧  2026-11-09  ')
  assert.deepEqual(list.map((m) => m.label), ['报名', '确认', '空白两侧'])
  assert.equal(list[1].end, '2026-11-05')
  assert.equal(parseMilestones(Array.from({ length: 30 }, (_, i) => `n${i} 2026-10-0${(i % 8) + 1}`).join('\n')).length, 12)
  assert.deepEqual(parseMilestones(null), [])
})

test('老数据没有 review / tags / journal 字段也能补齐', () => {
  const s = normalize({ version: 1, tasks: [{ id: 'a', title: '旧卡', status: 'doing' }], sessions: [] })
  assert.deepEqual(s.tasks[0].tags, [])
  assert.equal(s.tasks[0].review.due, null)
  assert.equal(s.tasks[0].review.ease, 2.5)
  assert.deepEqual(s.reviews, [])
  assert.deepEqual(s.journal, {})
  assert.equal(s.settings.reviewQueueSize, 10)
  assert.equal(s.settings.goalDate, '2026-12-19')
  assert.ok(s.settings.milestonesText.includes('预报名'))
})

// ---------------------------------------------------------------------------
// 番茄命名 + 饼图聚合（v0.6.0）
// ---------------------------------------------------------------------------

test('focusByName 按番茄名字聚合，只算窗口内的 focus', () => {
  const s = normalize(null)
  logSession(s, { minutes: 25, at: T0, kind: 'focus', title: '864 论述练习' })
  logSession(s, { minutes: 25, at: T0 - 30 * MIN, kind: 'focus', title: '864 论述练习' })
  logSession(s, { minutes: 45, at: T0, kind: 'focus', title: '631 复习' })
  logSession(s, { minutes: 5, at: T0, kind: 'break', title: '' })
  logSession(s, { minutes: 25, at: T0 - 10 * 86400000, kind: 'focus', title: '背单词' })

  const day = focusByName(s, 1, T0)
  assert.deepEqual(day.map((x) => x.label), ['864 论述练习', '631 复习'])
  assert.deepEqual(day[0], { label: '864 论述练习', minutes: 50, segments: 2 })
  assert.equal(day[1].minutes, 45)

  const month = focusByName(s, 30, T0)
  assert.ok(month.some((x) => x.label === '背单词'))
  assert.equal(month.reduce((m, x) => m + x.minutes, 0), 50 + 45 + 25)
})

test('focusByName 把没有名字的番茄归进「未命名」', () => {
  const s = normalize(null)
  logSession(s, { minutes: 25, at: T0, kind: 'focus' })
  logSession(s, { minutes: 25, at: T0, kind: 'focus', title: '  ' })
  const rows = focusByName(s, 1, T0)
  assert.deepEqual(rows, [{ label: '未命名', minutes: 50, segments: 2 }])
})

test('起钟命名优先级：手写名 > 卡标题 > 兜底桶名；break 不兜底', () => {
  const s = normalize(null)
  const card = addTask(s, { title: '631 公共管理 · 今日复习', status: 'doing' })

  const t1 = makeTimer(s, { kind: 'focus', taskId: card.id, name: '名词解释八连' }, T0)
  assert.equal(t1.title, '名词解释八连')

  const t2 = makeTimer(s, { kind: 'focus', taskId: card.id }, T0)
  assert.equal(t2.title, '631 公共管理 · 今日复习')

  const t3 = makeTimer(s, { kind: 'focus' }, T0)
  assert.equal(t3.title, '专注（未命名）')

  const t4 = makeTimer(s, { kind: 'break' }, T0)
  assert.equal(t4.title, '')

  const t5 = makeTimer(s, { kind: 'focus', name: '这个名字长得有点离谱了所以要截断到二十四个字符为止啦' }, T0)
  assert.equal(t5.title.length, 24)
})

