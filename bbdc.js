/**
 * 不背单词 · 打卡数据读取（宿主侧模块）
 *
 * 不背单词的 Windows 版不是原生程序，是装在腾讯 Androws 安卓容器里的 APK。
 * 它的打卡数据有两条可取的路，这里两条都走，各取所长：
 *
 *   A. App 本地 —— 打卡时长/签到天数写在 App 自己的 SharedPreferences XML 里，
 *      位置在虚拟机磁盘 data.vhd 内部（Windows 文件系统上看不见）。
 *      做法：把运行中的 data.vhd 共享读复制一份 → 7z 抽出 shared_prefs → 解析。
 *      Androws 自带的 7z.exe 能直接把 VHD 当归档读，不用挂载。
 *
 *   B. 服务端 —— 同一份 VHD 里的 WebView 缓存存着 App 打开 H5 页面时用的 sid，
 *      用它打 learnywhere.cn 的 dashboard 接口，补上本地没有的：
 *      「累计学习 N 词」（按月 learnNum 求和）、逐日复习、整年打卡日历、金币流水。
 *
 * ★ 最要命的一个坑：缓存里的 sid 已经是「百分号编码过」的形态（含 %2B / %2F）。
 *   直接把它原样拼进 URL 才是对的；用 URLSearchParams.set 或 encodeURIComponent
 *   会二次编码（% → %25），服务端**不报错**，但会安静地返回一份游客演示数据
 *   （total_duration_num=175108 而不是真实的 1998）。所以下面 pickSid 会拿
 *   /api/user/by-sid 的昵称来验明正身：昵称是「游客」就说明这一版编码不对。
 *
 * 网络失败 / sid 过期时自动降级为纯本地，不让面板整个塌掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { dayKey, deskDir } from './desk.js'

export const PKG = 'cn.com.langeasy.LangEasyLexis'
export const HOST = 'https://learnywhere.cn'
export const UA = 'Mozilla/5.0 (Linux; Android 13; SM-N9860) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const DEFAULT_ANDROWS = 'D:/Program Files/Tencent/Androws'
/** 缓存多新算「还新鲜」。VHD 复制 + 7z 抽取要好几秒，别每开一次面板就重来一遍。 */
const CACHE_TTL = 10 * 60 * 1000
/** 一次最多回看多少个月，防 minMonth 被人写坏时把请求打爆 */
const MAX_MONTHS = 60

export function androwsRoot() {
  return process.env.DSH_BBDC_ANDROWS || DEFAULT_ANDROWS
}

export function findSevenZip(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_BBDC_7Z) return process.env.DSH_BBDC_7Z
  const dir = path.join(androwsRoot(), 'Application')
  try {
    const found = fs.readdirSync(dir).map((v) => path.join(dir, v, '7z.exe'))
      .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } }).sort()
    if (found.length) return found[found.length - 1]
  } catch { /* Androws 没装就没有 */ }
  for (const p of ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe']) {
    try { if (fs.existsSync(p)) return p } catch { /* 忽略 */ }
  }
  return null
}

export function findVhd(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_BBDC_VHD) return process.env.DSH_BBDC_VHD
  const candidates = [
    path.join(androwsRoot(), 'Image', 'data.vhd'),
    path.join(androwsRoot(), 'Image', '5.10.7500.2816', 'data.vhd'),
    'D:/Program Files/Tencent/AndrowsData/Component/Image/Image/data.vhd',
  ]
  for (const p of candidates) { try { if (fs.existsSync(p)) return p } catch { /* 忽略 */ } }
  return null
}

// ---------------------------------------------------------------------------
// SharedPreferences XML
// ---------------------------------------------------------------------------

