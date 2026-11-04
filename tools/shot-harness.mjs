/**
 * 视觉验证用的「真挂载」外壳生成器。
 *
 * 为什么要它：apply-probe 只跑到「factory 返回了 Boundary」，看不到布局；而界面改动的坑
 * （中心列 overflow:hidden、层叠上下文、字号阶梯没挂到根上）只有真渲染才暴露得出来。
 * 这里按 AGENTS.md 记载的做法：真 React 18 UMD + 复刻宿主外壳 + 宿主自己的 --dsw-* token，
 * 然后把 client.js 当真插件加载进来、把槽位挂出来。
 *
 * 数据用她本机真实的 desk.json（拷到临时 DSH_HOME，绝不写回原文件），截图才是她会看到的那一屏。
 *
 * 用法：node tools/shot-harness.mjs   → 产物在 .shots/（已 gitignore）
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASAR = 'D:/Program Files/DeepSeek Harness/resources/app.asar'
const REACT_DIR = 'D:/chatbox/node_modules'
const REAL_HOME = 'D:/DSH/.dsh'
const OUT = join(ROOT, '.shots')

mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- 1. 真快照
// 宿主半边的 snapshot() 没导出，所以照 apply-probe 的办法起个 stub ctx，走真路由取快照。
// DSH_HOME 先指到临时目录并拷进她的 desk.json —— 读真实数据，但不碰真实文件。
const HOME = mkdtempSync(join(tmpdir(), 'desk-shot-'))
mkdirSync(join(HOME, 'study-desk'), { recursive: true })
for (const f of ['desk.json', 'bbdc.json']) {
  try { cpSync(join(REAL_HOME, 'study-desk', f), join(HOME, 'study-desk', f)) } catch { /* 没有就算了 */ }
}
process.env.DSH_HOME = HOME

const routes = []
const ctx = {
  tools: { register: () => () => {} },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (f) => { f(); return () => {} },
  on: () => () => {},
  set: (k, v) => { services[k] = v },
  provide: (k, v) => { services[k] = v; return () => {} },
  get: (k) => services[k],
  log: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  dirs: { home: HOME },
}
const services = {}
const host = await import('../index.js')
host.apply(ctx, {})

function fakeRes() {
  const res = { code: 0, chunks: [] }
  res.setHeader = () => {}
  res.writeHead = (code) => { res.code = code }
  res.write = (s) => { res.chunks.push(s); return true }
  res.end = (s) => { if (s !== undefined) res.chunks.push(s); res.body = res.chunks.join('') }
  return res
}
const route = routes.find((x) => x.path === '/api/dsh-study-desk')
if (!route) throw new Error(`没注册路由，拿到的是 ${JSON.stringify(routes.map((r) => r && r.path))}`)
const res = fakeRes()
await route.handler({ method: 'GET', url: '/api/dsh-study-desk', headers: {}, on() {} }, res)
const snapshot = JSON.parse(res.body)

// 顺手验 POST 通路的 weekly.text op（「复制周报」按钮用的纯文本，格式与工具 report 同一份）
const resW = fakeRes()
await route.handler({
  headers: {},
  on(ev, cb) {
    if (ev === 'data') cb(Buffer.from(JSON.stringify({ op: 'weekly.text' })))
    if (ev === 'end') cb()
  },
}, resW)
let weeklyText = ''
try { weeklyText = JSON.parse(resW.body).text || '' } catch { /* op 挂了就留空，下面会报 */ }
console.log('[weekly.text] ok:', weeklyText.includes('周（每周从周一算起）'), '| head:', (weeklyText.split('\n')[0] || 'n/a').slice(0, 40))
rmSync(HOME, { recursive: true, force: true })
// 快照里带着临时 home 的绝对路径，会原样印进页脚 —— 截图是要给人看的，换成占位写法。
for (const key of ['deskFile', 'markdownFile']) {
  if (snapshot[key]) snapshot[key] = `<DSH_HOME>/study-desk/${String(snapshot[key]).split(/[\\/]/).pop()}`
}
console.log('[snapshot] keys:', Object.keys(snapshot).join(','))
console.log('[snapshot] focusPie today slices:', (snapshot.focusPie?.today || []).length,
  '| month:', (snapshot.focusPie?.month || []).length,
  '| board:', JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([k]) => /task|board|column|state/.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]))))

