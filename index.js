/**
 * dsh-study-desk —— 学习工作台（Host 半边）
 *
 * 三块能力，一个插件：
 *   1. 待办墙：Notion 式三列（待办 / 进行中 / 已完成），卡片带科目、标签与投入时长。
 *   2. 学习热力图与周报：按「当天实际复习多少分钟」点亮，不是按 token / 会话数。
 *   3. 番茄钟：状态存在宿主侧，换面板、刷新、关掉再打开都按绝对截止时间恢复。
 *   4. 间隔重复复习队列：卡片带 due / 间隔 / 难度，打分自动推进排期（简化版 SM-2）。
 *   5. 每日复盘：一天一条短记录，会进系统提示摘要，让模型接得上「昨天卡在哪」。
 *   6. Markdown 导出 / 读回：desk.md 落在数据旁边，能软链进 Obsidian vault 手改再读回。
 *
 * 对外两个面：
 *   - HTTP：/api/dsh-study-desk（桌面端 UI 跑在自定义协议上，只有 /api/* 会被转发到宿主，
 *     所以插件 API 必须挂在这个前缀下，否则前端 fetch 不到、面板永远空白）。
 *   - 工具：study_desk（让模型能读写看板、记时长、查统计）。
 *
 * 数据落在 <DSH_HOME>/study-desk/desk.json，路径不写死在 patch 里（写死别人装完起不来）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  GRADE_LABEL,
  GRADES,
  STATUSES,
  addTask,
  allTags,
  dayKey,
  daysUntil,
  deskDir,
  deskFile,
  dueQueue,
  goalInfo,
  gradeTask,
  heatmap,
  journalRecent,
  logSession,
  minutesByTask,
  nextMilestone,
  readDesk,
  removeTask,
  reorderTask,
  reviewStats,
  scheduleTask,
  setJournal,
  streak,
  subjectBreakdown,
  summary,
  todayMinutes,
  unscheduleTask,
  updateSettings,
  updateTask,
  weeklyReport,
  writeDesk,
} from './desk.js'
import { fromMarkdown, mergeMarkdown, toMarkdown } from './markdown.js'
import {
  completeTimer,
  countFocusToday,
  pauseTimer,
  reconcileTimer,
  resetTimer,
  resumeTimer,
  startTimer,
} from './timer.js'

// ---------------------------------------------------------------------------
// defineTool
//
// @deepseek-ai/dsh-tools 是宿主运行时提供的（打包在 app.asar 里），任何 node_modules 里都没有。
// 启动时正常装配的 bundle 能按裸模块名 import 到它；但运行时热挂载进来的 entry 解析基准不同，
// 有可能 import 不到（ERR_MODULE_NOT_FOUND）。所以这里三级兜底：
//   1) 裸模块名（宿主给了自定义解析时就能中）
//   2) 直接从运行时目录里那个打包位置取
//   3) 本地补一份等价实现
//
// 关键在于 defineTool 不是简单透传：它把「友好 schema 描述」编译成 registry-ready 的 JSON Schema
// （parameterSchemaSpecToJsonSchema / valueSchemaSpecToJsonSchema），register 再断言编译结果。
// 少了这层编译，register 会抛
//   JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
// 所以本地兜底必须老老实实做转换。
// ---------------------------------------------------------------------------

function localValueSchema(spec) {
  if (spec === undefined || spec === null) return {}
  if (typeof spec !== 'object') return {}
  const type = String(spec.type || '')
  if (type === 'json' || type === 'any' || type === '') return {}   // 无类型约束 = 注解式 schema，register 接受
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    const out = { type }
    if (Array.isArray(spec.enum) && spec.enum.length) out.enum = spec.enum.slice()
    if (spec.description) out.description = String(spec.description)
    return out
  }
  if (type === 'array') {
    const out = { type: 'array', items: localValueSchema(spec.items) }
    if (spec.description) out.description = String(spec.description)
    return out
  }
  if (type === 'object') {
    const out = { type: 'object', additionalProperties: true }
    if (spec.description) out.description = String(spec.description)
    return out
  }
  return {}
}

function localParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec || {})) {
    properties[key] = localValueSchema(value)
    if (value && value.required === true) required.push(key)
  }
  const out = { type: 'object', properties, additionalProperties: false }
  if (required.length) out.required = required
  return out
}

function localDefineTool(options) {
  const output = options.output || {}
  const tool = {
    name: options.name,
    description: options.description,
    parameters: localParameters(options.parameters),
    output: {
      schema: localValueSchema(output.schema),
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) { return options.execute(args, exec) },
  }
  if (typeof output.presentationMeta === 'function') {
    tool.output.presentationMeta = (args, value) => output.presentationMeta(args, value)
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  return tool
}

async function resolveDefineTool() {
  const candidates = ['@deepseek-ai/dsh-tools']
  try {
    const resources = process.resourcesPath
    if (resources) {
      const base = pathToFileURL(String(resources).replace(/[\\/]+$/, '') + '/').href
      candidates.push(base + 'app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
      candidates.push(base + 'app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    }
  } catch { /* 非 Electron 环境没有 resourcesPath */ }
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (mod && typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, from: spec }
    } catch { /* 试下一个 */ }
  }
  return { defineTool: localDefineTool, from: 'local' }
}

