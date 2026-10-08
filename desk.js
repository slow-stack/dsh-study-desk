/**
 * dsh-study-desk —— 考研工作台 · 数据层
 *
 * 纯 Node 半边，不依赖任何 dsh 内部包，可独立单测（test/desk.test.js）。
 * 数据是一个人类可读的 JSON 文件，放在 dsh home 下：
 *   <DSH_HOME>/study-desk/desk.json
 *
 * 为什么用 JSON 而不是 SQLite：这个库的全部内容是「一个人的复习计划和打卡记录」，
 * 量级是几千条，用不着数据库；JSON 的好处是用户能直接打开看、能手工改、能丢进
 * Obsidian 仓库或 git 里做版本。写入走「临时文件 + rename」原子替换，避免断电半截文件。
 *
 * 三个核心概念：
 *   tasks     卡片。三列看板 = status: todo / doing / done。
 *   sessions  一次专注记录（番茄或手动记的一段时间）。热力图和统计的唯一数据源。
 *   settings  番茄时长、每日目标等。
 *
 * 热力图语义（这是本插件与市面插件的关键区别）：点亮条件是「当天实际复习了多少分钟」，
 * 而不是「当天有没有消耗 token / 有没有开过会话」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** dsh 的 home 目录。宿主进程会带 DSH_HOME；没有时回落到 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return String(env).trim()
  return join(homedir(), '.dsh')
}

export function deskDir() {
  return join(dshHome(), 'study-desk')
}

export function deskFile() {
  return join(deskDir(), 'desk.json')
}

// ---------------------------------------------------------------------------
// 考试日程（2027 届，已核实：初试 2026-12-19~20）
// ---------------------------------------------------------------------------

export const EXAM = {
  name: '2027 届考研初试',
  start: '2026-12-19',
  end: '2026-12-20',
  note: '631 公共管理 + 864',
}

/** 关键节点。kind: 'window' 有起止，'day' 单日。 */
export const MILESTONES = [
  { id: 'pre-reg', label: '预报名', kind: 'window', start: '2026-10-09', end: '2026-10-12' },
  { id: 'reg', label: '正式报名', kind: 'window', start: '2026-10-15', end: '2026-10-24' },
  { id: 'confirm', label: '网上确认', kind: 'window', start: '2026-11-01', end: '2026-11-05', approx: true },
  { id: 'ticket', label: '打印准考证', kind: 'window', start: '2026-12-10', end: '2026-12-19', approx: true },
  { id: 'exam', label: '初试', kind: 'window', start: '2026-12-19', end: '2026-12-20' },
]

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export const STATUSES = ['todo', 'doing', 'done']

export const DEFAULT_SETTINGS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLong: 4,
  dailyGoalMin: 180,
  /** 一个专注日至少要有多少分钟才计入连续天数。 */
  streakMin: 10,
  /** 是否往系统提示里注入工作台摘要。 */
  injectPrompt: true,
  subjects: [
    { id: 's631', label: '631 公共管理' },
    { id: 's864', label: '864' },
    { id: 'en', label: '英语' },
    { id: 'zz', label: '政治' },
  ],
  /** 热力图默认跨度（周）。 */
  heatmapWeeks: 26,
}

const MAX_SESSIONS = 20000

