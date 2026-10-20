// 把 client.js 这个「宿主 loader 格式」的 bundle 在纯 Node 里载进来，取出 exports.__test。
// 放在 tools/ 而不是 test/ 下，是因为 node --test 会把 test/ 里的每个文件都当测试跑一遍
// —— 这个文件没有断言，混进去只会在输出里多出一条假绿。
//
// 桩里刻意复刻了宿主的两个事实，因为实现会读它们：
//   - <html> 上的 data-windows-titlebar 与 --dsh-windows-titlebar-height（迷你条落点钳制要看）
//   - require('react-dom') 能拿到 createPortal（迷你条要 portal 到 body）
//
// new Function 只用来执行本仓库自己的 client.js（测试桩要它跑真实现，不想另写一份算法），
// 输入不是外部数据。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

const VW = 1280
const VH = 800
const TITLEBAR_PX = '40px'

export { VW, VH }

export function loadClient() {
  const code = readFileSync(src, 'utf8')
  let captured = null

  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def } },
    innerWidth: VW,
    innerHeight: VH,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    getComputedStyle: () => ({ getPropertyValue: () => TITLEBAR_PX }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = {
    body: null,
    documentElement: {
      attrs: new Set(['data-windows-titlebar']),
      hasAttribute(name) { return this.attrs.has(name) },
    },
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

export function readClientSource() {
  return readFileSync(src, 'utf8')
}
