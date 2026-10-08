/**
 * 离线冒烟测试：不启动 DSH，用 stub ctx 直接跑 host / client 两侧的 apply，
 * 把「加载期就炸」的错误在装进 profile 之前抓出来。
 * 用法：node apply-probe.mjs   （cwd = 本目录，含 index.js/desk.js/timer.js/client.js）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 探针绝不能写真实数据：把 DSH_HOME 指到一个临时目录再导入宿主半边。
// desk.js 的 dshHome() 是每次调用才读环境变量的，所以在这里设就够了。
const PROBE_HOME = mkdtempSync(join(tmpdir(), 'desk-probe-'))
process.env.DSH_HOME = PROBE_HOME
const cleanup = () => { try { rmSync(PROBE_HOME, { recursive: true, force: true }) } catch (e) { /* 删不掉就算了 */ } }
process.on('exit', cleanup)

const fails = []
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label) } catch (e) { fails.push(label + ': ' + e.message); console.log('  !!  ' + label + ' -> ' + e.message) }
}

// ---------------------------------------------------------------- host 半边
console.log('[host] index.js')

const registered = { tools: [], routes: [], hooks: [], services: {}, effects: [], logs: [] }

function makeCtx() {
  return {
    tools: {
      register(tool) { registered.tools.push(tool); return () => {} },
    },
    webServer: {
      register(route) { registered.routes.push(route); return () => {} },
    },
    effect(factory, label) {
      const dispose = factory()
      registered.effects.push({ label, dispose })
      return () => {}
    },
    on(event, handler) { registered.hooks.push({ event, handler }); return () => {} },
    set(key, value) { registered.services[key] = value },
    provide(key, value) { registered.services[key] = value; return () => { delete registered.services[key] } },
    get(key) { return registered.services[key] },
    log(...args) { registered.logs.push(args.join(' ')) },
  }
}

const host = await import('./index.js')
check('exports name', () => assert.equal(host.name, 'dsh-study-desk'))
check('exports inject', () => assert.deepEqual(host.inject, ['tools', 'webServer']))
check('exports apply', () => assert.equal(typeof host.apply, 'function'))

const ctx = makeCtx()
check('apply() 不抛', () => host.apply(ctx, {}))

check('注册了 1 个工具', () => assert.equal(registered.tools.length, 1))
const tool = registered.tools[0]
check('工具名 study_desk', () => assert.equal(tool.name, 'study_desk'))
check('工具参数含 7 个 action', () => {
  // defineTool 会把友好描述编译成 JSON Schema（{type:'object',properties:{...}}），
  // 这里两种形态都认，免得又踩一次「编译层被绕过」的坑。
  const props = tool.parameters.properties || tool.parameters
  assert.deepEqual(props.action.enum, ['board', 'add', 'move', 'update', 'remove', 'stats', 'focus'])
})
check('output.schema 是 register 认的 JSON Schema（不能是未编译的 {type:"json"}）', () => {
  const t = tool.output.schema && tool.output.schema.type
  assert.ok(
    t === undefined || ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t),
    `output.schema.type 非法：${JSON.stringify(t)}`,
  )
  assert.equal(typeof tool.output.render, 'function')
})
check('注册了 API 路由', () => {
  const r = registered.routes.find((x) => String(x.path).includes('dsh-study-desk'))
  assert.ok(r, '没有 /api/dsh-study-desk 路由')
  assert.equal(r.path, '/api/dsh-study-desk')
})
check('挂了 system-prompt/assemble', () => {
  assert.ok(registered.hooks.some((h) => h.event === 'system-prompt/assemble'))
})
check('ctx.effect 用了双箭头以外的正确形态（disposer 是函数）', () => {
  for (const e of registered.effects) {
    if (e.dispose !== undefined && e.dispose !== null && typeof e.dispose !== 'function') {
      throw new Error(`effect ${e.label} 工厂返回了非函数：${typeof e.dispose}（会在 apply 时立刻执行清理）`)
    }
  }
})

// ---------------------------------------------------------------- 工具真跑一遍
console.log('[host] study_desk 工具执行')

async function run(action, args = {}) {
  const out = await tool.execute({ action, ...args }, {})
  assert.equal(typeof out, 'object', 'execute 必须返回对象')
  return out
}

const board = await run('board')
check('board 返回 message', () => assert.ok(String(board.message || '').length > 0))
check('board 含「距」与考试日期', () => {
  assert.ok(board.message.includes('2026-12-19'), '缺少考试日期')
  assert.match(board.message, /还有 \d+ 天/)
})

const added = await run('add', { title: '冒烟测试卡片', subject: '864', estimateMin: 45 })
check('add 成功', () => assert.equal(added.ok, true))
const added2 = await run('add', { title: '第二张', subject: '631 公共管理' })
check('add 第二张', () => assert.equal(added2.ok, true))

const moved = await run('move', { title: '冒烟测试卡片', status: 'doing' })
check('move 到进行中', () => assert.equal(moved.ok, true))
const st = await run('board')
check('看板里能看到进行中的卡', () => assert.ok(st.message.includes('冒烟测试卡片')))

