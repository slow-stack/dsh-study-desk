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