export function xmlToMap(text) {
  const map = {}
  for (const m of text.matchAll(/<(string|int|long|boolean|float|set)\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) map[m[2]] = m[3]
  for (const m of text.matchAll(/<(string|int|long|boolean|float|set)\s+name="([^"]+)"\s*>([\s\S]*?)<\/\1>/g)) map[m[2]] = m[3]
  return map
}

const unesc = (s) => String(s ?? '')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const jparse = (s, d) => { try { return JSON.parse(unesc(s)) } catch { return d } }

const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** `20261013` → `2026-10-13`；不像日期就返回 null */
export function compactDate(v) {
  const s = String(v ?? '')
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}

/**
 * 从 `User_Preference_<uid>.xml` 的键值表里抽出面板要用的那几项。
 * 纯函数：给测试喂一段 XML 就能验，不碰文件系统也不联网。
 * @param {Record<string,string>} pref
 * @param {string|null} today 本地日期键 `YYYY-MM-DD`；给了才能判断本地刷没刷到今天
 */
export function parseUserPrefs(pref, today = null) {
  const userInfo = jparse(pref.userInfo, {})
  const lastRaw = pref.key_learn_duration_last ?? pref[`key_learn_duration_${pref.checkIn_date}`] ?? null
  const duration = jparse(lastRaw, {})
  const week = jparse(pref.week_learn_sign_status, [])
  const book = jparse(pref.library_learning, {})
  const plan = jparse(pref.learn_plan_config_pre_11650, {})
  // 本地这份时长到底「记到哪天」。Androws 惰性刷盘，last 可能还是几天前那一份，
  // 表现是数字看着挺正常、其实是旧的 —— 所以拿 last 的原文去和逐日快照键里内容相同的那个对。
  // 键名按日期升序扫，命中就覆盖，最后留下的是最晚的一天（中间那天没学、累计没动时不该说成更早）。
  let durationAsOf = compactDate(pref.checkIn_date)
  if (lastRaw != null) {
    for (const k of Object.keys(pref).sort()) {
      const m = /^key_learn_duration_(\d{8})$/.exec(k)
      if (m && pref[k] === lastRaw) durationAsOf = compactDate(m[1])
    }
  }
  const out = {
    user: {
      uid: int(userInfo.id),
      nickname: userInfo.name ?? null,
      continuousDays: int(userInfo.continue),
      totalDays: int(userInfo.totalDays),
    },
    today: {
      durationMin: int(duration.today?.duration),
      durationSec: int(duration.today?.durationInSec),
      words: int(duration.today?.amount),
    },
    total: {
      durationMin: int(duration.total?.duration),
      durationSec: int(duration.total?.durationInSec),
    },
    durationAsOf,
    durationStale: Boolean(today && durationAsOf && durationAsOf !== today),
    checkIn: {
      lastDate: compactDate(pref.checkIn_date),
      week: (Array.isArray(week) ? week : []).map((w) => ({
        date: String(w.date || ''),
        signIn: w.sign_in === 1,
        studied: w.study === 1,
      })),
    },
  }
  if (book.name) out.book = { name: book.name, code: book.code ?? null, wordCount: int(book.count) }
  if (plan.wordCount) out.dailyPlan = { wordCount: int(plan.wordCount), phraseCount: int(plan.phraseCount) }
  return out
}

// ---------------------------------------------------------------------------
// 服务端（learnywhere.cn）
// ---------------------------------------------------------------------------

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 从 WebView 缓存/本地存储里找 sid（原样是「已百分号编码」形态，别动它） */
export function findSids(webviewRoot) {
  const found = new Set()
  for (const f of walk(webviewRoot, [])) {
    let buf
    try { buf = fs.readFileSync(f) } catch { continue }
    const text = buf.toString('latin1')
    for (const re of [
      /bb-user-category\?sid=([^&\s"']+)/g,
      /paytype_([A-Za-z0-9%+/=_.-]{80,})/g,
      /[?&]sid=([A-Za-z0-9%+/=_.-]{80,})/g,
    ]) {
      for (const m of text.matchAll(re)) found.add(m[1])
    }
  }
  return [...found]
}

/** 同一串 sid 的几种编码形态，逐个拿去验明正身 */
export function sidVariants(raw) {
  const list = [raw]
  try { list.push(encodeURIComponent(raw)) } catch { /* 忽略 */ }
  try { list.push(encodeURIComponent(decodeURIComponent(raw))) } catch { /* 忽略 */ }
  try { list.push(decodeURIComponent(raw)) } catch { /* 忽略 */ }
  return [...new Set(list)]
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: `${HOST}/` } })
  const text = await res.text()
  if (text.trimStart().startsWith('<')) throw new Error(`HTTP ${res.status} 返回的是 HTML`)
  return JSON.parse(text)
}