const foc = await run('focus', { minutes: 25, task: '冒烟测试卡片' })
check('focus 起了计时器', () => assert.equal(foc.ok, true))
check('focus 回应里报出时长', () => assert.match(foc.message, /25 分钟/))

const stopped = await run('focus', { off: true })
check('focus off 停掉', () => assert.equal(stopped.ok, true))

const stats = await run('stats', { minutes: 7 })
check('stats 返回 message', () => assert.ok(String(stats.message || '').length > 0))

const removed = await run('remove', { title: '第二张' })
check('remove 成功', () => assert.equal(removed.ok, true))
const removed2 = await run('remove', { title: '冒烟测试卡片' })
check('remove 第二张', () => assert.equal(removed2.ok, true))

const unknown = await run('board')
check('清空后看板仍可用', () => assert.ok(String(unknown.message).length > 0))

// ---------------------------------------------------------------- 路由
console.log('[host] /api 路由 GET')

function fakeRes() {
  const res = { code: 0, headers: {}, body: '', chunks: [] }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.writeHead = (code, h) => { res.code = code; Object.assign(res.headers, h || {}) }
  res.write = (s) => { res.chunks.push(s); return true }
  res.end = (s) => { if (s !== undefined) res.chunks.push(s); res.body = res.chunks.join(''); res.done = true; if (!res.code) res.code = 200 }
  return res
}

const route = registered.routes.find((x) => x.path === '/api/dsh-study-desk')
const res = fakeRes()
await route.handler({ method: 'GET', url: '/api/dsh-study-desk?op=state', headers: {}, on() {} }, res)
check('GET 返回 200', () => assert.equal(res.code, 200))
check('GET 返回合法 JSON', () => { JSON.parse(res.body) })
const payload = JSON.parse(res.body)
check('GET 带 state.settings', () => assert.equal(typeof payload.state.settings.focusMin, 'number'))
check('GET 带 exam 与 deskFile', () => {
  assert.equal(payload.exam.start, '2026-12-19')
  assert.ok(String(payload.deskFile).includes('desk.json'))
})
check('GET 带 daysToExam（数字，不是 undefined）', () => {
  assert.equal(typeof payload.daysToExam, 'number')
  assert.ok(Number.isFinite(payload.daysToExam))
})

console.log('[host] /api 路由 POST')

async function post(payloadObj) {
  const r = fakeRes()
  const raw = JSON.stringify(payloadObj)
  const req = {
    method: 'POST',
    url: '/api/dsh-study-desk',
    headers: { 'content-type': 'application/json' },
    on(evt, cb) { if (evt === 'data') cb(Buffer.from(raw)); if (evt === 'end') cb() },
  }
  await route.handler(req, r)
  return r
}

const p1 = await post({ op: 'task.add', title: 'POST 加的卡', subject: '政治' })
check('POST task.add 200', () => assert.equal(p1.code, 200))
const p1j = JSON.parse(p1.body)
check('POST task.add ok', () => assert.equal(p1j.ok, true))
check('POST 回执里能看到新卡', () => assert.ok(p1j.state.tasks.some((t) => t.title === 'POST 加的卡')))

const p2 = await post({ op: 'task.move', title: 'POST 加的卡', status: 'done' })
check('POST task.move 200', () => assert.equal(p2.code, 200))
check('POST task.move 落到 done', () => {
  const t = JSON.parse(p2.body).state.tasks.find((x) => x.title === 'POST 加的卡')
  assert.equal(t.status, 'done')
})

const p3 = await post({ op: 'timer.start', minutes: 25, task: 'POST 加的卡' })
check('POST timer.start 200', () => assert.equal(p3.code, 200))
check('POST timer.start 有 endsAt', () => assert.ok(JSON.parse(p3.body).state.timer.endsAt > 0))

const p4 = await post({ op: 'timer.reset' })
check('POST timer.reset 200', () => assert.equal(p4.code, 200))

const p5 = await post({ op: 'nonsense.op' })
check('未知 op 返回 400', () => assert.equal(p5.code, 400))
check('未知 op 带 error 文案', () => assert.ok(String(JSON.parse(p5.body).error || '').length > 0))

const p6 = await post({ op: 'task.add' })
check('缺 title 返回 400', () => assert.equal(p6.code, 400))

// 客户端诊断通道：不碰 desk.json，只追加 diag 文件
const d1 = await post({ op: 'diag.report', kind: 'boot', where: 'probe', message: '来自探针' })
check('POST diag.report 200', () => assert.equal(d1.code, 200))
check('diag.report 不回 desk 快照', () => assert.equal(JSON.parse(d1.body).ok, true))
check('diag.report 落了盘', () => {
  const file = join(PROBE_HOME, 'study-desk', 'client-diag.json')
  const report = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(report.entries.some((e) => e.message === '来自探针'))
})

// ---------------------------------------------------------------- client 半边
console.log('[client] client.js')

