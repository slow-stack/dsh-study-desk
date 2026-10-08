import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addTask,
  emptyReview,
  gradeTask,
  logSession,
  minutesByTask,
  normalize,
  reviewStats,
  scheduleTask,
  setJournal,
  updateSettings,
  updateTask,
  weeklyReport,
} from '../desk.js'
import { fromMarkdown, mergeMarkdown, toMarkdown } from '../markdown.js'

const T0 = new Date(2026, 9, 8, 12, 0, 0).getTime() // 2026-10-08 12:00 本地

function seeded() {
  const s = normalize(null)
  updateSettings(s, { dailyGoalMin: 180 })
  const a = addTask(s, { title: '复习公共政策第 3 章', subject: '631 公共管理', estimateMin: 45, tags: '#名词解释, 错题' }, T0)
  addTask(s, { title: '英语阅读 2018 Text1', subject: '英语', review: true }, T0)
  const done = addTask(s, { title: '马原原理背诵', subject: '政治', status: 'done' }, T0)
  updateTask(s, a.id, { note: '重点：议程设置\n多看两页' }, T0)
  scheduleTask(s, a.id, '2026-10-06', T0)
  gradeTask(s, done.id, 'good', T0)
  logSession(s, { minutes: 50, at: T0, taskId: a.id })
  setJournal(s, '政治选择题错 8 个', undefined, T0)
  return s
}

const extras = (s) => ({
  minutesByTask: minutesByTask(s),
  reviewStats: reviewStats(s, T0),
  weekly: weeklyReport(s, 2, T0),
  daysToExam: 72,
})

test('导出再读回：卡片、标签、笔记、复习排期与复盘都对得上', () => {
  const s = seeded()
  const md = toMarkdown(s, T0, extras(s))
  const t = normalize(null)
  const res = mergeMarkdown(t, fromMarkdown(md))
  assert.equal(res.added, 3)

  const byTitle = new Map(t.tasks.map((x) => [x.title, x]))
  const a = byTitle.get('复习公共政策第 3 章')
  assert.equal(a.subject, '631 公共管理')
  assert.equal(a.status, 'todo')
  assert.equal(a.estimateMin, 45)
  assert.deepEqual(a.tags, ['名词解释', '错题'])
  assert.equal(a.note, '重点：议程设置\n多看两页')
  assert.equal(a.review.due, '2026-10-06')
  assert.equal(byTitle.get('马原原理背诵').status, 'done')
  assert.equal(byTitle.get('英语阅读 2018 Text1').review.due, '2026-10-08')
  assert.equal(t.journal['2026-10-08'], '政治选择题错 8 个')

  // 再导一次、再读一次：不该冒出新卡，也不该改到东西
  const again = mergeMarkdown(t, fromMarkdown(toMarkdown(t, T0, extras(t))))
  assert.deepEqual(again, { added: 0, updated: 0 })
})

const HAND = `# 考研工作台

## 复盘

### 2026-10-07
昨天把第一章过了一遍

## 631 公共管理

### 待办

- [ ] 手写的一张卡，没有机器字段
	- 笔记：手写的

### 已完成

- [x] 带排期的卡 <!-- desk:id:fixed-1 due:2026-10-05 interval:6 ease:2.5 reps:3 lapses:1 done:1760000000000 -->

## 周报

| 周起 | 分钟 |
| --- | --- |
| 2026-10-05 | 999 |
`

test('手写 Markdown：无 id 当新卡，展示型章节不会被当成科目', () => {
  const s = normalize(null)
  const res = mergeMarkdown(s, fromMarkdown(HAND))
  assert.equal(res.added, 2)
  assert.equal(res.updated, 0)
  const hand = s.tasks.find((t) => t.title === '手写的一张卡，没有机器字段')
  assert.equal(hand.subject, '631 公共管理')
  assert.equal(hand.note, '笔记：手写的')
  const scheduled = s.tasks.find((t) => t.title === '带排期的卡')
  assert.equal(scheduled.status, 'done')
  assert.equal(scheduled.review.due, '2026-10-05')
  assert.equal(scheduled.review.intervalDays, 6)
  assert.equal(s.journal['2026-10-07'], '昨天把第一章过了一遍')
  assert.ok(!s.tasks.some((t) => t.subject === '周报'))
})

test('id 对得上就是更新，不是又建一张', () => {
  const s = normalize(null)
  s.tasks.push({
    id: 'fixed-1', title: '旧标题', status: 'todo', subject: '', note: '', estimateMin: 0,
    createdAt: T0, updatedAt: T0, doneAt: null, order: 0, pinned: false, tags: [], review: emptyReview(),
  })
  const res = mergeMarkdown(s, fromMarkdown(HAND))
  assert.equal(res.added, 1)
  assert.equal(res.updated, 1)
  const card = s.tasks.find((t) => t.id === 'fixed-1')
  assert.equal(card.title, '带排期的卡')
  assert.equal(card.status, 'done')
  assert.ok(card.doneAt > 0)
  // 两张卡：一张按 id 更新，一张新建
  assert.equal(s.tasks.length, 2)
})

test('导出的 Markdown 里不含本机路径，注释能被 Obsidian 阅读模式藏起来', () => {
  const src = seeded()
  const md = toMarkdown(src, T0, extras(src))
  assert.ok(!/[A-Za-z]:[\\/]/.test(md), '不该出现 Windows 绝对路径')
  assert.match(md, /<!-- desk:id:[0-9a-f-]+[^>]*due:2026-10-06/)
  assert.match(md, /## 复习 · 到期/)
})
