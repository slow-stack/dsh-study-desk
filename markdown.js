/**
 * dsh-study-desk —— Markdown 导出 / 读回
 *
 * 为什么要有这一层：desk.json 虽然是人可读的，但 Obsidian 用户的工作单元是「笔记」，
 * 不是 JSON。导出一份 desk.md 之后，看板就能进 vault、能双链、能进 git 做 diff；
 * 手改了再读回来也认。
 *
 * 格式取舍：
 *   - 章节 = 科目，三级标题 = 看板三列，一眼可读；
 *   - 每张卡的机器字段（id / 预计 / 累计 / 复习排期）放在行尾的 HTML 注释里，
 *     Obsidian 阅读模式不显示它，源码模式能看到，删掉也不影响读回（会当成新卡）；
 *   - 笔记正文是卡片下面的缩进列表；
 *   - 「复盘 / 专注记录 / 周报」这些区块是给人看的，读回时只认「复盘」，其余忽略。
 *
 * 纯函数，不碰文件系统，可独立单测。
 */

import {
  STATUSES,
  dayKey,
  emptyReview,
  normalizeTags,
} from './desk.js'

const STATUS_HEADING = { todo: '待办', doing: '进行中', done: '已完成' }
const HEADING_STATUS = { '待办': 'todo', '进行中': 'doing', '已完成': 'done' }
/** 读回时要跳过的展示型章节（复盘单独处理）。 */
const DISPLAY_SECTIONS = ['复习', '专注记录', '周报', '说明', '统计']

const META_RE = /<!--\s*desk:([^>]*?)\s*-->\s*$/
const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/

function metaString(pairs) {
  const parts = []
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue
    parts.push(`${k}:${String(v).replace(/\s+/g, ' ')}`)
  }
  return parts.length ? ` <!-- desk:${parts.join(' ')} -->` : ''
}

function parseMeta(raw) {
  const out = {}
  for (const token of String(raw || '').trim().split(/\s+/)) {
    const i = token.indexOf(':')
    if (i > 0) out[token.slice(0, i)] = token.slice(i + 1)
  }
  return out
}

/** 标题里不能出现换行与注释终止符。 */
function oneLine(text) {
  return String(text || '').replace(/\s*\n\s*/g, ' ').replace(/-->/g, '->').trim()
}

/**
 * 生成整份 Markdown。extra 可选：{ minutesByTask, reviewStats, weekly }
 * —— 调用方（宿主半边）已经有这些数，传进来就省得这里重算。
 */
