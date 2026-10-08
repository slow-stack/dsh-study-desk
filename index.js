/**
 * dsh-study-desk —— 考研工作台（Host 半边）
 *
 * 三块能力，一个插件：
 *   1. 待办墙：Notion 式三列（待办 / 进行中 / 已完成），卡片带科目与投入时长。
 *   2. 学习热力图：按「当天实际复习多少分钟」点亮，不是按 token / 会话数。
 *   3. 番茄钟：状态存在宿主侧，换面板、刷新、关掉再打开都按绝对截止时间恢复。
 *
 * 对外两个面：
 *   - HTTP：/api/dsh-study-desk（桌面端 UI 跑在自定义协议上，只有 /api/* 会被转发到宿主，
 *     所以插件 API 必须挂在这个前缀下，否则前端 fetch 不到、面板永远空白）。
 *   - 工具：study_desk（让模型能读写看板、记时长、查统计）。
 *
 * 数据落在 <DSH_HOME>/study-desk/desk.json，路径不写死在 patch 里（写死别人装完起不来）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  EXAM,
  MILESTONES,
  STATUSES,
  addTask,
  daysUntil,
  deskFile,
  heatmap,
  logSession,
  minutesByTask,
  readDesk,
  removeTask,
  reorderTask,
  streak,
  subjectBreakdown,
  summary,
  todayMinutes,
  updateSettings,
  updateTask,
  writeDesk,
} from './desk.js'
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
  return {
    ok: true,
    now: Date.now(),
    state,
    minutes,
    todayMinutes: todayMinutes(state),
    streak: streak(state),
    focusRoundsToday: countFocusToday(state),
    exam: EXAM,
    milestones: MILESTONES,
    deskFile: deskFile(),
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

const MUTATIONS = {
  'task.add': (state, p) => addTask(state, p),
  'task.update': (state, p) => updateTask(state, p.id || p.title, p.patch || p),
  'task.move': (state, p) => reorderTask(state, p.id || p.title, p.status, p.beforeId),
  'task.delete': (state, p) => removeTask(state, p.id || p.title),
  'session.log': (state, p) => logSession(state, p),
  'settings.update': (state, p) => updateSettings(state, p.patch || p),
  'timer.start': (state, p) => startTimer(state, p),
  'timer.pause': (state) => pauseTimer(state),
  'timer.resume': (state) => resumeTimer(state),
  'timer.reset': (state) => resetTimer(state),
  'timer.complete': (state) => completeTimer(state),
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

function nextMilestone(now) {
  for (const m of MILESTONES) {
    const d = daysUntil(m.start, now)
    if (d !== null && d >= 0) return { ...m, days: d }
  }
  return null
}

function boardText(state) {
  const s = summary(state)
  const lines = []
  const days = s.daysToExam
  lines.push(`考研工作台（study_desk 工具可读写；整页看板在左侧栏「工作台」图标）：`)
  lines.push(`- 距 ${EXAM.name}（${EXAM.start}）还有 ${days} 天${EXAM.note ? `，考 ${EXAM.note}` : ''}`)
  const ms = nextMilestone(s.today ? Date.now() : Date.now())
  if (ms) lines.push(`- 最近节点：${ms.label} ${ms.start}${ms.end && ms.end !== ms.start ? '~' + ms.end : ''}（${ms.days === 0 ? '就是今天' : '还有 ' + ms.days + ' 天'}）`)
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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const STUDY_DESK_ACTIONS = ['board', 'add', 'move', 'update', 'remove', 'stats', 'focus']

function makeTool() {
  return defineTool({
    name: 'study_desk',
    description:
      '考研工作台：读写用户的待办墙（待办/进行中/已完成三列）、记录专注时长、查学习统计与热力图、起停番茄钟。'
      + '用户说「今天要做什么」「把 X 加到进行中」「这件做完了」「我今天学了多久」「开始 25 分钟专注」这类话时用它，'
      + '而不是自己另开一份待办清单。action 取值：'
      + 'board=看当前看板全貌；add=新建卡；move=卡片换列/排序；update=改卡片字段；remove=删卡；'
      + 'focus=起停番茄钟（给 off=true 或 minutes 控制）；stats=查最近 N 天统计。',
    parameters: {
      action: { type: 'string', enum: STUDY_DESK_ACTIONS, description: '要做的操作' },
      title: { type: 'string', description: '卡片标题（add 必填；move/update/remove 可用它代替 id 定位）' },
      id: { type: 'string', description: '卡片 id（比 title 精确）' },
      status: { type: 'string', enum: STATUSES, description: 'move/update 的目标列：todo 待办 / doing 进行中 / done 已完成' },
      subject: { type: 'string', description: '科目，如「631 公共管理」「864」「英语」「政治」' },
      note: { type: 'string', description: '备注' },
      estimateMin: { type: 'number', description: '预计要花多少分钟' },
      pinned: { type: 'boolean', description: '是否置顶（add/update）' },
      beforeId: { type: 'string', description: 'move 时插到这张卡之前；省略则排到该列末尾' },
      minutes: { type: 'number', description: 'focus 的时长（分钟）；stats 时表示看最近多少天（默认 30）' },
      task: { type: 'string', description: 'focus 时把专注挂到哪张卡上（id 或标题）' },
      off: { type: 'boolean', description: 'focus 且 off=true 时停止番茄钟' },
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
          for (const k of ['title', 'note', 'subject', 'estimateMin', 'pinned', 'status']) {
            if (args[k] !== undefined) patch[k] = args[k]
          }
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

export { boardText, statsText, nextMilestone }