const resolved = await resolveDefineTool()
const defineTool = resolved.defineTool
if (resolved.from === 'local') {
  console.log('[dsh-study-desk] 没取到宿主的 @deepseek-ai/dsh-tools，改用本地等价的 defineTool（schema 转换行为一致）')
}

export const name = 'dsh-study-desk'
export const inject = ['tools', 'webServer']

const API_ROUTE = '/api/dsh-study-desk'

const pluginVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return String(pkg.version || '').trim()
  } catch { return '' }
})()

// ---------------------------------------------------------------------------
// 串行化的状态访问：客户端会 POST，模型会调工具，两边可能同时改同一份 JSON。
// 用一条 promise 链把「读-改-写」串起来，避免后写的把先写的覆盖掉。
// ---------------------------------------------------------------------------

let chain = Promise.resolve()

function serial(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 在串行临界区里读状态 → 顺手结掉走完的计时器 → 跑 mutator → 需要时落盘。
 * mutator 为 null 时是纯读，但计时器结账导致的改动仍会写回。
 */
function withDesk(mutator) {
  return serial(() => {
    const state = readDesk()
    const reconciled = reconcileTimer(state)
    let result
    if (mutator) result = mutator(state)
    if (mutator || reconciled) {
      const saved = writeDesk(state)
      return { state: saved, result }
    }
    return { state, result }
  })
}

function snapshot(state) {
  const byTask = minutesByTask(state)
  const minutes = {}
  for (const [id, m] of byTask) minutes[id] = m
  const now = Date.now()
  return {
    ok: true,
    now,
    state,
    minutes,
    todayMinutes: todayMinutes(state, now),
    streak: streak(state, now),
    focusRoundsToday: countFocusToday(state),
    // 派生数据由 desk.js 单点算好：客户端那份是浏览器里的另一套代码，不该再实现一遍排序与聚合
    review: reviewStats(state, now),
    due: dueQueue(state, now).slice(0, 60),
    tags: allTags(state),
    weekly: weeklyReport(state, 8, now),
    journal: journalRecent(state, now, 14),
    goal: goalInfo(state, now),
    deskFile: deskFile(),
    markdownFile: markdownFile(),
    version: pluginVersion,
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2_000_000) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

/** 导出的 Markdown 落在 desk.json 旁边：软链进 Obsidian vault 就能当笔记用。 */
function markdownFile() {
  return join(deskDir(), 'desk.md')
}

function exportMarkdown(state) {
  const now = Date.now()
  const text = toMarkdown(state, now, {
    minutesByTask: minutesByTask(state),
    reviewStats: reviewStats(state, now),
    weekly: weeklyReport(state, 8, now),
    goal: goalInfo(state, now),
  })
  mkdirSync(deskDir(), { recursive: true })
  writeFileSync(markdownFile(), text)
  return { file: markdownFile(), bytes: Buffer.byteLength(text), markdown: text }
}

const MUTATIONS = {
  'task.add': (state, p) => addTask(state, p),
  'task.update': (state, p) => updateTask(state, p.id || p.title, p.patch || p),
  'task.move': (state, p) => reorderTask(state, p.id || p.title, p.status, p.beforeId),
  'task.delete': (state, p) => removeTask(state, p.id || p.title),
  'session.log': (state, p) => logSession(state, p),
  'settings.update': (state, p) => updateSettings(state, p.patch || p),
  'review.grade': (state, p) => gradeTask(state, p.id || p.title, p.grade),
  'review.schedule': (state, p) => scheduleTask(state, p.id || p.title, p.due),
  'review.unschedule': (state, p) => unscheduleTask(state, p.id || p.title),
  'journal.set': (state, p) => setJournal(state, p.text, p.date),
  'markdown.export': (state) => exportMarkdown(state),
  'markdown.import': (state, p) => mergeMarkdown(state, fromMarkdown(String(p.markdown || p.text || ''))),
  'timer.start': (state, p) => startTimer(state, p),
  'timer.pause': (state) => pauseTimer(state),
  'timer.resume': (state) => resumeTimer(state),
  'timer.reset': (state) => resetTimer(state),
  'timer.complete': (state) => completeTimer(state),
}

// ---------------------------------------------------------------------------
// 客户端诊断回传：浏览器里没有可读的控制台，就把渲染/环境异常写到磁盘上
// 落在 <DSH_HOME>/study-desk/client-diag.json，只保留最近 200 条
// ---------------------------------------------------------------------------

function diagFile() {
  return join(deskDir(), 'client-diag.json')
}

function writeDiag(payload) {
  const file = diagFile()
  let report = { updatedAt: 0, entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && Array.isArray(parsed.entries)) report = parsed
  } catch (error) { /* 文件不存在或坏了就重开一份 */ }
  const { op, ...entry } = payload
  report.entries.push({ ...entry, recordedAt: Date.now() })
  if (report.entries.length > 200) report.entries = report.entries.slice(-200)
  report.updatedAt = Date.now()
  mkdirSync(deskDir(), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2))
  return report
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET') {
      const { state } = await withDesk(null)
      sendJson(res, 200, snapshot(state))
      return
    }
    const raw = await readBody(req)
    let payload = {}
    try { payload = raw ? JSON.parse(raw) : {} } catch { throw new Error('请求体不是合法 JSON') }
    const op = String(payload.op || '')
    if (op === 'state') {
      const { state } = await withDesk(null)
      sendJson(res, 200, snapshot(state))
      return
    }
    if (op === 'diag.report') {
      // 客户端诊断：不碰 desk.json，只追加到 client-diag.json
      const report = writeDiag(payload)
      sendJson(res, 200, { ok: true, at: Date.now(), entries: report.entries.length })
      return
    }
    const mutate = MUTATIONS[op]
    if (!mutate) throw new Error('未知操作：' + op)
    const { state, result } = await withDesk((s) => mutate(s, payload))
    sendJson(res, 200, { ...snapshot(state), result: result ?? null })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
  }
}