const clientRegistered = { slots: [], injects: [], styles: 0, effects: [] }
let modDef = null
const React = {
  createElement: (...args) => ({ __el: args[0], props: args[1] || {}, children: args.slice(2) }),
  Fragment: 'fragment',
  // client.js 里有个 class Boundary extends React.Component，桩里必须有这个基类，
  // 否则 factory 一执行就在 class 定义处抛「Class extends value undefined」。
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState() {}
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

globalThis.window = {
  __ModuleLoader__: { load: (def) => { modDef = def } },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
}
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ style: {}, set textContent(v) { this._t = v }, get textContent() { return this._t }, remove() {} }),
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
}
try { globalThis.navigator = { language: 'zh-CN' } } catch { Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true }) }
// client apply() 会立刻 refresh 一次；这里给一个假的宿主回执，把 absorb() 也跑一遍
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    now: Date.now(),
    state: {
      version: 1,
      tasks: [],
      sessions: [],
      timer: null,
      settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsBeforeLong: 4, dailyGoalMin: 180, streakMin: 10, injectPrompt: true, subjects: [], heatmapWeeks: 26 },
      createdAt: 0,
      updatedAt: 0,
    },
    minutes: {},
    todayMinutes: 0,
    streak: 0,
    focusRoundsToday: 0,
    exam: { name: 'x', start: '2026-12-19', end: '2026-12-20', note: '' },
    milestones: [],
    deskFile: 'x',
    version: '0.1.0',
  }),
})
globalThis.self = globalThis.window

await import('./client.js')
check('client.js 调用了 __ModuleLoader__.load', () => assert.ok(modDef, '没有注册模块'))
check('loader id 与 entry 名一致', () => assert.equal(modDef.id, 'dsh-study-desk'))

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}
let clientMod = null
check('factory 能执行完', () => { clientMod = modDef.factory(requireStub) })
check('client 有 apply', () => { assert.equal(typeof clientMod.apply, 'function') })
check('client inject = [slots]', () => { assert.deepEqual(clientMod.inject, ['slots']) })

const clientCtx = {
  get(key) {
    if (key === 'slots') {
      return {
        inject(slotName, cb) { clientRegistered.injects.push(slotName); return cb() },
        register(meta, factory) {
          clientRegistered.slots.push({ slotName: meta.name, id: meta.id, key: meta.key, order: meta.order, factory })
          return () => {}
        },
      }
    }
    if (key === 'layout') return { selectPanel() {}, openRightbar() {}, closeRightbar() {} }
    return undefined
  },
  effect(factory, label) { const d = factory(); clientRegistered.effects.push({ label, d }); return () => {} },
  on() { return () => {} },
  set() {}, log() {}, warn() {}, error() {},
}

check('client apply() 不抛', () => clientMod.apply(clientCtx))
check('注册了 4 个槽位', () => {
  const names = clientRegistered.slots.map((s) => s.slotName).sort()
  assert.deepEqual(names, ['main', 'settings.section', 'shell.overlay', 'sidebar.panellist'])
})
check('inject 的槽位名与注册的一致', () => {
  assert.deepEqual(clientRegistered.injects.slice().sort(), ['main', 'settings.section', 'shell.overlay', 'sidebar.panellist'])
})
check('sidebar.panellist 用了 id=study-desk', () => {
  const s = clientRegistered.slots.find((x) => x.slotName === 'sidebar.panellist')
  assert.equal(s.id, 'study-desk')
})
check('main 用了 key=study-desk（与侧栏面板 id 对齐）', () => {
  const s = clientRegistered.slots.find((x) => x.slotName === 'main')
  assert.equal(s.key, 'study-desk')
})
check('shell.overlay 有 id', () => {
  const s = clientRegistered.slots.find((x) => x.slotName === 'shell.overlay')
  assert.equal(s.id, 'study-desk-mini')
})
check('每个槽位的 factory 都是函数', () => {
  for (const s of clientRegistered.slots) {
    if (s.slotName !== 'inject') assert.equal(typeof s.factory, 'function', `${s.slotName}.factory`)
  }
})
// 每个槽位的渲染都要被 error boundary 包住，否则一处炸了就是白屏
check('每个槽位的 factory 都用 Boundary 包了一层', () => {
  for (const s of clientRegistered.slots) {
    const node = s.factory({ size: 18 })
    assert.ok(node && node.__el, `${s.slotName} 没返回元素`)
    assert.equal(node.__el.name, 'Boundary', `${s.slotName} 没被 Boundary 包住，实际是 ${node.__el && node.__el.name}`)
  }
})
check('Boundary 的 where 标签与槽位对得上', () => {
  const expects = {
    'sidebar.panellist': 'sidebar.panellist',
    main: 'main',
    'shell.overlay': 'shell.overlay',
    'settings.section': 'settings.section',
  }
  for (const s of clientRegistered.slots) {
    const node = s.factory({ size: 18 })
    assert.equal(node.props.where, expects[s.slotName])
  }
})
check('注入了一份 style', () => assert.ok(clientRegistered.effects.length > 0))

// ---------------------------------------------------------------- 结果
console.log('')
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败：`)
  for (const f of fails) console.log('   - ' + f)
  process.exit(1)
}
console.log('✓ 全部通过')
// client 的 apply() 起了 setInterval 盯倒计时，显式退出而不是等它
process.exit(0)
