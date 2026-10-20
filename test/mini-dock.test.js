import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, readClientSource, VW, VH } from '../tools/client-loader.mjs'

// 迷你条的落点：松手就停在原地，只做视口钳制（防拖丢）。
// 加载真 bundle 的手段见 tools/client-loader.mjs，这里只关心钳制行为本身。

const W = 220
const H = 60

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
  const code = readClientSource()
  assert.ok(!/function\s+snapMiniPos/.test(code), 'snapMiniPos 还在')
  assert.ok(!/snapping/.test(code), 'snapping 还在')
})

// 下面两条来自一次真机故障：她把迷你条拖到顶边（中心 y=26），之后整条钟点不动也拖不动。
// 宿主在 Windows 上给 .BynINW_frame::before 画了一条 40px 满宽的 -webkit-app-region:drag 带，
// 右上还压着 z-index:1100 的窗口按钮；迷你条是 portal 到 body 的 z-index:900，停进去就同时
// 失去点击与拖动，而唯一逃出来的手势（拖走 / 双击回右下角）本身也需要点击 —— 死局。

test('迷你条声明 no-drag：不靠拖拽带让出输入', () => {
  const { CSS } = loadClient()
  for (const sel of ['.sd-mini', '.sd-mini-fab']) {
    const rule = CSS.split('}').find((r) => r.startsWith(`${sel}{`))
    assert.ok(rule, `${sel} 规则没找到`)
    assert.match(rule, /-webkit-app-region:\s*no-drag/, `${sel} 没声明 -webkit-app-region:no-drag`)
  }
})

test('迷你条不许停进 Windows 标题栏那条拖拽带', () => {
  const { clampMiniPos } = loadClient()
  assert.equal(clampMiniPos({ x: 500, y: 6 }, W, H).y, 40, 'top=6 应被推到 40px 带之下')
  assert.equal(clampMiniPos({ x: 500, y: -100 }, W, H).y, 40, '拖出顶边也只回到带之下')
  assert.equal(clampMiniPos({ x: 500, y: 300 }, W, H).y, 300, '带以下的落点不许动')

  const attrs = globalThis.document.documentElement.attrs
  attrs.add('data-fullscreen')
  assert.equal(clampMiniPos({ x: 500, y: 6 }, W, H).y, 6, '全屏没有标题栏，该许贴顶')
  attrs.delete('data-fullscreen')
  attrs.delete('data-windows-titlebar')
  assert.equal(clampMiniPos({ x: 500, y: 6 }, W, H).y, 6, '非 Windows 标题栏不该凭空留 40px')
})