// ---------------------------------------------------------------------------
// 给模型看的摘要
// ---------------------------------------------------------------------------

function fmtMinutes(min) {
  const n = Math.max(0, Math.round(Number(min) || 0))
  if (n < 60) return n + ' 分钟'
  const h = Math.floor(n / 60)
  const m = n % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

function boardText(state) {
  const s = summary(state)
  const lines = []
  const goal = s.goal
  lines.push(`学习工作台（study_desk 工具可读写；整页看板在左侧栏「学习工作台」图标）：`)
  if (goal.date && goal.days !== null) {
    const span = goal.end && goal.end !== goal.date ? `（${goal.date}~${goal.end}）` : `（${goal.date}）`
    const wording = goal.days > 0 ? `距 ${goal.label || '目标日期'}${span}还有 ${goal.days} 天`
      : goal.days === 0 ? `${goal.label || '目标'}${span}就是今天` : `${goal.label || '目标'}${span}已过 ${-goal.days} 天`
    lines.push(`- ${wording}${goal.note ? `，${goal.note}` : ''}`)
  }
  const ms = nextMilestone(state)
  if (ms) lines.push(`- 最近节点：${ms.label} ${ms.start}${ms.end !== ms.start ? '~' + ms.end : ''}（${ms.text}${ms.approx ? '，日期按往年惯例估' : ''}）`)
  lines.push(`- 今日专注 ${fmtMinutes(s.today.minutes)} / 目标 ${fmtMinutes(s.today.goal)}，连续打卡 ${s.streak} 天`)
  if (s.doing.length) {
    lines.push('- 进行中 ' + s.counts.doing + '：' + s.doing.map((t) => `${t.title}${t.minutes ? `（已投入 ${fmtMinutes(t.minutes)}）` : ''}`).join(' ｜ '))
  } else {
    lines.push('- 进行中 0：现在没有正在做的卡')
  }
  if (s.todo.length) {
    lines.push('- 待办 ' + s.counts.todo + '：' + s.todo.slice(0, 8).map((t) => t.pinned ? '★' + t.title : t.title).join(' ｜ '))
  } else {
    lines.push('- 待办 0')
  }
  if (s.doneToday.length) lines.push('- 今天已完成：' + s.doneToday.map((t) => t.title).join(' ｜ '))
  if (s.review.due) {
    const due = s.due.map((t) => `${t.title}${t.overdueDays > 0 ? `（逾期 ${t.overdueDays} 天）` : ''}`).join(' ｜ ')
    lines.push(`- 今日待复习 ${s.review.due} 张（其中逾期 ${s.review.overdue}），今天已经复习 ${s.review.doneToday} 次：${due}`)
    lines.push('  复习完用 study_desk 的 action=review、grade=again|good|easy 打分，排期会自动推进')
  }
  if (s.journal.today) lines.push('- 今天的复盘：' + s.journal.today)
  else if (s.journal.yesterday) lines.push('- 昨天的复盘：' + s.journal.yesterday)
  return lines.join('\n')
}

function statsText(state, days = 30) {
  const s = summary(state)
  const hm = heatmap(state, Math.max(1, Math.round(days / 7)), Date.now())
  const brk = subjectBreakdown(state, days)
  const lines = []
  lines.push(`近 ${days} 天：共专注 ${fmtMinutes(hm.total)}，有 ${hm.activeDays} 天学习，当前连续 ${s.streak} 天`)
  if (brk.length) lines.push('按科目：' + brk.map((b) => `${b.label} ${fmtMinutes(b.minutes)}`).join(' ｜ '))
  else lines.push('按科目：还没有记录')
  const recent = state.sessions.filter((x) => x.kind === 'focus').slice(-10).reverse()
  if (recent.length) {
    lines.push('最近的记录：' + recent.map((x) => `${new Date(x.at).toLocaleDateString('zh-CN')} ${x.title || x.subject || '未命名'} ${x.minutes}分钟`).join('；'))
  }
  return lines.join('\n')
}

/** 今日复习队列的播报（模型和用户看的是同一份排期）。 */
function reviewText(state, now = Date.now()) {
  const st = reviewStats(state, now)
  const queue = dueQueue(state, now)
  const today = dayKey(now)
  const lines = []
  lines.push(`复习：排期 ${st.scheduled} 张 · 今天该过 ${st.due} 张（其中逾期 ${st.overdue}）· 今天已经打过分 ${st.doneToday} 次 · 本周共 ${st.weekDone} 次`)
  if (queue.length) {
    lines.push('队列：' + queue.slice(0, 10).map((t) => {
      const r = t.review
      const late = r.due < today ? `逾期 ${-daysUntil(r.due, now)} 天` : '今天到期'
      return `${t.title}［${t.subject || '未归类'}·${late}·第 ${r.reps + 1} 遍］`
    }).join(' ｜ '))
  } else {
    lines.push('队列：今天没有到期的卡。')
  }
  return lines.join('\n')
}

/** 周报文本。 */
function weeklyText(state, weeks = 8, now = Date.now()) {
  const rep = weeklyReport(state, weeks, now)
  const lines = [`最近 ${rep.weeks.length} 周（每周从周一算起）：`]
  for (const w of rep.weeks) {
    const delta = w.deltaPct === null ? '' : `（${w.deltaPct > 0 ? '+' : ''}${w.deltaPct}%）`
    const subj = w.bySubject.slice(0, 3).map((b) => `${b.label} ${fmtMinutes(b.minutes)}`).join('、')
    lines.push(`- ${w.key}${w.current ? '（本周）' : ''}：${fmtMinutes(w.minutes)}${delta} · 学了 ${w.daysActive} 天 · 复习 ${w.reviews} 次${subj ? ` · ${subj}` : ''}`)
  }
  const goal = rep.goalWeekly
  const current = rep.weeks[rep.weeks.length - 1]
  if (current) {
    lines.push(current.minutes >= goal
      ? `本周已达周目标（${fmtMinutes(goal)}）。`
      : `本周还差 ${fmtMinutes(goal - current.minutes)} 到周目标（${fmtMinutes(goal)}）。`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const STUDY_DESK_ACTIONS = ['board', 'add', 'move', 'update', 'remove', 'stats', 'focus', 'review', 'journal', 'report']

function makeTool() {
  return defineTool({
    name: 'study_desk',
    description:
      '学习工作台：读写用户的待办墙（待办/进行中/已完成三列）、记录专注时长、查统计与热力图、起停番茄钟、'
      + '管间隔重复复习队列、写每日复盘、出周报。用户说「今天要做什么」「把 X 加到进行中」「这件做完了」'
      + '"我今天学了多久""开始 25 分钟专注""今天该复习什么""这个我忘了/记住了""帮我记一下今天的复盘""最近几周学得怎么样"'
      + '这类话时用它，而不是自己另开一份待办清单。倒计时的目标与节点由用户在设置页自己填（考试、答辩、投稿都可以）。action 取值：'
      + 'board=看当前看板全貌；add=新建卡；move=卡片换列/排序；update=改卡片字段；remove=删卡；'
      + 'focus=起停番茄钟（给 off=true 或 minutes 控制）；stats=查最近 N 天统计；'
      + 'review=看今日复习队列（带 id/title + grade 时改为打分）；journal=看最近复盘（带 text 时写入）；'
      + 'report=出最近若干周的周报。',
    parameters: {
      action: { type: 'string', enum: STUDY_DESK_ACTIONS, description: '要做的操作' },
      title: { type: 'string', description: '卡片标题（add 必填；move/update/remove/review 可用它代替 id 定位）' },
      id: { type: 'string', description: '卡片 id（比 title 精确）' },
      status: { type: 'string', enum: STATUSES, description: 'move/update 的目标列：todo 待办 / doing 进行中 / done 已完成' },
      subject: { type: 'string', description: '科目，如「631 公共管理」「864」「英语」「政治」' },
      note: { type: 'string', description: '备注' },
      tags: { type: 'string', description: '卡片标签，逗号分隔（如「名词解释, 错题」），add/update 用' },
      estimateMin: { type: 'number', description: '预计要花多少分钟' },
      pinned: { type: 'boolean', description: '是否置顶（add/update）' },
      review: { type: 'boolean', description: 'add 时给 true = 直接把这张卡拉进间隔重复复习循环' },
      beforeId: { type: 'string', description: 'move 时插到这张卡之前；省略则排到该列末尾' },
      minutes: { type: 'number', description: 'focus 的时长（分钟）；stats 时表示看最近多少天（默认 30）' },
      task: { type: 'string', description: 'focus 时把专注挂到哪张卡上（id 或标题）' },
      off: { type: 'boolean', description: 'focus 且 off=true 时停止番茄钟' },
      grade: { type: 'string', enum: GRADES, description: 'review 的打分：again 忘了 / good 记得 / easy 很简单' },
      due: { type: 'string', description: '排期日期 YYYY-MM-DD（review 排期用；省略=今天）' },
      schedule: { type: 'boolean', description: 'review：true 拉进复习循环，false 移出；不传且无 grade 时只是看队列' },
      text: { type: 'string', description: 'journal 的复盘正文；空串表示删掉那天的记录' },
      date: { type: 'string', description: 'journal 的日期 YYYY-MM-DD，省略=今天' },
      weeks: { type: 'number', description: 'report 看最近几周（默认 8）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String((value && value.message) || '') }],
    },
    async execute(args) {
      const action = String(args.action || 'board')
      if (!STUDY_DESK_ACTIONS.includes(action)) return { ok: false, message: '未知 action：' + action }
      try {
        if (action === 'board') {
          const { state } = await withDesk(null)
          return { ok: true, message: boardText(state) }
        }
        if (action === 'stats') {
          const { state } = await withDesk(null)
          return { ok: true, message: statsText(state, Math.max(1, Math.round(Number(args.minutes) || 30))) }
        }
        if (action === 'add') {
          const { state } = await withDesk((s) => addTask(s, {
            title: args.title,
            subject: args.subject,
            note: args.note,
            status: args.status || 'todo',
            estimateMin: args.estimateMin,
            pinned: args.pinned,
            tags: args.tags,
            review: args.review,
          }))
          const s = summary(state)
          return {
            ok: true,
            message: `已加入「${args.status === 'doing' ? '进行中' : args.status === 'done' ? '已完成' : '待办'}」：${String(args.title || '').trim()}。当前 待办 ${s.counts.todo} / 进行中 ${s.counts.doing} / 已完成 ${s.counts.done}。`,
          }
        }
        if (action === 'move') {
          const ref = args.id || args.title
          if (!ref) return { ok: false, message: 'move 需要 id 或 title' }
          const { state, result } = await withDesk((s) => reorderTask(s, (s.tasks.find((t) => t.id === ref || t.title === ref) || {}).id || ref, args.status, args.beforeId))
          const s = summary(state)
          return {
            ok: true,
            message: `「${result.title}」已移到「${result.status === 'doing' ? '进行中' : result.status === 'done' ? '已完成' : '待办'}」。当前 待办 ${s.counts.todo} / 进行中 ${s.counts.doing} / 已完成 ${s.counts.done}。`,
          }
        }
        if (action === 'update') {
          const ref = args.id || args.title
          if (!ref) return { ok: false, message: 'update 需要 id 或 title' }
          const patch = {}
          for (const k of ['title', 'note', 'subject', 'estimateMin', 'pinned', 'status', 'tags']) {
            if (args[k] !== undefined) patch[k] = args[k]
          }
          if (args.review !== undefined) patch.review = !!args.review
          const { result } = await withDesk((s) => updateTask(s, ref, patch))
          return { ok: true, message: `已更新「${result.title}」。` }
        }
        if (action === 'remove') {
          const ref = args.id || args.title
          if (!ref) return { ok: false, message: 'remove 需要 id 或 title' }
          const { result } = await withDesk((s) => removeTask(s, ref))
          return { ok: true, message: `已删除「${result.title}」。` }
        }
        if (action === 'focus') {
          if (args.off) {
            const { state } = await withDesk((s) => resetTimer(s))
            return { ok: true, message: `番茄钟已停。今天已专注 ${fmtMinutes(todayMinutes(state))}。` }
          }
          const { state, result } = await withDesk((s) => startTimer(s, {
            minutes: args.minutes,
            taskId: args.task,
            title: args.task && !s.tasks.some((t) => t.id === args.task) ? undefined : undefined,
          }))
          const s = summary(state)
          return {
            ok: true,
            message: `开始 ${result.minutes} 分钟${result.kind === 'focus' ? '专注' : '休息'}${result.title ? `（${result.title}）` : ''}。今天已专注 ${fmtMinutes(s.today.minutes)} / 目标 ${fmtMinutes(s.today.goal)}。`,
          }
        }
        if (action === 'review') {
          const ref = args.id || args.title
          if (ref && args.grade) {
            if (!GRADES.includes(args.grade)) return { ok: false, message: 'grade 只能是 again / good / easy' }
            const { state, result } = await withDesk((s) => gradeTask(s, ref, args.grade))
            const r = result.task.review
            const st = reviewStats(state)
            return {
              ok: true,
              message: `已给「${result.task.title}」打分（${GRADE_LABEL[args.grade]}）：下次 ${r.due}，间隔 ${r.intervalDays} 天，这是第 ${r.reps + 1} 遍。今天还剩 ${st.due} 张没复习。`,
            }
          }
          if (ref && args.schedule === false) {
            const { result } = await withDesk((s) => unscheduleTask(s, ref))
            return { ok: true, message: `已把「${result.title}」移出复习循环。` }
          }
          if (ref && (args.schedule === true || args.due)) {
            const { result } = await withDesk((s) => scheduleTask(s, ref, args.due))
            return { ok: true, message: `已把「${result.title}」拉进复习循环，下次 ${result.review.due} 到期。` }
          }
          const { state } = await withDesk(null)
          return { ok: true, message: reviewText(state) }
        }
        if (action === 'journal') {
          if (args.text !== undefined) {
            const { result } = await withDesk((s) => setJournal(s, args.text, args.date))
            return { ok: true, message: result.text ? `已记下 ${result.date} 的复盘。` : `已清掉 ${result.date} 的复盘。` }
          }
          const { state } = await withDesk(null)
          const recent = journalRecent(state, Date.now(), 7)
          if (!recent.length) return { ok: true, message: '还没有写过复盘。用 action=journal + text=… 记一条今天卡在哪。' }
          return { ok: true, message: '最近的复盘：\n' + recent.map((x) => `- ${x.date}：${String(x.text).replace(/\n/g, ' ')}`).join('\n') }
        }
        if (action === 'report') {
          const { state } = await withDesk(null)
          return { ok: true, message: weeklyText(state, Math.max(1, Math.min(52, Math.round(Number(args.weeks) || 8)))) }
        }
        return { ok: false, message: '未处理：' + action }
      } catch (error) {
        return { ok: false, message: (error && error.message) ? error.message : String(error) }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  try {
    const seed = readDesk()
    if (!seed.sessions.length && !seed.tasks.length) writeDesk(seed)
  } catch (error) {
    console.error('[dsh-study-desk] 数据文件初始化失败：', error && error.message)
  }

  const webServer = ctx.get('webServer') || ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: API_ROUTE, handler: (req, res) => handleApi(req, res) }),
      'dsh-study-desk: api',
    )
  } else {
    console.error('[dsh-study-desk] 拿不到 webServer，面板将无法读写数据')
  }

  const tools = ctx.get('tools') || ctx.tools
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(makeTool()), 'dsh-study-desk: tool')
  }

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    try {
      const state = readDesk()
      if (state.settings.injectPrompt !== false) {
        assembled.sections.push({ name: 'study-desk:today', text: boardText(state) })
      }
    } catch { /* 注入失败不影响对话 */ }
    return assembled
  })

  const timer = {
    start: (input) => withDesk((s) => startTimer(s, input)),
    pause: () => withDesk((s) => pauseTimer(s)),
    resume: () => withDesk((s) => resumeTimer(s)),
    reset: () => withDesk((s) => resetTimer(s)),
    complete: () => withDesk((s) => completeTimer(s)),
    reconcile: () => withDesk(null),
    state: () => withDesk(null),
  }

  // 给别的插件留一个入口（本插件自己不用，纯便利）：注册服务要用 ctx.provide，
  // ctx.set 只能覆盖已经 provide 过的服务，直接 set 会抛
  //   Error: cannot set property "studyDesk" without provide
  ctx.effect(
    () => ctx.provide('studyDesk', { timer, read: () => readDesk(), file: deskFile() }),
    'dsh-study-desk: service',
  )

  console.log(`[dsh-study-desk] v${pluginVersion} 已加载（数据：${deskFile()}）`)
}

export { boardText, statsText, reviewText, weeklyText, nextMilestone }
