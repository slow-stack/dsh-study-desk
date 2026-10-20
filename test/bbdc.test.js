import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bbdcView,
  compactDate,
  enumerateMonths,
  parseUserPrefs,
  sidVariants,
  signedDates,
  sumByMonth,
  sumDurationByMonth,
  xmlToMap,
} from '../bbdc.js'

// 一段真实的 SharedPreferences 片段（值都按实际观测形态手抄，含 &quot; 转义）
const PREF_XML = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="userInfo">{&quot;continue&quot;:2,&quot;id&quot;:237240284,&quot;name&quot;:&quot;Séraphina&quot;,&quot;totalDays&quot;:128}</string>
    <string name="key_learn_duration_last">{&quot;total&quot;:{&quot;amount&quot;:0,&quot;duration&quot;:1998,&quot;durationInSec&quot;:119873},&quot;today&quot;:{&quot;amount&quot;:0,&quot;duration&quot;:0,&quot;durationInSec&quot;:0}}</string>
    <string name="week_learn_sign_status">[{&quot;date&quot;:&quot;2026-10-12&quot;,&quot;sign_in&quot;:1,&quot;study&quot;:0},{&quot;date&quot;:&quot;2026-10-13&quot;,&quot;sign_in&quot;:1,&quot;study&quot;:0}]</string>
    <string name="library_learning">{&quot;name&quot;:&quot;2027考研英语红宝书（乱序版）&quot;,&quot;code&quot;:&quot;KYHBS2027L&quot;,&quot;count&quot;:6590}</string>
    <string name="learn_plan_config_pre_11650">{&quot;bookId&quot;:1165,&quot;wordCount&quot;:95,&quot;phraseCount&quot;:10}</string>
    <string name="checkIn_date">20261013</string>
    <int name="key_reward_finish_today_review" value="10" />