/** 挑出服务端认的那一版 sid：认的表现是昵称不是「游客」 */
export async function pickSid(sids) {
  for (const raw of sids) {
    for (const v of sidVariants(raw)) {
      try {
        const j = await getJson(`${HOST}/api/user/by-sid?sid=${v}`)
        const nickname = j?.data_body?.nickname
        if (nickname && nickname !== '游客') return { sid: v, nickname }
      } catch { /* 这一版不行就试下一版 */ }
    }
  }
  return null
}

/** `2024-08` + `2026-10` → 中间的每一个月 */
export function enumerateMonths(from, to, cap = MAX_MONTHS) {
  const out = []
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''))
    return m ? { y: Number(m[1]), m: Number(m[2]) } : null
  }
  let a = parse(from)
  const b = parse(to)
  if (!a || !b) return out
  while (out.length < cap) {
    out.push(`${a.y}-${String(a.m).padStart(2, '0')}`)
    if (a.y === b.y && a.m === b.m) break
    a = a.m === 12 ? { y: a.y + 1, m: 1 } : { y: a.y, m: a.m + 1 }
  }
  return out
}

/** 按月表求和：这是「累计学习 N 词」的唯一来源（接口本身不返回总数） */
export function sumByMonth(learnList) {
  const list = Array.isArray(learnList) ? learnList : []
  return {
    totalWords: list.reduce((a, x) => a + int(x.learnNum), 0),
    totalReviews: list.reduce((a, x) => a + int(x.reviewNum), 0),
    months: list.length,
  }
}

export function sumDurationByMonth(durationList) {
  const list = Array.isArray(durationList) ? durationList : []
  return list.reduce((a, x) => a + int(x.duration), 0)
}

async function fetchCloud(sid) {
  const out = { ok: true }
  try {
    const p = await getJson(`${HOST}/api/bb/dashboard/profile/search?sid=${sid}`)
    const d = p.data_body || {}
    out.today = (d.learnList || []).find((x) => x.date === '今日') || null
    out.recent = (d.learnList || []).filter((x) => x.date !== '今日')
    out.totalDurationMin = d.total_duration_num ?? null
    out.recentDuration = d.durationList || []
  } catch (e) {
    out.ok = false
    out.error = `profile/search: ${e.message}`
  }

  try {
    const m = await getJson(`${HOST}/api/bb/dashboard/profile/search?sid=${sid}&type=learnByMonth`)
    Object.assign(out, sumByMonth(m.data_body?.learnList))
  } catch { /* 拿不到就不填，面板会显示「—」 */ }

  try {
    const dm = await getJson(`${HOST}/api/bb/dashboard/profile/search?sid=${sid}&type=durationByMonth`)
    out.totalDurationByMonth = sumDurationByMonth(dm.data_body?.durationList)
  } catch { /* 同上 */ }

  // 整年打卡日历：先问当前月，拿到 minMonth/maxMonth 的范围再把每个月都拉一遍。
  // 一个月一次请求，27 个月并行约 1~2 秒；靠 CACHE_TTL 兜住，不会频繁重打。
  try {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const c = await getJson(`${HOST}/api/bb/dashboard/calendar/search?sid=${sid}&month=${ym}&calendarOnly=1`)
    const b = c.data_body || {}
    const byMonth = {}
    if (Array.isArray(b.list)) byMonth[b.currentMonth || ym] = b.list
    const months = enumerateMonths(b.minMonth, b.maxMonth)
    const rest = months.filter((m) => m !== (b.currentMonth || ym))
    const fetched = await Promise.all(rest.map(async (m) => {
      try {
        const j = await getJson(`${HOST}/api/bb/dashboard/calendar/search?sid=${sid}&month=${m}&calendarOnly=1`)
        return [m, j.data_body?.list || []]
      } catch { return [m, null] }
    }))
    for (const [m, list] of fetched) if (list) byMonth[m] = list
    out.calendar = {
      month: b.currentMonth || ym,
      minMonth: b.minMonth ?? null,
      maxMonth: b.maxMonth ?? null,
      byMonth,
    }
  } catch { /* 日历拿不到不影响其余字段 */ }

  return out
}