function freshState() {
  return {
    version: 1,
    tasks: [],
    sessions: [],
    timer: null,
    settings: { ...DEFAULT_SETTINGS, subjects: DEFAULT_SETTINGS.subjects.map((s) => ({ ...s })) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// 时间工具（全部按本机本地时区，用户在国内就是 Asia/Shanghai）
// ---------------------------------------------------------------------------

export function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function addDays(ts, n) {
  const d = new Date(ts)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** 本地日期键 YYYY-MM-DD。 */
export function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 'YYYY-MM-DD' → 当天 00:00 的时间戳（本地）。 */
export function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').trim())
  if (!m) return NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
}

/** 距某个 'YYYY-MM-DD' 还有几天（今天=0，已过为负）。 */
export function daysUntil(dayKeyStr, now = Date.now()) {
  const target = parseDayKey(dayKeyStr)
  if (!Number.isFinite(target)) return null
  return Math.round((target - startOfDay(now)) / 86400000)
}

// ---------------------------------------------------------------------------
// 读 / 写
// ---------------------------------------------------------------------------

export function normalize(raw) {
  const base = freshState()
  if (!raw || typeof raw !== 'object') return base
  const state = {
    ...base,
    ...raw,
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    settings: { ...base.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
  }
  if (!Array.isArray(state.settings.subjects) || state.settings.subjects.length === 0) {
    state.settings.subjects = base.settings.subjects.map((s) => ({ ...s }))
  }
  state.tasks = state.tasks
    .filter((t) => t && typeof t === 'object' && String(t.title || '').trim())
    .map((t, i) => ({
      id: String(t.id || randomUUID()),
      title: String(t.title).trim(),
      status: STATUSES.includes(t.status) ? t.status : 'todo',
      subject: String(t.subject || ''),
      note: String(t.note || ''),
      estimateMin: Math.max(0, Math.floor(Number(t.estimateMin) || 0)),
      createdAt: Number(t.createdAt) || Date.now(),
      updatedAt: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
      doneAt: Number(t.doneAt) || null,
      order: Number.isFinite(Number(t.order)) ? Number(t.order) : i,
      pinned: !!t.pinned,
    }))
  state.sessions = state.sessions
    .filter((s) => s && typeof s === 'object' && Number(s.minutes) > 0)
    .map((s) => ({
      id: String(s.id || randomUUID()),
      taskId: s.taskId ? String(s.taskId) : null,
      title: String(s.title || ''),
      subject: String(s.subject || ''),
      kind: s.kind === 'break' ? 'break' : 'focus',
      minutes: Math.max(1, Math.round(Number(s.minutes))),
      at: Number(s.at) || Date.now(),
    }))
    .slice(-MAX_SESSIONS)
  state.timer = state.timer && typeof state.timer === 'object' ? state.timer : null
  return state
}

export function readDesk(file = deskFile()) {
  try {
    if (!existsSync(file)) return freshState()
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // 文件坏了不要清空用户数据：改名留档，重开一份新的。
    try { renameSync(file, file + '.broken-' + Date.now()) } catch { /* 挪不动就算了 */ }
    return freshState()
  }
}

export function writeDesk(state, file = deskFile()) {
  const dir = join(file, '..')
  mkdirSync(dir, { recursive: true })
  const next = { ...state, version: 1, updatedAt: Date.now() }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, file)
  return next
}

// ---------------------------------------------------------------------------
// 变更操作（全部是「读进来 → 改 → 返回新对象」，由调用方决定何时落盘）
// ---------------------------------------------------------------------------

function nextOrder(tasks, status) {
  const inCol = tasks.filter((t) => t.status === status)
  return inCol.length ? Math.max(...inCol.map((t) => t.order)) + 1 : 0
}

function findTask(state, ref) {
  const key = String(ref || '').trim()
  if (!key) return null
  const exact = state.tasks.find((t) => t.id === key)
  if (exact) return exact
  const lower = key.toLowerCase()
  const hits = state.tasks.filter((t) => t.title.toLowerCase() === lower)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    // 同名的优先取还没做完的那张
    return hits.find((t) => t.status !== 'done') || hits[0]
  }
  const partial = state.tasks.filter((t) => t.title.toLowerCase().includes(lower))
  return partial.length === 1 ? partial[0] : null
}

export function addTask(state, input) {
  const title = String((input && input.title) || '').trim()
  if (!title) throw new Error('标题不能为空')
  const now = Date.now()
  const status = STATUSES.includes(input && input.status) ? input.status : 'todo'
  const task = {
    id: randomUUID(),
    title,
    status,
    subject: String((input && input.subject) || ''),
    note: String((input && input.note) || ''),
    estimateMin: Math.max(0, Math.floor(Number(input && input.estimateMin) || 0)),
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : null,
    order: nextOrder(state.tasks, status),
    pinned: !!(input && input.pinned),
  }
  state.tasks.push(task)
  return task
}

export function updateTask(state, ref, patch) {
  const task = findTask(state, ref)
  if (!task) throw new Error('找不到这张卡：' + ref)
  const p = patch || {}
  if (typeof p.title === 'string' && p.title.trim()) task.title = p.title.trim()
  if (typeof p.note === 'string') task.note = p.note
  if (typeof p.subject === 'string') task.subject = p.subject
  if (p.estimateMin !== undefined) task.estimateMin = Math.max(0, Math.floor(Number(p.estimateMin) || 0))
  if (p.pinned !== undefined) task.pinned = !!p.pinned
  if (typeof p.status === 'string' && STATUSES.includes(p.status)) {
    task.status = p.status
    task.doneAt = p.status === 'done' ? (task.doneAt || Date.now()) : null
  }
  task.updatedAt = Date.now()
  return task
}

export function removeTask(state, ref) {
  const task = findTask(state, ref)
  if (!task) throw new Error('找不到这张卡：' + ref)
  state.tasks = state.tasks.filter((t) => t.id !== task.id)
  return task
}

/** 同列内重排：把 id 放到 beforeId 之前（beforeId 为空 = 挪到列尾）。 */
export function reorderTask(state, ref, status, beforeId) {
  const task = findTask(state, ref)
  if (!task) throw new Error('找不到这张卡：' + ref)
  task.status = STATUSES.includes(status) ? status : task.status
  task.doneAt = task.status === 'done' ? (task.doneAt || Date.now()) : null
  const col = state.tasks
    .filter((t) => t.status === task.status && t.id !== task.id)
    .sort((a, b) => a.order - b.order)
  const target = beforeId ? col.findIndex((t) => t.id === String(beforeId)) : -1
  if (target < 0) col.push(task)
  else col.splice(target, 0, task)
  col.forEach((t, i) => { t.order = i })
  task.updatedAt = Date.now()
  return task
}

export function logSession(state, input) {
  const minutes = Math.max(1, Math.round(Number((input && input.minutes) || 0)))
  if (!Number.isFinite(minutes)) throw new Error('时长不合法')
  let title = String((input && input.title) || '')
  let subject = String((input && input.subject) || '')
  let taskId = (input && input.taskId) ? String(input.taskId) : null
  if (taskId) {
    const task = findTask(state, taskId)
    if (task) {
      taskId = task.id
      if (!title) title = task.title
      if (!subject) subject = task.subject
    } else {
      taskId = null
    }
  }
  const session = {
    id: randomUUID(),
    taskId,
    title,
    subject,
    kind: (input && input.kind) === 'break' ? 'break' : 'focus',
    minutes,
    at: Number((input && input.at) || Date.now()),
  }
  state.sessions.push(session)
  if (state.sessions.length > MAX_SESSIONS) state.sessions = state.sessions.slice(-MAX_SESSIONS)
  return session
}

export function updateSettings(state, patch) {
  const p = patch || {}
  const next = { ...state.settings }
  for (const k of ['focusMin', 'shortBreakMin', 'longBreakMin', 'roundsBeforeLong', 'dailyGoalMin', 'streakMin', 'heatmapWeeks']) {
    if (p[k] !== undefined) {
      const n = Math.floor(Number(p[k]))
      if (Number.isFinite(n) && n > 0) next[k] = n
    }
  }
  if (p.injectPrompt !== undefined) next.injectPrompt = !!p.injectPrompt
  if (Array.isArray(p.subjects)) {
    const list = p.subjects
      .map((s) => (typeof s === 'string' ? { id: s, label: s } : s))
      .filter((s) => s && String(s.label || '').trim())
      .map((s) => ({ id: String(s.id || s.label), label: String(s.label).trim() }))
    if (list.length) next.subjects = list
  }
  state.settings = next
  return next
}

// ---------------------------------------------------------------------------
// 统计 / 热力图
// ---------------------------------------------------------------------------

/** 每个任务累计专注分钟（只看 focus）。 */
export function minutesByTask(state) {
  const map = new Map()
  for (const s of state.sessions) {
    if (s.kind !== 'focus' || !s.taskId) continue
    map.set(s.taskId, (map.get(s.taskId) || 0) + s.minutes)
  }
  return map
}

/** 每个本地日期的专注分钟（只看 focus）。 */
export function minutesByDay(state) {
  const map = new Map()
  for (const s of state.sessions) {
    if (s.kind !== 'focus') continue
    const k = dayKey(s.at)
    map.set(k, (map.get(k) || 0) + s.minutes)
  }
  return map
}

export function todayMinutes(state, now = Date.now()) {
  return minutesByDay(state).get(dayKey(now)) || 0
}

/** 连续打卡天数：从今天（或昨天，今天还没学不算断）往前数。 */
export function streak(state, now = Date.now()) {
  const byDay = minutesByDay(state)
  const need = Number(state.settings.streakMin) || 1
  const hit = (ts) => (byDay.get(dayKey(ts)) || 0) >= need
  let cursor = startOfDay(now)
  if (!hit(cursor)) {
    cursor = addDays(cursor, -1)
    if (!hit(cursor)) return 0
  }
  let n = 0
  while (hit(cursor)) {
    n += 1
    cursor = addDays(cursor, -1)
  }
  return n
}

/**
 * 热力图网格：每列一周（周一起），最后一周含今天。
 * 返回 { weeks: [{ start, days: [ {key, ts, minutes, count, level} | null x7 ] }], monthLabels }
 */
export function heatmap(state, weeks = 26, now = Date.now()) {
  const byDay = minutesByDay(state)
  const countByDay = new Map()
  for (const s of state.sessions) {
    if (s.kind !== 'focus') continue
    const k = dayKey(s.at)
    countByDay.set(k, (countByDay.get(k) || 0) + 1)
  }
  const goal = Number(state.settings.dailyGoalMin) || 180
  const levelFor = (min) => {
    if (!min || min <= 0) return 0
    if (min < goal * 0.25) return 1
    if (min < goal * 0.5) return 2
    if (min < goal) return 3
    return 4
  }
  const today = startOfDay(now)
  const weekday = (new Date(today).getDay() + 6) % 7 // 0 = 周一
  const lastMonday = addDays(today, -weekday)
  const span = Math.max(1, Math.min(105, Math.floor(Number(weeks) || 26)))
  const out = []
  for (let w = span - 1; w >= 0; w -= 1) {
    const monday = addDays(lastMonday, -7 * w)
    const days = []
    for (let d = 0; d < 7; d += 1) {
      const ts = addDays(monday, d)
      if (ts > today) { days.push(null); continue }
      const key = dayKey(ts)
      const minutes = byDay.get(key) || 0
      days.push({ key, ts, minutes, count: countByDay.get(key) || 0, level: levelFor(minutes) })
    }
    out.push({ start: monday, days })
  }
  // 月份标签：某列里出现「1 号」时给那一列打上月名（同月只打一次）
  const monthLabels = []
  let lastMonth = -1
  out.forEach((week, i) => {
    const firstOfMonth = week.days.find((d) => d && new Date(d.ts).getDate() === 1)
    if (firstOfMonth) {
      const m = new Date(firstOfMonth.ts).getMonth()
      if (m !== lastMonth) {
        lastMonth = m
        monthLabels.push({ weekIndex: i, label: `${m + 1}月` })
      }
    }
  })
  let total = 0
  let activeDays = 0
  for (const week of out) {
    for (const d of week.days) {
      if (!d) continue
      total += d.minutes
      if (d.minutes > 0) activeDays += 1
    }
  }
  return { weeks: out, monthLabels, total, activeDays, goal }
}

/** 按科目汇总最近 N 天。 */
export function subjectBreakdown(state, days = 30, now = Date.now()) {
  const from = addDays(startOfDay(now), -(days - 1))
  const map = new Map()
  for (const s of state.sessions) {
    if (s.kind !== 'focus' || s.at < from) continue
    const label = s.subject || (s.taskId ? '' : '未归类')
    const key = label || '未归类'
    map.set(key, (map.get(key) || 0) + s.minutes)
  }
  return [...map.entries()]
    .map(([label, minutes]) => ({ label, minutes }))
    .sort((a, b) => b.minutes - a.minutes)
}

/** 给模型 / 面板用的一屏摘要。 */
export function summary(state, now = Date.now()) {
  const byTask = minutesByTask(state)
  const cols = {}
  for (const st of STATUSES) cols[st] = state.tasks.filter((t) => t.status === st)
  const doneToday = state.tasks.filter((t) => t.status === 'done' && t.doneAt && startOfDay(t.doneAt) === startOfDay(now))
  return {
    exam: EXAM,
    daysToExam: daysUntil(EXAM.start, now),
    today: { date: dayKey(now), minutes: todayMinutes(state, now), goal: state.settings.dailyGoalMin },
    streak: streak(state, now),
    counts: { todo: cols.todo.length, doing: cols.doing.length, done: cols.done.length },
    doing: cols.doing.map((t) => ({ id: t.id, title: t.title, subject: t.subject, minutes: byTask.get(t.id) || 0 })),
    todo: cols.todo
      .slice()
      .sort((a, b) => (b.pinned - a.pinned) || (a.order - b.order))
      .slice(0, 12)
      .map((t) => ({ id: t.id, title: t.title, subject: t.subject, pinned: t.pinned, estimateMin: t.estimateMin })),
    doneToday: doneToday.map((t) => ({ id: t.id, title: t.title })).slice(0, 12),
    week: heatmap(state, 1, now).weeks[0].days.filter(Boolean).map((d) => ({ date: d.key, minutes: d.minutes })),
  }
}

/** 只保留最必要的小数位，给任务卡显示用。 */
export function taskWithMinutes(state, task, byTask) {
  return { ...task, spentMin: byTask ? (byTask.get(task.id) || 0) : 0 }
}

export { MAX_SESSIONS }
