import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from '../tools/client-loader.mjs'

// 视觉层的守卫。这些断言不是为了「测样式」，而是钉住项目里两条会被人手滑破掉的硬约束：
//   1. AGENTS.md 规则 1：绝不写死颜色，只消费 --dsw-alias-* / --dsw-static-*
//   2. 饼图是分类色板，不是语义色：语义色里有三个其实都是灰的，环就糊成一片

test('CSS 里不许出现写死的 hex 颜色', () => {
  const { CSS } = loadClient()
  const hexes = CSS.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.deepEqual(hexes, [], `出现了写死的 hex：${hexes.join(' ')}`)
})

test('饼图用 8 色宿主色板，够铺满分段数', () => {
  const { PIE_TONES, MAX_SLICES } = loadClient()
  assert.equal(PIE_TONES.length, 8, '分类色板应当有 8 色')
  assert.ok(PIE_TONES.length >= MAX_SLICES, `MAX_SLICES=${MAX_SLICES} 超过色板长度会重复取色`)
  for (const tone of PIE_TONES) {
    assert.match(tone, /--dsw-static-/, `${tone} 没有引用宿主色板 token`)
  }
  // 语义色(brand/idle/success)拿来当分类色是这次的病根，别退回去
  for (const tone of PIE_TONES) {
    assert.ok(!/--dsw-alias-(brand|state-idle)/.test(tone), `${tone} 又用回语义色了`)
  }
})

test('字阶收档：不许有零点几像素的字号', () => {
  const { CSS } = loadClient()
  const fractional = CSS.match(/font-size:\s*[\d.]+\.\d+px/g) || []
  assert.deepEqual(fractional, [], `半像素字号会产生亚像素模糊：${fractional.join(' ')}`)
})

test('投入类图表走绿色阶、到期预报走暖色，不再用会掉成灰的品牌色', () => {
  const { CSS } = loadClient()
  const rule = (sel) => CSS.split('}').find((r) => r.startsWith(`${sel}{`))
  // 病根：brand-primary 在她这套主题里解析成 neutral-bluish-1000（近黑），
  // 拿它当色阶就是「灰→白」，看着像没上色。
  for (const lv of ['.sd-cell.lv1', '.sd-cell.lv2', '.sd-cell.lv3', '.sd-cell.lv4']) {
    const r = rule(lv)
    assert.ok(r, `${lv} 规则没找到`)
    assert.match(r, /--dsw-static-green-500/, `${lv} 没走绿色阶`)
  }
  assert.match(rule('.sd-week.current .sd-week-fill'), /--dsw-static-green-500/, '周报当前周该跟热力图同族')
  assert.match(rule('.sd-bar-study .sd-bar-fill'), /--dsw-static-green-500/, '今日进度条该跟热力图同族')
  assert.match(rule('.sd-fbar-fill'), /--dsw-static-amber-500/, '到期预报柱体该走暖色')
  assert.match(rule('.sd-fbar.today .sd-fbar-fill'), /--dsw-static-red-500/, '今天那一根该转红')
  // 计时器那条她没让改，别顺手改齐
  assert.match(rule('.sd-bar-fill'), /--dsw-alias-brand-primary/)
})

test('标题不用衬线：番茄感不该是学术腔', () => {
  const { CSS } = loadClient()
  for (const serif of ['ui-serif', 'Georgia', 'Songti', 'Noto Serif']) {
    assert.ok(!CSS.includes(serif), `CSS 里还有衬线族 ${serif}`)
  }
})

test('字号阶梯真的接上了线，而且四个根都拿得到', () => {
  const { CSS } = loadClient()
  const holder = CSS.split('}').find((r) => r.includes('--sd-fs-hero:'))
  assert.ok(holder, '没有任何规则定义阶梯')
  const steps = holder.match(/--sd-fs-[\w-]+:/g) || []
  assert.ok(steps.length >= 5, `阶梯至少 5 档，实际 ${steps.length} 档`)
  // 迷你条是 portal 到 body 的，不在 .sd-page 里；根上没挂阶梯就会静默丢字号
  for (const root of ['.sd-page', '.sd-settings', '.sd-mini']) {
    assert.ok(holder.split('{')[0].includes(root), `阶梯没挂在 ${root} 上`)
  }
  assert.match(CSS, /font-size:var\(--sd-fs-/, '没有规则消费阶梯变量')
})