export function toMarkdown(state, now = Date.now(), extra = {}) {
  const byTask = extra.minutesByTask || new Map()
  const stats = extra.reviewStats || null
  const lines = []
  const front = ['---', 'kind: dsh-study-desk', 'version: 1', `generatedAt: ${new Date(now).toISOString()}`]
  if (extra.daysToExam !== undefined && extra.daysToExam !== null) front.push(`daysToExam: ${extra.daysToExam}`)
  front.push('---', '')
  lines.push(...front)

  lines.push('# 考研工作台')
  lines.push('')
  lines.push('> 这一份是 dsh-study-desk 生成的可编辑视图：改了科目分节、勾选状态或笔记正文，')
  lines.push('> 回到工作台点「从 Markdown 读回」即可。行尾 `<!-- desk:… -->` 是机器字段，删掉不影响读回。')
  lines.push('')

  // 复盘：最近 14 天，日期倒序
  const journal = Object.entries(state.journal || {})
    .filter(([k]) => k <= dayKey(now))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
  if (journal.length) {
    lines.push('## 复盘')
    lines.push('')
    for (const [date, text] of journal) {
      lines.push(`### ${date}`)
      lines.push('')
      for (const para of String(text).split('\n')) lines.push(para)
      lines.push('')
    }
  }

  // 到期队列（只读展示）
  const queue = (state.tasks || []).filter((t) => t.review && t.review.due && t.review.due <= dayKey(now))
    .sort((a, b) => (a.review.due < b.review.due ? -1 : 1))
  if (queue.length) {
    lines.push('## 复习 · 到期')
    lines.push('')
    if (stats) lines.push(`> 待复习 ${stats.due} 张（逾期 ${stats.overdue}）· 今天已经过 ${stats.doneToday} 次`)
    for (const t of queue) {
      lines.push(`- [ ] ${oneLine(t.title)}${metaString([['ref', t.id], ['due', t.review.due]])}`)
    }
    lines.push('')
  }

  // 看板：科目 → 三列
  const subjects = new Map()
  for (const t of state.tasks || []) {
    const key = t.subject || '未归类'
    if (!subjects.has(key)) subjects.set(key, [])
    subjects.get(key).push(t)
  }
  const order = [...subjects.keys()].sort((a, b) => (a === '未归类' ? 1 : b === '未归类' ? -1 : a.localeCompare(b, 'zh-CN')))
  for (const subject of order) {
    lines.push(`## ${subject}`)
    lines.push('')
    for (const status of STATUSES) {
      const col = subjects.get(subject)
        .filter((t) => t.status === status)
        .sort((a, b) => (b.pinned - a.pinned) || (a.order - b.order))
      if (!col.length) continue
      lines.push(`### ${STATUS_HEADING[status]}`)
      lines.push('')
      for (const t of col) {
        const box = status === 'done' ? 'x' : ' '
        const meta = metaString([
          ['id', t.id],
          ['est', t.estimateMin || null],
          ['spent', byTask.get ? byTask.get(t.id) : null],
          ['tags', (t.tags || []).join('|') || null],
          ['due', t.review && t.review.due],
          ['interval', t.review && t.review.due ? t.review.intervalDays : null],
          ['ease', t.review && t.review.due ? t.review.ease : null],
          ['reps', t.review && t.review.due ? t.review.reps : null],
          ['lapses', t.review && t.review.due ? t.review.lapses : null],
          ['done', t.doneAt],
        ])
        lines.push(`- [${box}] ${oneLine(t.title)}${meta}`)
        for (const para of String(t.note || '').split('\n')) {
          if (para.trim()) lines.push(`\t- ${para.trim()}`)
        }
      }
      lines.push('')
    }
  }

  // 专注记录（只读展示）
  const weekly = extra.weekly
  if (weekly && weekly.weeks && weekly.weeks.length) {
    lines.push('## 周报')
    lines.push('')
    lines.push('| 周起 | 分钟 | 活跃天数 | 复习次数 | 环比 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const w of weekly.weeks.slice(-8)) {
      const delta = w.deltaPct === null ? '—' : `${w.deltaPct > 0 ? '+' : ''}${w.deltaPct}%`
      lines.push(`| ${w.key} | ${w.minutes} | ${w.daysActive} | ${w.reviews} | ${delta} |`)
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 读回：只解析出「应该长什么样」的补丁，不直接改 state。
 * 返回 { cards: [...], journal: { 日期: 文本 }, warnings: [...] }
 */
export function fromMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/)
  const cards = []
  const journal = {}
  const warnings = []
  let subject = ''
  let status = 'todo'
  let inJournal = false
  let journalDate = ''
  let current = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      const title = h2[1].trim()
      subject = ''
      status = 'todo'
      current = null
      inJournal = title === '复盘'
      journalDate = ''
      if (inJournal || !DISPLAY_SECTIONS.some((p) => title.startsWith(p))) subject = title
      continue
    }
    const h3 = /^###\s+(.*)$/.exec(line)
    if (h3) {
      const title = h3[1].trim()
      current = null
      if (inJournal && /^\d{4}-\d{2}-\d{2}$/.test(title)) {
        journalDate = title
        journal[title] = ''
      } else if (!inJournal) {
        status = HEADING_STATUS[title] || status
      }
      continue
    }

    if (inJournal) {
      if (journalDate && line.trim() && !/^>\s/.test(line)) {
        journal[journalDate] = journal[journalDate] ? `${journal[journalDate]}\n${line.trim()}` : line.trim()
      }
      continue
    }

    if (!subject) continue

    const task = TASK_RE.exec(line)
    if (task) {
      const body = task[2]
      const metaMatch = META_RE.exec(body)
      const meta = metaMatch ? parseMeta(metaMatch[1]) : {}
      const title = oneLine(body.replace(META_RE, ''))
      if (!title) { warnings.push('跳过一张没有标题的卡：' + line.trim()); current = null; continue }
      current = {
        id: meta.id || null,
        title,
        subject: subject === '未归类' ? '' : subject,
        status: meta.done ? 'done' : status,
        note: '',
        estimateMin: Number(meta.est) || 0,
        tags: normalizeTags((meta.tags || '').split('|')),
        review: meta.due
          ? {
            due: meta.due,
            intervalDays: Number(meta.interval) || 0,
            ease: Number(meta.ease) || 2.5,
            reps: Number(meta.reps) || 0,
            lapses: Number(meta.lapses) || 0,
            lastAt: null,
          }
          : emptyReview(),
        doneAt: Number(meta.done) || null,
      }
      cards.push(current)
      continue
    }

    // 缩进列表 = 上一张卡的笔记
    const note = /^\s+[-*]\s+(.*)$/.exec(line)
    if (note && current) {
      current.note = current.note ? `${current.note}\n${note[1].trim()}` : note[1].trim()
    }
  }

  return { cards, journal, warnings }
}

/**
 * 把读回来的补丁并进 state：id 对得上就改，对不上就新建（保留 md 里的 id）。
 * 返回 { added, updated }。md 里没有的卡不动 —— 读回是「合并」不是「覆盖」。
 */
export function mergeMarkdown(state, parsed) {
  let added = 0
  let updated = 0
  for (const card of parsed.cards || []) {
    const existing = card.id ? state.tasks.find((t) => t.id === card.id) : null
    if (existing) {
      const changed = ['title', 'subject', 'note', 'estimateMin', 'tags', 'review'].some((k) => {
        const a = JSON.stringify(existing[k])
        const b = JSON.stringify(card[k])
        if (a === b) return false
        existing[k] = card[k]
        return true
      })
      const statusChanged = STATUSES.includes(card.status) && existing.status !== card.status
      if (statusChanged) {
        existing.status = card.status
        existing.doneAt = card.status === 'done' ? (existing.doneAt || card.doneAt || Date.now()) : null
      }
      if (changed || statusChanged) {
        existing.updatedAt = Date.now()
        updated += 1
      }
      continue
    }
    const task = {
      id: card.id || `md-${Date.now().toString(36)}-${added}-${Math.random().toString(36).slice(2, 8)}`,
      title: card.title,
      status: STATUSES.includes(card.status) ? card.status : 'todo',
      subject: card.subject,
      note: card.note,
      estimateMin: card.estimateMin,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      doneAt: card.status === 'done' ? (card.doneAt || Date.now()) : null,
      order: state.tasks.length,
      pinned: false,
      tags: card.tags,
      review: card.review,
    }
    state.tasks.push(task)
    added += 1
  }
  for (const [date, text] of Object.entries(parsed.journal || {})) {
    if (String(text || '').trim()) state.journal[date] = String(text).trim()
  }
  return { added, updated }
}
