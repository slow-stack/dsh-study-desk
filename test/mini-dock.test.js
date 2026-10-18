import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 迷你条的落点：松手就停在原地，只做视口钳制（防拖丢）。
// 这里直接载入 client.js 的真实实现，避免另写一份算法导致「测的和跑的不是同一份」。

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'client.js')
const VW = 1280
const VH = 800
const W = 220
const H = 60

function loadClient() {
  let code = readFileSync(src, 'utf8')
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def } },
    innerWidth: VW,
    innerHeight: VH,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = {
    body: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  }
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true })
  } catch { /* 已经定义过就沿用 */ }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  globalThis.location = { origin: 'http://127.0.0.1' }

  const React = {
    createElement: (...a) => ({ a }),
    Fragment: 'F',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (f) => f(),
    useCallback: (f) => f,
    useSyncExternalStore: () => ({}),
    useContext: () => null,
    createContext: () => ({ Provider: 'P' }),
    useLayoutEffect: () => {},
    useReducer: (f, i) => [i, () => {}],
    Component: class {},
    PureComponent: class {},
  }
  const req = (name) => (name === 'react' ? React : name === 'react-dom' ? { createPortal: (x) => x } : {})
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(req, mod, {})
  return mod.exports.__test || captured.factory(req).__test
}

test('迷你条松手不再贴边：视口内的落点原样保留', () => {
  const { clampMiniPos } = loadClient()
  for (const p of [
    { x: 500, y: 300 },
    { x: 300, y: 200 },
    { x: 900, y: 500 },
    { x: 47, y: 400 },
    { x: 10, y: 400 },
    { x: 500, y: 690 },
  ]) {
    const got = clampMiniPos(p, W, H)
    assert.ok(Math.abs(got.x - p.x) <= 1 && Math.abs(got.y - p.y) <= 1, `${JSON.stringify(p)} 被挪到了 ${JSON.stringify(got)}`)
  }
})

test('迷你条仍会被收回视口内（防拖出屏幕丢钟）', () => {
  const { clampMiniPos } = loadClient()
  const got = clampMiniPos({ x: -500, y: 5000 }, W, H)
  assert.ok(got.x >= 0 && got.x <= VW - W, 'x 出界')
  assert.ok(got.y >= 0 && got.y <= VH - H, 'y 出界')
})

test('吸附实现已移除：源码里不再有 snapMiniPos 与 snapping', () => {
  const code = readFileSync(src, 'utf8')
  assert.ok(!/function\s+snapMiniPos/.test(code), 'snapMiniPos 还在')
  assert.ok(!/snapping/.test(code), 'snapping 还在')
})