// ---------------------------------------------------------------------------
// 给面板 / 模型看的紧凑视图
// ---------------------------------------------------------------------------

/**
 * 把按月的日历表摊平成「已打卡日期」列表（升序）。
 * 面板要的只是「哪天打了卡」，不需要整份月表——这样一次快照只有几 KB，
 * 可以每 20 秒随便轮询，日历的排布（周一起始、跨月补齐）留在客户端做。
 */
export function signedDates(byMonth) {
  const set = new Set()
  for (const list of Object.values(byMonth || {})) {
    for (const x of list || []) if (x && x.date && x.signin === 1) set.add(x.date)
  }
  return [...set].sort()
}

/**
 * 采集结果 → 面板消费的紧凑形状。缓存与快照都存这一份，形状只有一个。
 * 顺带把 sid 摘要、临时目录这些不该外传的东西挡在外面。
 */
/** 云端 dashboard 的 durationList 用字面量「今日」当当天那一行的 date（不是日期串）。 */
const CLOUD_TODAY_LABEL = '今日'

function dayDurationMin(list) {
  const hit = (Array.isArray(list) ? list : []).find((x) => String(x.date ?? '') === CLOUD_TODAY_LABEL)
  // 没有这一行返回 null，和「有这一行但是 0 分钟」区分开
  return hit ? int(hit.duration) : null
}

/**
 * 本地与云端两个「只增不减」的累计量里取较新的那一个。
 *
 * 必须取新而不是「有本地就用本地」：本地 prefs 躺在虚拟磁盘镜像里，Androws 是惰性刷盘的，
 * 实测能滞后好几天 —— 10-20 那次采集到的本地还是 10-14 的快照（今日 20 / 累计 2018），
 * 同一时刻云端已经记到今日 82 / 累计 2131。面板只读本地那两个字段，数就成了错的。
 *
 * 分和秒必须同源：index.js 会把「X 分钟（Y 秒）」拼进 system prompt，
 * 一个取新一个留旧快照就自相矛盾。取到云端值时按整分钟换算（云端本来也只给分钟）。
 */
function fresherDuration(local, cloudMin) {
  const localMin = int(local?.durationMin)
  const cMin = int(cloudMin)
  if (cMin > localMin) return { durationMin: cMin, durationSec: cMin * 60 }
  return { durationMin: localMin, durationSec: int(local?.durationSec) }
}

/**
 * 今日时长不能像累计那样「取大」—— 它每天归零，取大等于把昨天那份当成今天的
 * （实测过零点时本地和云端都还挂着前一天的 82 分钟）。
 * 服务端是实时的，App 自己那套「今天」也按服务端的日界算，所以有云端那一行就用它；
 * 拿不到（sid 失效、或接口换了形状没有「今日」行）才退回本地那份，
 * 这份可能是昨天的，由 durationMightBeStale 去说明。
 */
function todayDuration(local, cloud) {
  const cMin = cloud && cloud.ok !== false ? dayDurationMin(cloud.recentDuration) : null
  if (cMin !== null) return { durationMin: cMin, durationSec: cMin * 60 }
  return { durationMin: int(local?.durationMin), durationSec: int(local?.durationSec) }
}