// ---------------------------------------------------------------- 2. 宿主 token
function extractTokens() {
  const asar = readFileSync(ASAR, 'latin1')
  const blocks = []
  const re = /(body(?:\[data-ds-dark-theme\])?)\{(--dsw-[^}]*)\}/g
  let m
  while((m = re.exec(asar))) blocks.push({ sel: m[1], first: m[2].split(';')[0].split(':')[0], css: m[0] })
  // 同一个 selector + 同一组变量的重复定义里挑最完整的那份（asar 里有 minified / 非 minified 两份拷贝）
  const best = new Map()
  for (const b of blocks) {
    const key = b.sel + '|' + b.first.slice(0, 22)
    if (!best.has(key) || best.get(key).length < b.css.length) best.set(key, b.css)
  }
  const dark = [...best.values()].filter((c) => c.startsWith('body[data-ds-dark-theme]')).join('\n')
  const light = [...best.values()].filter((c) => !c.startsWith('body[data-ds-dark-theme]')).join('\n')
  return { light, dark }
}
const tokens = extractTokens()
console.log('[tokens] light', tokens.light.length, 'B | dark', tokens.dark.length, 'B')

// ---------------------------------------------------------------- 3. 两版 client.js
const clientNew = readFileSync(join(ROOT, 'client.js'), 'utf8')
const clientOld = execFileSync('git', ['show', 'HEAD:client.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
writeFileSync(join(OUT, 'client.new.js'), clientNew)
writeFileSync(join(OUT, 'client.old.js'), clientOld)
cpSync(join(REACT_DIR, 'react/umd/react.production.min.js'), join(OUT, 'react.js'))
cpSync(join(REACT_DIR, 'react-dom/umd/react-dom.production.min.js'), join(OUT, 'react-dom.js'))

// ---------------------------------------------------------------- 4. 外壳
// 热力图 + 「今日复习」卡里那排柱状图的三套候选色，全部由宿主 token 派生。
const G = 'var(--dsw-static-green-500)'
const A4 = 'var(--dsw-static-amber-400)'
const A5 = 'var(--dsw-static-amber-500)'
const R5 = 'var(--dsw-static-red-500)'
const TEAL = 'color-mix(in srgb,var(--dsw-static-blue-450) 55%,var(--dsw-static-green-400))'
const BG3 = 'var(--dsw-alias-bg-layer-3)'
const ramp = (c) => [
  `.sd-cell.lv1{background:color-mix(in srgb,${c} 24%,${BG3})}`,
  `.sd-cell.lv2{background:color-mix(in srgb,${c} 48%,${BG3})}`,
  `.sd-cell.lv3{background:color-mix(in srgb,${c} 74%,${BG3})}`,
  `.sd-cell.lv4{background:${c}}`,
].join('')
const HEAT_VARIANTS = {
  green: ramp(G) + `.sd-fbar-fill{background:color-mix(in srgb,${G} 46%,transparent)}.sd-fbar.today .sd-fbar-fill{background:${G}}`,
  teal: ramp(TEAL) + `.sd-fbar-fill{background:color-mix(in srgb,${TEAL} 46%,transparent)}.sd-fbar.today .sd-fbar-fill{background:${TEAL}}`,
  // 暖色不是等比拉饱和：低档用琥珀、高档压到红，才看得出「越久越热」而不是「越来越橙」
  warm: [
    `.sd-cell.lv1{background:color-mix(in srgb,${A4} 34%,${BG3})}`,
    `.sd-cell.lv2{background:${A5}}`,
    `.sd-cell.lv3{background:color-mix(in srgb,${A5} 55%,${R5})}`,
    `.sd-cell.lv4{background:${R5}}`,
    `.sd-fbar-fill{background:color-mix(in srgb,${A5} 52%,transparent)}`,
    `.sd-fbar.today .sd-fbar-fill{background:${R5}}`,
  ].join(''),
}

const boot = String.raw`
const Q = new URLSearchParams(location.search)
const DARK = Q.get('dark') === '1'
if (DARK) document.body.setAttribute('data-ds-dark-theme', '')
// ?heat=green|warm|teal 给热力图与复习柱状图套一层候选配色（同优先级、写在后面就能覆盖）。
// 色值一律走宿主 --dsw-static-*，和插件的「绝不写死颜色」规矩一致。
const HEAT = ${JSON.stringify(HEAT_VARIANTS)}
if (Q.get('heat') && HEAT[Q.get('heat')]) {
  const st = document.createElement('style')
  st.textContent = HEAT[Q.get('heat')]
  document.head.appendChild(st)
}
window.__ModuleLoader__ = { load: (def) => { window.__def = def } }
const API = '/api/dsh-study-desk'
window.__calls = []
window.addEventListener('error', (e) => { window.__bootError = (window.__bootError || '') + ' ' + e.message })
window.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {}
  window.__calls.push(body.op || 'GET')
  // 行为断言有时要看完整 payload（比如 task.add 里的 dueDate），跟 op 名分开记
  ;(window.__callBodies = window.__callBodies || []).push(body)
  if (body.op === 'diag.report') return { ok: true, status: 200, json: async () => ({ ok: true }) }
  // 让假宿主稍微带点状态：settings.update 真把 patch 合进快照，
  // 这样才能验「输入 90 → 秒表显示 90:00」这条链，而不是只验渲染出来了个输入框。
  if (body.op === 'settings.update' && body.patch) Object.assign(window.__SNAPSHOT__.state.settings, body.patch)
  return { ok: true, status: 200, json: async () => window.__SNAPSHOT__ }
}
`

const mount = String.raw`
const require = (name) => (name === 'react' ? window.React : name === 'react-dom' ? window.ReactDOM : {})
const mod = window.__def.factory(require)
const slots = []
// client.js 只走 slots.inject(slot, () => slots.register(meta, factory))，
// 而 meta.name 就是槽位名，所以登记处按 meta.name 收即可。
const slotsSvc = {
  inject: (slot, fn) => { fn(); return () => {} },
  register: (meta, factory) => { slots.push({ meta, factory }); return () => {} },
}
const ctx = { get: (k) => (k === 'slots' ? slotsSvc : undefined), effect: (f) => { f(); return () => {} }, provide: () => () => {}, log: () => {} }
mod.apply(ctx)

const hostOf = (meta) => {
  if (meta.name === 'main') return meta.key === 'study-desk' ? document.getElementById('main') : document.getElementById('main2')
  if (meta.name === 'shell.overlay') return document.getElementById('overlay')
  if (meta.name === 'sidebar.panellist') return document.getElementById('nav')
  if (meta.name === 'settings.section') return document.getElementById('settings')
  return null
}
// 先让 apply() 里的 store.refresh() 把快照取回来，再挂载：一挂载就有数据，
// 不用等第二次并发重渲染（虚拟时间未必泵得动 MessageChannel）。
setTimeout(() => {
  for (const s of slots) {
    const host = hostOf(s.meta)
    if (!host) continue
    // 无头 --dump-dom/--screenshot 靠 --virtual-time-budget 推进时间，而 React 18 的并发 root
    // 是 MessageChannel 调度的，虚拟时间不一定泵得动 —— flushSync 强制同步提交。
    ReactDOM.flushSync(() => ReactDOM.createRoot(host).render(s.factory()))
  }
  window.__slotCount = slots.length
  // ?range=month：切到「近 30 天」，她那个月饼才有 5 段，颜色分不分得开才看得出来。
  // React 的 onClick 会在 dispatch 里同步跑，外面套 flushSync 才能让这次状态更新立刻提交。
  if (Q.get('range') === 'month') {
    const pill = document.querySelectorAll('.sd-range-tabs button')[1]
    if (pill) ReactDOM.flushSync(() => pill.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }
  // ?setmin=90：往「自定义」那个框里填值并回车提交，验「输入 → settings → 秒表」这条链
  const setMin = Q.get('setmin')
  if (setMin) {
    const el = document.querySelector('.sd-timer-card input[type=number]')
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, setMin)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  }
  setTimeout(() => {
    const diag = document.getElementById('diag')
    const rectOf = (sel) => { const el = document.querySelector(sel); if (!el) return 'none'; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',') }
    const page = document.querySelector('.sd-page')
    const err = document.querySelector('.sd-error')
    const pie = (window.__SNAPSHOT__.focusPie || {})
    diag.textContent = [
      'react=' + window.React.version,
      'slots=' + slots.length,
      'mounted=' + Boolean(page),
      'pageH=' + Math.round(page ? page.getBoundingClientRect().height : 0),
      'mainKids=' + document.getElementById('main').childElementCount,
      'pieMonth=' + ((pie.month || []).length),
      'cards=' + document.querySelectorAll('.sd-card').length,
      'heatCells=' + document.querySelectorAll('.sd-cell').length,
      'slices=' + document.querySelectorAll('.sd-pie path').length,
    'timerNumFields=' + document.querySelectorAll('.sd-timer-card input[type=number]').length,
    'focusMinNow=' + window.__SNAPSHOT__.state.settings.focusMin,
    'idleClock=' + ((document.querySelector('.sd-timer-clock') || {}).textContent || 'none'),
    'playTitle=' + ((document.querySelector('.sd-timer-card .sd-iconbtn-lg') || {}).title || 'none'),
      'pieRect=' + rectOf('.sd-pie-wrap'),
    'heatRect=' + rectOf('.sd-heat'),
    'forecastRect=' + rectOf('.sd-forecast'),
      'mini=' + document.querySelectorAll('.sd-mini').length,
      'calls=' + window.__calls.join(','),
      'errText=' + (err ? String(err.textContent).slice(0, 160) : 'none'),
      'bootErr=' + (window.__bootError || 'none'),
    ].join(' | ')
    window.__mounted = true
  }, 260)
}, 300)
`

const shell = `
html,body{margin:0;height:100%;font-family:var(--dsw-font-family);}
.frame{display:grid;grid-template-columns:236px minmax(0,1fr);height:100vh;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.side{background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));border-right:1px solid var(--dsw-alias-border-l1);padding:14px 10px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.centerCol{display:flex;flex-direction:column;overflow:hidden;position:relative;background:var(--dsw-alias-bg-layer-1)}
.overlayLayer{position:absolute;inset:0;z-index:20;pointer-events:none}
.overlayLayer>*{pointer-events:auto}
.navbtn{font-size:13px;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
#main2,#settings{display:none}
`

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>study-desk harness</title>
<style id="host-tokens">${tokens.light}\n${tokens.dark}</style>
<style>body{--dsh-font-family-text-default:system-ui,"Segoe UI","Microsoft YaHei",sans-serif}${shell}</style>
</head><body>
<div class="frame">
  <div class="side"><div class="navbtn">对话</div><div id="nav"></div></div>
  <div class="centerCol"><div id="main" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></div>
  <div class="overlayLayer" id="overlay"></div>
</div>
<div id="main2"></div><div id="settings"></div>
<pre id="diag" style="position:fixed;left:-9999px;top:0"></pre>
<script>${boot}</script>
<script>window.__SNAPSHOT__ = ${JSON.stringify(snapshot)}</script>
<script src="react.js"></script><script src="react-dom.js"></script>
<script src="client.__CLIENT__.js"></script>
<script>${mount}</script>
</body></html>`

writeFileSync(join(OUT, 'panel-new.html'), html.replace('__CLIENT__', 'new'))
writeFileSync(join(OUT, 'panel-old.html'), html.replace('__CLIENT__', 'old'))

// ---------------------------------------------------------------- 5. 色板对照页
// 她那个月饼只有 5 段，看不出 8 色好不好分；这一页把 8 个 tone 都铺出来，
// 深浅底各一行，并写上每个色值出自哪个 token（方便核对「没有写死颜色」这条）。
const { PIE_TONES } = (await import('./client-loader.mjs')).loadClient()
const toneLabel = (t) => t
  .replace(/var\(--dsw-static-([\w-]+)\)/g, '$1')
  .replace(/color-mix\(in srgb,var\(--dsw-static-([\w-]+)\) (\d+)%,var\(--dsw-static-([\w-]+)\)\)/g, '$1 + $3 @$2%')
const palettePage = (dark) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style id="host-tokens">${tokens.light}\n${tokens.dark}</style>
<style>body{margin:0;padding:22px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:13px}
.strip{display:flex;gap:9px}
.cell{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px}
.cell i{display:block;width:100%;height:62px;border-radius:12px}
.cell b{font-size:13px;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-direction:column;gap:4px;margin-top:16px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.legend code{font-family:ui-monospace,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
h2{font-size:12px;letter-spacing:.12em;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:0 0 14px}
</style></head><body${dark ? ' data-ds-dark-theme' : ''}>
<h2>饼图分类色板 · 8 色 · 全部取自宿主 --dsw-static-*</h2>
<div class="strip">${PIE_TONES.map((t, i) => `<div class="cell"><i style="background:${t}"></i><b>${i + 1}</b></div>`).join('')}</div>
<div class="legend">${PIE_TONES.map((t, i) => `<span><b>${i + 1}</b> <code>${toneLabel(t)}</code></span>`).join('<br>')}</div>
</body></html>`
writeFileSync(join(OUT, 'palette-light.html'), palettePage(false))
writeFileSync(join(OUT, 'palette-dark.html'), palettePage(true))
console.log('[done] .shots/panel-{new,old}.html .shots/palette-{light,dark}.html (' + PIE_TONES.length + ' tones)')