</map>`

test('xmlToMap 同时认得自闭合标签和带 body 的标签', () => {
  const map = xmlToMap(PREF_XML)
  assert.equal(map.checkIn_date, '20261013')
  assert.equal(map.key_reward_finish_today_review, '10')
  assert.ok(map.userInfo.startsWith('{'))
})

test('parseUserPrefs 把 App 的 prefs 还原成面板字段', () => {
  const r = parseUserPrefs(xmlToMap(PREF_XML))
  assert.equal(r.user.uid, 237240284)
  assert.equal(r.user.nickname, 'Séraphina')
  assert.equal(r.user.continuousDays, 2)
  assert.equal(r.user.totalDays, 128)
  assert.equal(r.today.durationMin, 0)
  assert.equal(r.today.words, 0)
  assert.equal(r.total.durationMin, 1998)
  assert.equal(r.total.durationSec, 119873)
  assert.equal(r.checkIn.lastDate, '2026-10-13')
  assert.equal(r.checkIn.week.length, 2)
  assert.equal(r.checkIn.week[0].signIn, true)
  assert.equal(r.book.name, '2027考研英语红宝书（乱序版）')
  assert.equal(r.book.wordCount, 6590)
  assert.equal(r.dailyPlan.wordCount, 95)
  assert.equal(r.dailyPlan.phraseCount, 10)
})

test('parseUserPrefs 对残缺 prefs 不炸，缺字段就给 0 / null', () => {
  const r = parseUserPrefs({})
  assert.equal(r.user.uid, 0)
  assert.equal(r.user.nickname, null)
  assert.equal(r.total.durationMin, 0)
  assert.equal(r.checkIn.lastDate, null)
  assert.deepEqual(r.checkIn.week, [])
  assert.equal(r.book, undefined)
  assert.equal(r.dailyPlan, undefined)
})

test('compactDate 只认 8 位数字', () => {
  assert.equal(compactDate('20261013'), '2026-10-13')
  assert.equal(compactDate(''), null)
  assert.equal(compactDate('2026-10-13'), null)
  assert.equal(compactDate(null), null)
})

test('sumByMonth 把 48 个月的表加成累计词数', () => {
  const list = []
  for (let i = 0; i < 47; i += 1) list.push({ date: 'x', learnNum: 0, reviewNum: 0 })
  list.push({ date: '本月', learnNum: 0, reviewNum: 60 })
  assert.equal(sumByMonth(list).totalWords, 0)
  // 造一份能加出 293 的表
  const learn = [{ learnNum: 200, reviewNum: 1 }, { learnNum: 93, reviewNum: 2 }]
  assert.deepEqual(sumByMonth(learn), { totalWords: 293, totalReviews: 3, months: 2 })
  assert.deepEqual(sumByMonth(null), { totalWords: 0, totalReviews: 0, months: 0 })
})

test('sumDurationByMonth 忽略坏值', () => {
  assert.equal(sumDurationByMonth([{ duration: 10 }, { duration: '5' }, { duration: null }]), 15)
  assert.equal(sumDurationByMonth(undefined), 0)
})

test('enumerateMonths 跨年推进并受上限保护', () => {
  assert.deepEqual(enumerateMonths('2026-10', '2026-12'), ['2026-10', '2026-11', '2026-12'])
  assert.deepEqual(enumerateMonths('2025-11', '2026-01'), ['2025-11', '2025-12', '2026-01'])
  assert.equal(enumerateMonths('2024-08', '2026-10').length, 27)
  assert.equal(enumerateMonths('2024-08', '2026-10', 5).length, 5)
  assert.deepEqual(enumerateMonths('坏', '2026-10'), [])
})

test('signedDates 摊平 byMonth，只留打过卡的日期并按升序', () => {
  const byMonth = {
    '2026-09': [{ date: '2026-09-30', signin: 1 }, { date: '2026-09-29', signin: 0 }],
    '2026-10': [{ date: '2026-10-01', signin: 1 }, { date: '2026-10-02', signin: 0 }, { date: '2026-10-13', signin: 1 }],
  }
  assert.deepEqual(signedDates(byMonth), ['2026-09-30', '2026-10-01', '2026-10-13'])
  assert.equal(signedDates(null).length, 0)
  assert.equal(signedDates({}).length, 0)
  // 同一天出现在两个月表里也不重复
  assert.deepEqual(signedDates({ a: [{ date: '2026-10-01', signin: 1 }], b: [{ date: '2026-10-01', signin: 1 }] }), ['2026-10-01'])
})

test('bbdcView 只放行该给面板看的字段，sid 摘要与临时目录不外传', () => {
  const raw = {
    fetchedAt: 123,
    source: ['app-local', 'learnywhere-api'],
    ok: true,
    error: null,
    sidHint: 'BWwVSbKC…（已隐藏）',
    tmpDir: 'C:/Users/somebody/AppData/Local/Temp/dsh-bbdc-xyz',
    user: { uid: 237240284, nickname: 'Séraphina', continuousDays: 2, totalDays: 128 },
    total: { durationMin: 1998, durationSec: 119873 },
    cloud: {
      ok: true,
      totalWords: 293,
      totalReviews: 1776,
      months: 48,
      totalDurationMin: 1998,
      calendar: { month: '2026-10', minMonth: '2024-08', maxMonth: '2026-10', byMonth: { '2026-10': [{ date: '2026-10-01', signin: 1 }, { date: '2026-10-02', signin: 0 }] } },
    },
  }
  const v = bbdcView(raw)
  assert.equal(v.user.nickname, 'Séraphina')
  assert.equal(v.cloud.totalWords, 293)
  assert.deepEqual(v.calendar.signedDates, ['2026-10-01'])
  assert.equal(v.calendar.month, '2026-10')
  // 不该出现的：sid 摘要、临时目录、按月的整份原始表
  assert.equal('sidHint' in v, false)
  assert.equal('tmpDir' in v, false)
  assert.equal('byMonth' in v.calendar, false)
  assert.equal(JSON.stringify(v).includes('已隐藏'), false)
  assert.equal(JSON.stringify(v).includes('dsh-bbdc'), false)
  // 缓存里存的就是这一份，往返后仍能还原日历
  assert.deepEqual(bbdcView(JSON.parse(JSON.stringify(v))).calendar.signedDates, ['2026-10-01'])
})

test('时长取本地与云端里较新的那一份：虚拟磁盘惰性刷盘，本地能落后好几天', () => {
  // 实测：10-20 采集时本地 prefs 还是 10-14 的快照（今日 20 / 累计 2018），
  // 同一时刻云端 dashboard 已经是 今日 82 / 累计 2131。面板只看本地那两个字段就报错了数。
  const stale = {
    ok: true,
    fetchedAt: 1,
    source: ['app-local', 'learnywhere-api'],
    today: { durationMin: 20, durationSec: 1192, words: 0 },
    total: { durationMin: 2018, durationSec: 121065 },
    cloud: {
      ok: true,
      totalDurationMin: 2131,
      today: { date: '今日', learnNum: 0, reviewNum: 66 },
      recentDuration: [{ date: '10-19', duration: 17 }, { date: '今日', duration: 82 }],
    },
  }
  const v = bbdcView(stale)
  assert.equal(v.today.durationMin, 82, '今日时长该用云端更新的')
  assert.equal(v.total.durationMin, 2131, '累计时长该用云端更新的')
  // 分和秒必须配套：index.js 把「X 分钟（Y 秒）」注入 system prompt，不能一个是新一个是旧快照
  assert.equal(v.today.durationSec, 82 * 60)
  assert.equal(v.total.durationSec, 2131 * 60)

  // 本地那份更大时：累计不许退步（只增不减），但「今日」要用云端 —— 它每天归零，
  // 取大等于把昨天那份当成今天的（过零点实测本地和云端都还挂着前一天的 82）。
  const localBigger = bbdcView({
    ok: true,
    fetchedAt: 1,
    today: { durationMin: 90, durationSec: 5400, words: 3 },
    total: { durationMin: 2200, durationSec: 132000 },
    cloud: { ok: true, totalDurationMin: 2131, today: { date: '今日' }, recentDuration: [{ date: '今日', duration: 82 }] },
  })
  assert.equal(localBigger.today.durationMin, 82, '今日该用实时的云端那一行')
  assert.equal(localBigger.today.durationSec, 82 * 60)
  assert.equal(localBigger.total.durationMin, 2200, '累计是单调的,本地更大就不退步')
  assert.equal(localBigger.total.durationSec, 132000)

  // 云端连上了但 durationList 里没有「今日」行（接口换形状）→ 退回本地,不是报 0
  const noRow = bbdcView({
    ok: true,
    fetchedAt: 1,
    today: { durationMin: 30, durationSec: 1800, words: 3 },
    total: { durationMin: 2200, durationSec: 132000 },
    cloud: { ok: true, totalDurationMin: 2200, recentDuration: [{ date: '10-20', duration: 40 }] },
  })
  assert.equal(noRow.today.durationMin, 30)

  // 打平时保留本地那份更精确的秒
  const tie = bbdcView({ ...stale, cloud: { ...stale.cloud, totalDurationMin: 2018, recentDuration: [{ date: '今日', duration: 20 }] } })
  assert.equal(tie.total.durationSec, 121065, '打平时该留本地的秒，别把精度抹成整分钟')

  // 云端缺席（sid 失效）时退回纯本地，不许变 0
  const offline = bbdcView({ ok: true, fetchedAt: 1, today: { durationMin: 20, durationSec: 1192 }, total: { durationMin: 2018, durationSec: 121065 } })
  assert.equal(offline.today.durationMin, 20)
  assert.equal(offline.total.durationMin, 2018)

  // 幂等：缓存读回来再裁一次不许变
  assert.deepEqual(bbdcView(JSON.parse(JSON.stringify(v))).today, v.today)
  assert.deepEqual(bbdcView(JSON.parse(JSON.stringify(v))).total, v.total)
})

test('本地时长记到哪天：last 和逐日快照对内容，落后就标出来', () => {
  // 形状照 2026-10-20 实测：last 的内容其实是 10-14 那一次刷盘的快照
  const D14 = '{"total":{"duration":2018,"durationInSec":121065},"today":{"duration":20,"durationInSec":1192}}'
  const D15 = '{"total":{"duration":2080,"durationInSec":124800},"today":{"duration":62,"durationInSec":3720}}'
  const pref = {
    checkIn_date: '20261015',
    key_learn_duration_20261014: D14,
    key_learn_duration_last: D14,
  }
  const stale = parseUserPrefs(pref, '2026-10-15')
  assert.equal(stale.durationAsOf, '2026-10-14')
  assert.equal(stale.durationStale, true, '本地没刷到今天就该标陈旧，别让面板报一个看着正常的错数')

  const fresh = parseUserPrefs({ ...pref, key_learn_duration_20261015: D15, key_learn_duration_last: D15 }, '2026-10-15')
  assert.equal(fresh.durationAsOf, '2026-10-15')
  assert.equal(fresh.durationStale, false)

  // 只有 last、没有逐日快照时退回 checkIn_date，不误判
  const onlyLast = parseUserPrefs({ checkIn_date: '20261015', key_learn_duration_last: D15 }, '2026-10-15')
  assert.equal(onlyLast.durationAsOf, '2026-10-15')
  assert.equal(onlyLast.durationStale, false)

  // 内容相同的两天取最靠后的（那天没学、累计没动，不该说成更早那天）
  const same = parseUserPrefs({ checkIn_date: '20261015', key_learn_duration_20261013: D15, key_learn_duration_20261014: D15, key_learn_duration_last: D15 }, '2026-10-15')
  assert.equal(same.durationAsOf, '2026-10-14')

  // 没传 today 就不下判断（纯函数,老调用方不受影响）
  assert.equal(parseUserPrefs(pref).durationStale, false)

  // view 要把这两个字段放行出去，面板才标得出来
  const v = bbdcView({ ok: true, fetchedAt: 1, ...stale, total: stale.total, today: stale.today })
  assert.equal(v.durationAsOf, '2026-10-14')
  assert.equal(v.durationStale, true)
  assert.equal(v.durationMightBeStale, true, '本地落后又没连上服务端，该提醒')

  // 云端这次兜住了，就不该再报陈旧（数其实是从实时接口取的）
  const covered = bbdcView({
    ok: true, fetchedAt: 1, ...stale, total: stale.total, today: stale.today,
    cloud: { ok: true, totalDurationMin: 2080, recentDuration: [{ date: '今日', duration: 62 }] },
  })
  assert.equal(covered.durationMightBeStale, false)
  assert.equal(covered.total.durationMin, 2080)
})

test('bbdcView 对空值/失败结果返回 null 或带 error 的壳，不抛错', () => {
  assert.equal(bbdcView(null), null)
  const failed = bbdcView({ ok: false, error: '找不到 7z.exe（Androws 自带或系统安装）' })
  assert.equal(failed.ok, false)
  assert.ok(failed.error.includes('7z.exe'))
  assert.equal(failed.cloud, null)
  assert.equal(failed.calendar, null)
  assert.deepEqual(failed.source, [])
})

test('sidVariants 给出几种编码形态且去重', () => {
  const v = sidVariants('a+b/c')
  assert.ok(v.includes('a+b/c'))
  assert.ok(v.includes('a%2Bb%2Fc'))
  assert.equal(new Set(v).size, v.length)
  // 已是编码形态的串，原样那一版必须在候选里（原样拼 URL 才对）
  const encoded = 'BWwV%2B37%2F'
  assert.ok(sidVariants(encoded).includes(encoded))
})