export function bbdcView(data) {
  if (!data) return null
  const cloud = data.cloud || null
  // 原始采集结果把日历挂在 cloud.calendar 下；缓存里已经是摊平过的紧凑形状。
  // 两种形状都吃，bbdcView 才能对自己的输出幂等（缓存读回来再 view 一次不会丢日历）。
  const raw = cloud?.calendar || data.calendar || null
  const calendar = raw ? {
    month: raw.month || null,
    minMonth: raw.minMonth || null,
    maxMonth: raw.maxMonth || null,
    signedDates: Array.isArray(raw.signedDates) ? [...raw.signedDates] : signedDates(raw.byMonth),
  } : null
  // 本地 prefs 的 today.amount 常年是 0（App 不在本地记「今日词数」，只记时长），
  // 真正的当日学/复习词数在云端 dashboard 的 today 条目里（learnNum/reviewNum）。
  // 这里把两者合并进 today.words，并对自己的输出幂等（缓存读回再 view 不丢）。
  const localToday = data.today || null
  const cloudToday = cloud?.today || null
  const cloudWordSum = cloudToday ? int(cloudToday.learnNum) + int(cloudToday.reviewNum) : 0
  const todayMerged = todayDuration(localToday, cloud)
  const totalMerged = fresherDuration(data.total, cloud?.totalDurationMin)
  const today = (localToday || cloudToday)
    ? {
        ...(localToday || { durationMin: 0, durationSec: 0, words: 0 }),
        ...todayMerged,
        words: Math.max(int(localToday?.words), cloudWordSum),
        learnNum: int(cloudToday?.learnNum),
        reviewNum: int(cloudToday?.reviewNum),
      }
    : null
  return {
    ok: !!data.ok,
    error: data.error || null,
    fetchedAt: data.fetchedAt || 0,
    source: data.source || [],
    user: data.user || null,
    today,
    total: (data.total || cloud?.totalDurationMin) ? { ...(data.total || {}), ...totalMerged } : null,
    // 本地那份的日子与陈旧标记：云端没连上时，面板靠它把「这个数可能是旧的」写在脸上
    durationAsOf: data.durationAsOf ?? null,
    durationStale: !!data.durationStale,
    // 面板和 system prompt 都只看这一个标记：本地落后、而且这次云端没兜住，才该提示。
    // 规则只写在这一处 —— 客户端是独立 bundle（只能 require react），没法 import 这个模块，
    // 两边各写一遍迟早对不上。
    durationMightBeStale: Boolean(data.durationStale && !(cloud && cloud.ok !== false)),
    checkIn: data.checkIn || null,
    book: data.book || null,
    dailyPlan: data.dailyPlan || null,
    cloud: cloud ? {
      ok: cloud.ok !== false,
      error: cloud.error || null,
      totalWords: cloud.totalWords ?? null,
      totalReviews: cloud.totalReviews ?? null,
      months: cloud.months ?? null,
      today: cloud.today || null,
      totalDurationMin: cloud.totalDurationMin ?? null,
      totalDurationByMonth: cloud.totalDurationByMonth ?? null,
      recent: cloud.recent || [],
      recentDuration: cloud.recentDuration || [],
    } : null,
    calendar,
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

export function bbdcFile() {
  return path.join(deskDir(), 'bbdc.json')
}

export function readCache() {
  try { return JSON.parse(fs.readFileSync(bbdcFile(), 'utf8')) } catch { return null }
}

function writeCache(data) {
  const file = bbdcFile()
  try {
    fs.mkdirSync(deskDir(), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file) // 原子替换：读的时候永远看不到半个文件
  } catch { /* 缓存写不进去不影响本次返回 */ }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

let inFlight = null

/**
 * 读一次不背单词打卡数据。
 * @param {{force?: boolean, offline?: boolean, vhd?: string, sevenzip?: string, keep?: boolean}} opts
 */
export async function readBbdc(opts = {}) {
  const { force = false, offline = false, vhd, sevenzip, keep = false } = opts

  if (!force && !vhd && !sevenzip) {
    const cached = readCache()
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return { ...cached, cached: true }
    }
  }
  // 面板可能被连点几下刷新：同一次采集只跑一个，后面的等前面那个结果
  if (inFlight) return inFlight
  inFlight = collect({ offline, vhd, sevenzip, keep }).finally(() => { inFlight = null })
  return inFlight
}

async function collect({ offline, vhd, sevenzip, keep }) {
  const result = {
    fetchedAt: Date.now(),
    source: [],
    ok: false,
    error: null,
  }

  const sz = findSevenZip(sevenzip)
  const disk = findVhd(vhd)
  if (!sz) result.error = '找不到 7z.exe（Androws 自带或系统安装）'
  else if (!disk) result.error = '找不到 data.vhd（Androws 未安装？）'
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bbdc-'))
    try {
      const copy = path.join(tmp, 'data.vhd')
      // 共享读：Androws 正独占这个文件，但 copyFileSync 仍然能拷下来
      fs.copyFileSync(disk, copy)
      const out = path.join(tmp, 'out')
      // VHD 被运行中的 Androws 独占时，7z 读 ext3 超级块会报 Headers Error、退出码 2，
      // 但目标文件其实已完整抽出——非零退出不算失败，以产物目录为准，抽不到才抛。
      const prefsDir = path.join(out, 'data', PKG, 'shared_prefs')
      try {
        execFileSync(sz, ['x', copy,
          `data/${PKG}/shared_prefs/*`,
          `data/${PKG}/cache/WebView/*`,
          `-o${out}`, '-y'], { stdio: 'pipe' })
      } catch (e) {
        if (!fs.existsSync(prefsDir)) throw e
      }

      // ---- A. 本地 ----
      if (fs.existsSync(prefsDir)) {
        const name = fs.readdirSync(prefsDir).find((x) => /^User_Preference_\d+\.xml$/.test(x))
        if (name) {
          const pref = xmlToMap(fs.readFileSync(path.join(prefsDir, name), 'utf8'))
          // 用本地日期判断陈旧（dayKey 走本地时区；toISOString 会在 UTC+8 的早上把日期认错天）
          const local = parseUserPrefs(pref, dayKey(Date.now()))
          if (!local.user.uid) local.user.uid = Number(name.match(/(\d+)\.xml$/)[1])
          Object.assign(result, local)
          result.source.push('app-local')
          result.ok = true
        }
      }
      if (!result.ok && !result.error) result.error = 'VHD 里没找到 App 的 SharedPreferences（不背单词没在这台机器上登录过？）'

      // ---- B. 服务端 ----
      if (!offline) {
        const webview = path.join(out, 'data', PKG, 'cache', 'WebView')
        const sids = fs.existsSync(webview) ? findSids(webview) : []
        const picked = sids.length ? await pickSid(sids) : null
        if (picked) {
          result.source.push('learnywhere-api')
          result.cloud = await fetchCloud(picked.sid)
          if (!result.user) result.user = { uid: 0, nickname: picked.nickname, continuousDays: 0, totalDays: 0 }
          else if (!result.user.nickname) result.user.nickname = picked.nickname
          result.sidHint = `${picked.sid.slice(0, 8)}…（已隐藏）`
        } else {
          result.cloud = {
            ok: false,
            error: sids.length
              ? 'sid 已失效（重新登录不背单词、打开一次统计页后再刷新）'
              : 'VHD 里没找到 sid（在不背单词里打开过统计/打卡页再刷新）',
          }
        }
      }
    } catch (e) {
      result.error = result.error || `读取失败：${e && e.message ? e.message : String(e)}`
    } finally {
      if (!keep) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ } }
      else result.tmpDir = tmp
    }
  }

  writeCache(bbdcView(result))
  return { ...bbdcView(result), cached: false }
}

export default { readBbdc, readCache, bbdcFile, bbdcView, parseUserPrefs, signedDates, enumerateMonths, sumByMonth, sumDurationByMonth, findSids, sidVariants, pickSid, xmlToMap, compactDate, findSevenZip, findVhd, androwsRoot }
