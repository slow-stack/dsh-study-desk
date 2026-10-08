/**
 * dsh-study-desk —— 考研工作台（Client 半边）
 *
 * 以 dsh.client bundle 格式加载（跟 dsh-sticker / dsh-meme 同一套 ModuleLoader 机制，
 * 不需要打包器）。注册 id 必须等于 loader entry 名（dsh-study-desk），否则 ModuleLoader
 * 报 "loaded without registering dsh-study-desk"。
 *
 * 视觉约定：一个硬编码颜色都没有——整条 --dsw-alias-* / --dsw-static-* 阶梯都只被消费，
 * 不被覆写。当前主题（catppuccin-mocha + mica 玻璃）换掉，这里所有颜色自动跟着变，
 * 所以看板是「融进主题」而不是「自带一套皮肤」。
 *
 * 挂载点：
 *   sidebar.panellist  → 左侧栏图标（id 与 main 的 key 同名，侧栏自动 dispatch）
 *   main (keyed)       → 整页工作台
 *   shell.overlay      → 右下角常驻迷你计时条（跨面板存活）
 *   settings.section   → 「考研工作台」设置页
 */

window.__ModuleLoader__.load({
  id: 'dsh-study-desk',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // -----------------------------------------------------------------------
    // 常量与工具
    // -----------------------------------------------------------------------

    const API = '/api/dsh-study-desk'
    const PANEL_ID = 'study-desk'
    const MINI_POS_KEY = 'dsh-study-desk:mini-pos'

    const EXAM = { name: '2027 届考研初试', start: '2026-12-19', end: '2026-12-20', note: '631 公共管理 + 864' }
    const MILESTONES = [
      { id: 'pre-reg', label: '预报名', start: '2026-10-09', end: '2026-10-12' },
      { id: 'reg', label: '正式报名', start: '2026-10-15', end: '2026-10-24' },
      { id: 'confirm', label: '网上确认', start: '2026-11-01', end: '2026-11-05', approx: true },
      { id: 'ticket', label: '打印准考证', start: '2026-12-10', end: '2026-12-19', approx: true },
    ]

    const STATUS_META = [
      { id: 'todo', label: '待办', latin: 'TODO' },
      { id: 'doing', label: '进行中', latin: 'DOING' },
      { id: 'done', label: '已完成', latin: 'DONE' },
    ]

    const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

    function startOfDay(ts) {
      const d = new Date(ts)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

    function addDays(ts, n) {
      const d = new Date(ts)
      d.setDate(d.getDate() + n)
      return d.getTime()
    }

    function dayKey(ts) {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    function parseDayKey(key) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
      if (!m) return NaN
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    }

    function daysUntil(key, now) {
      const t = parseDayKey(key)
      if (!Number.isFinite(t)) return null
      return Math.round((t - startOfDay(now === undefined ? Date.now() : now)) / 86400000)
    }

    function fmtMinutes(min) {
      const n = Math.max(0, Math.round(Number(min) || 0))
      if (n < 60) return n + ' 分钟'
      const hh = Math.floor(n / 60)
      const mm = n % 60
      return mm ? `${hh} 小时 ${mm} 分` : `${hh} 小时`
    }

    function fmtShort(min) {
      const n = Math.max(0, Math.round(Number(min) || 0))
      if (n < 60) return n + 'm'
      const hh = Math.floor(n / 60)
      const mm = n % 60
      return mm ? `${hh}h${mm}` : `${hh}h`
    }

    function fmtClock(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }

    // -----------------------------------------------------------------------
    // 全局 store：宿主是唯一真相源，这里只缓存最近一次快照
    // -----------------------------------------------------------------------

    const store = {
      ready: false,
      error: null,
      state: { tasks: [], sessions: [], timer: null, settings: {} },
      minutes: {},
      todayMinutes: 0,
      streak: 0,
      focusRoundsToday: 0,
      exam: EXAM,
      milestones: MILESTONES,
      deskFile: '',
      version: '',
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (error) { console.warn('[dsh-study-desk] 渲染回调报错:', error) }
        }
      },
      absorb(json) {
        if (!json || json.ok === false) {
          this.error = (json && json.error) || '接口返回异常'
          this.emit()
          return
        }
        this.error = null
        this.state = json.state || this.state
        this.minutes = json.minutes || {}
        this.todayMinutes = json.todayMinutes || 0
        this.streak = json.streak || 0
        this.focusRoundsToday = json.focusRoundsToday || 0
        this.exam = json.exam || EXAM
        this.milestones = json.milestones || MILESTONES
        this.deskFile = json.deskFile || ''
        this.version = json.version || ''
        this.ready = true
        this.emit()
      },
      async refresh() {
        try {
          const res = await fetch(API + '?op=state', { cache: 'no-store' })
          this.absorb(await res.json())
        } catch (error) {
          this.error = error && error.message ? error.message : String(error)
          this.emit()
        }
      },
      async apply(op, payload) {
        try {
          const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, ...(payload || {}) }),
          })
          const json = await res.json()
          if (json && json.ok === false) console.warn('[dsh-study-desk]', op, json.error)
          this.absorb(json)
          return json
        } catch (error) {
          this.error = error && error.message ? error.message : String(error)
          this.emit()
          return null
        }
      },
    }

    // -----------------------------------------------------------------------
    // 诊断回传：浏览器里没有能读的控制台，就把异常发回宿主写进磁盘
    // 宿主 /api/dsh-study-desk 的 diag.report 会追加到 <DSH_HOME>/study-desk/client-diag.json
    // -----------------------------------------------------------------------

    const diagSeen = new Set()
    let diagSeq = 0

    function reportDiag(entry) {
      try {
        const key = `${entry.kind || ''}|${entry.where || ''}|${entry.message || ''}`
        if (diagSeen.has(key)) return
        diagSeen.add(key)
        diagSeq += 1
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'diag.report', seq: diagSeq, at: Date.now(), ...entry }),
        }).catch(() => { /* 诊断通道坏了不能影响主流程 */ })
      } catch (error) { /* 同上 */ }
    }

    function getLayout() {
      if (!clientCtx) return null
      try {
        if (typeof clientCtx.get === 'function') {
          const viaGet = clientCtx.get('layout')
          if (viaGet) return viaGet
        }
      } catch (error) { /* 退到属性访问 */ }
      return clientCtx.layout || null
    }

    // 渲染炸了要看得见，不能只是白屏
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        reportDiag({
          kind: 'render-error',
          where: this.props.where || '未知',
          message: String((error && error.message) || error),
          stack: String((error && error.stack) || '').split('\n').slice(0, 12).join('\n'),
          componentStack: String((info && info.componentStack) || '').split('\n').slice(0, 12).join('\n'),
        })
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'sd-error' }, [
            h('div', { key: 't' }, `工作台渲染出错（${this.props.where || '未知位置'}）——细节已写进 client-diag.json`),
            h('pre', { key: 's', className: 'sd-error-stack' },
              String((this.state.error && this.state.error.stack) || this.state.error)),
          ])
        }
        return this.props.children
      }
    }

    function tasksIn(status) {
      return store.state.tasks
        .filter((t) => t.status === status)
        .sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt))
    }

    // -----------------------------------------------------------------------
    // 番茄钟：本地只负责「按 endsAt 画倒计时」，归零结账交给宿主
    // -----------------------------------------------------------------------

    let audioCtx = null

    function beep(kind) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return
        if (!audioCtx) audioCtx = new Ctor()
        const t = audioCtx.currentTime
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'sine'
        osc.frequency.value = kind === 'break' ? 587 : 880
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.start(t)
        osc.stop(t + 0.55)
      } catch { /* 用户没交互过 / 不支持音频就静默跳过 */ }
    }

    function timerRemaining(timer, now) {
      if (!timer) return 0
      if (timer.running) return Math.max(0, timer.endsAt - now)
      return Math.max(0, Number(timer.remainingMs) || 0)
    }

    let watchTimer = 0
    let lastPhase = ''
    let reconciling = false

    function startWatcher() {
      if (watchTimer) return
      watchTimer = setInterval(async () => {
        const timer = store.state.timer
        if (timer && timer.running && timer.endsAt <= Date.now() && !reconciling) {
          reconciling = true
          const wasFocus = timer.kind === 'focus'
          try {
            // 宿主在这次读取时会顺手结账（记 session + 摆下一段），不用客户端自己算
            await store.refresh()
            beep(wasFocus ? 'focusDone' : 'breakDone')
          } finally {
            reconciling = false
          }
        }
        if (timer) {
          const phase = `${timer.kind}:${timer.endsAt}`
          lastPhase = phase
        }
      }, 1000)
    }

    function useTick(ms) {
      const [now, force] = React.useState(() => Date.now())
      React.useEffect(() => {
        const id = setInterval(() => force(Date.now()), ms)
        return () => clearInterval(id)
      }, [ms])
      return now
    }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store
    }

    function usePoll(ms) {
      React.useEffect(() => {
        store.refresh()
        const id = setInterval(() => {
          if (document.visibilityState === 'visible') store.refresh()
        }, ms)
        return () => clearInterval(id)
      }, [ms])
    }

    // -----------------------------------------------------------------------
    // 共享小组件
    // -----------------------------------------------------------------------

    function Icon({ name, size }) {
      const s = size || 16
      const common = {
        width: s, height: s, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      const paths = {
        board: ['M3 4.5h14v11H3z', 'M3 8.5h14', 'M7.5 8.5v7'],
        clock: ['M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M10 6.5v4l2.5 1.5'],
        play: ['M6.5 4.8v10.4l8-5.2z'],
        pause: ['M7 4.8v10.4', 'M13 4.8v10.4'],
        stop: ['M6 6h8v8H6z'],
        plus: ['M10 4.5v11', 'M4.5 10h11'],
        left: ['M12 5.5 7.5 10l4.5 4.5'],
        right: ['M8 5.5 12.5 10 8 14.5'],
        check: ['M4.5 10.5l3.5 3.5 7.5-8'],
        cross: ['M6 6l8 8', 'M14 6l-8 8'],
        flame: ['M10 2.5c3 3.2 4.5 5.6 4.5 8a4.5 4.5 0 0 1-9 0c0-1.6.7-3 1.8-4.3', 'M10 16.5a2.4 2.4 0 0 1-1-4.5'],
        expand: ['M4 8V4h4', 'M16 12v4h-4', 'M4 12v4h4', 'M16 8V4h-4'],
        collapse: ['M8 4v4H4', 'M12 16v-4h4', 'M12 4v4h4', 'M8 16v-4H4'],
      }
      const p = paths[name] || paths.board
      return h('svg', common, p.map((d, i) => h('path', { key: i, d })))
    }

    function Progress({ value, max, tone }) {
      const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
      return h('div', { className: 'sd-bar' + (tone ? ' sd-bar-' + tone : '') },
        h('div', { className: 'sd-bar-fill', style: { width: pct + '%' } }))
    }

    // -----------------------------------------------------------------------
    // 顶部：标题 / 倒计时 / 节点 / 今日进度
    // -----------------------------------------------------------------------

    function milestoneChips(now) {
      const out = []
      for (const m of MILESTONES) {
        const toStart = daysUntil(m.start, now)
        const toEnd = daysUntil(m.end, now)
        if (toStart === null || toEnd === null) continue
        if (toEnd < -3) continue
        if (toStart > 45) continue
        let tone = 'future'
        let text = `${toStart} 天后`
        if (toStart === 0) { tone = 'now'; text = toEnd === 0 ? '就是今天' : `进行中 · 今天最后一天` }
        else if (toStart < 0 && toEnd >= 0) { tone = 'now'; text = `进行中 · 还剩 ${toEnd + 1} 天` }
        else if (toEnd < 0) { tone = 'past'; text = '已结束' }
        else if (toStart === 1) { text = '明天开始' }
        out.push({ ...m, tone, text, toStart, toEnd })
      }
      return out
    }

    function Head({ now }) {
      const s = useStore()
      const toExam = daysUntil(s.exam.start, now)
      const goal = Number(s.state.settings.dailyGoalMin) || 180
      const pct = goal > 0 ? Math.round((s.todayMinutes / goal) * 100) : 0
      const chips = milestoneChips(now)
      return h('header', { className: 'sd-head' }, [
        h('div', { className: 'sd-head-row', key: 'title' }, [
          h('div', { className: 'sd-head-main', key: 'l' }, [
            h('h1', { className: 'sd-title', key: 't' }, '考研工作台'),
            h('div', { className: 'sd-subtitle', key: 's' },
              `${s.exam.note || ''}${s.exam.note ? ' · ' : ''}初试 ${s.exam.start}${s.exam.end && s.exam.end !== s.exam.start ? ' ~ ' + s.exam.end : ''}`),
          ]),
          h('div', { className: 'sd-count', key: 'r' }, [
            h('span', { className: 'sd-count-num', key: 'n' }, toExam === null ? '—' : String(Math.max(0, toExam))),
            h('span', { className: 'sd-count-cap', key: 'c' }, '天'),
            h('span', { className: 'sd-count-label', key: 'l' }, toExam !== null && toExam >= 0 ? '距初试' : '初试已过'),
          ]),
        ]),
        chips.length
          ? h('div', { className: 'sd-chips', key: 'chips' }, chips.map((c) =>
            h('span', { className: 'sd-chip sd-chip-' + c.tone, key: c.id, title: `${c.label} ${c.start}${c.end !== c.start ? ' ~ ' + c.end : ''}` }, [
              h('b', { key: 'a' }, c.label),
              h('span', { key: 'b' }, c.text),
              c.approx ? h('i', { key: 'c', className: 'sd-chip-approx', title: '日期为往年惯例，以官方公告为准' }, '约') : null,
            ])))
          : null,
        h('div', { className: 'sd-head-row sd-head-row-end', key: 'today' }, [
          h('div', { className: 'sd-today', key: 't' }, [
            h('span', { className: 'sd-today-cap', key: 'c' }, '今日专注'),
            h('span', { className: 'sd-today-num', key: 'n' }, fmtMinutes(s.todayMinutes)),
            h('span', { className: 'sd-today-goal', key: 'g' }, `/ ${fmtMinutes(goal)} · ${pct}%`),
            h('div', { className: 'sd-today-bar', key: 'b' }, h(Progress, { value: s.todayMinutes, max: goal })),
          ]),
          h('div', { className: 'sd-today sd-today-streak', key: 's' }, [
            h('span', { className: 'sd-today-cap', key: 'c' }, '连续打卡'),
            h('span', { className: 'sd-today-num', key: 'n' }, String(s.streak)),
            h('span', { className: 'sd-today-goal', key: 'g' }, '天'),
          ]),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // 番茄钟面板
    // -----------------------------------------------------------------------

    function TimerPanel({ now }) {
      const s = useStore()
      useTick(500)
      const timer = s.state.timer
      const settings = s.state.settings || {}
      const remaining = timerRemaining(timer, now)
      const total = timer ? timer.minutes * 60000 : (Number(settings.focusMin) || 25) * 60000
      const isFocus = !timer || timer.kind === 'focus'
      const presets = [25, 45, 60]
      const candidates = store.state.tasks.filter((t) => t.status !== 'done')
      const [picked, setPicked] = React.useState('')

      const start = (minutes) => store.apply('timer.start', {
        minutes,
        kind: 'focus',
        taskId: picked || undefined,
      })

      return h('section', { className: 'sd-timer-card' }, [
        h('div', { className: 'sd-timer-row', key: 'r' }, [
          h('button', {
            key: 'play',
            className: 'sd-iconbtn sd-iconbtn-lg',
            title: !timer ? '开始专注' : timer.running ? '暂停' : '继续',
            onClick: () => {
              if (!timer) start(settings.focusMin || 25)
              else if (timer.running) store.apply('timer.pause')
              else store.apply('timer.resume')
            },
          }, h(Icon, { name: !timer ? 'play' : timer.running ? 'pause' : 'play', size: 18 })),
          h('div', { className: 'sd-timer-main', key: 'm' }, [
            h('div', { className: 'sd-timer-clock', key: 'c' }, fmtClock(remaining)),
            h('div', { className: 'sd-timer-meta', key: 'k' }, [
              h('span', { className: 'sd-phase' + (isFocus ? ' sd-phase-focus' : ' sd-phase-break'), key: 'p' },
                !timer ? '未开始' : isFocus ? `专注 · 第 ${timer.round} 轮` : '休息'),
              timer && timer.title ? h('span', { className: 'sd-dot', key: 'd' }) : null,
              timer && timer.title ? h('span', { className: 'sd-timer-task', key: 't', title: timer.title }, timer.title) : null,
              !timer && s.focusRoundsToday ? h('span', { className: 'sd-timer-sub', key: 's' }, `今天已完成 ${s.focusRoundsToday} 轮`) : null,
            ]),
            h('div', { className: 'sd-timer-bar', key: 'b' },
              h(Progress, { value: total - remaining, max: total, tone: isFocus ? 'brand' : 'muted' })),
          ]),
          h('div', { className: 'sd-timer-side', key: 's' }, [
            timer ? h('button', {
              className: 'sd-iconbtn', title: '结束这一段', onClick: () => store.apply('timer.reset'),
            }, h(Icon, { name: 'stop' })) : null,
            timer && isFocus && !timer.running ? h('button', {
              className: 'sd-textbtn', title: '跳过这一段', onClick: () => store.apply('timer.reset'),
            }, '放弃') : null,
          ]),
        ]),
        h('div', { className: 'sd-timer-foot', key: 'f' }, [
          !timer
            ? h('div', { className: 'sd-row', key: 'p' }, [
              h('span', { className: 'sd-mini-cap', key: 'c' }, '时长'),
              ...presets.map((m) => h('button', {
                key: m, className: 'sd-pill' + ((settings.focusMin || 25) === m ? ' on' : ''),
                onClick: () => store.apply('settings.update', { patch: { focusMin: m } }).then(() => start(m)),
              }, `${m} 分钟`)),
            ])
            : h('div', { className: 'sd-row', key: 'p' }, [
              h('span', { className: 'sd-mini-cap', key: 'c' }, '这一轮第 ' + (timer.round || 1)),
            ]),
          h('div', { className: 'sd-row sd-row-end', key: 'a' }, [
            h('span', { className: 'sd-mini-cap', key: 'c' }, '挂到'),
            h('select', {
              className: 'sd-select',
              value: timer && timer.taskId ? timer.taskId : picked,
              disabled: !!timer,
              onChange: (e) => setPicked(e.target.value),
            }, [
              h('option', { key: '', value: '' }, '不指定'),
              ...candidates.map((t) => h('option', { key: t.id, value: t.id }, t.title)),
            ]),
          ]),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // 热力图
    // -----------------------------------------------------------------------

    function Heatmap({ now }) {
      const s = useStore()
      const settings = s.state.settings || {}
      const weeksCount = Number(settings.heatmapWeeks) || 26
      const [range, setRange] = React.useState(weeksCount)

      const byDay = React.useMemo(() => {
        const map = new Map()
        const count = new Map()
        for (const x of s.state.sessions) {
          if (x.kind !== 'focus') continue
          const k = dayKey(x.at)
          map.set(k, (map.get(k) || 0) + x.minutes)
          count.set(k, (count.get(k) || 0) + 1)
        }
        return { map, count }
      }, [s.state.sessions])

      const goal = Number(settings.dailyGoalMin) || 180

      const grid = React.useMemo(() => {
        const today = startOfDay(now)
        const weekday = (new Date(today).getDay() + 6) % 7
        const lastMonday = addDays(today, -weekday)
        const cols = []
        for (let w = range - 1; w >= 0; w -= 1) {
          const monday = addDays(lastMonday, -7 * w)
          const days = []
          for (let d = 0; d < 7; d += 1) {
            const ts = addDays(monday, d)
            if (ts > today) { days.push(null); continue }
            const key = dayKey(ts)
            const minutes = byDay.map.get(key) || 0
            let level = 0
            if (minutes > 0) {
              if (minutes < goal * 0.25) level = 1
              else if (minutes < goal * 0.5) level = 2
              else if (minutes < goal) level = 3
              else level = 4
            }
            days.push({ key, ts, minutes, count: byDay.count.get(key) || 0, level })
          }
          cols.push({ monday, days })
        }
        const months = []
        let seen = -1
        cols.forEach((col, i) => {
          const first = col.days.find((d) => d && new Date(d.ts).getDate() === 1)
          if (first) {
            const m = new Date(first.ts).getMonth()
            if (m !== seen) { seen = m; months.push({ i, label: `${m + 1}月` }) }
          }
        })
        let total = 0
        let active = 0
        for (const col of cols) for (const d of col.days) { if (d) { total += d.minutes; if (d.minutes > 0) active += 1 } }
        return { cols, months, total, active }
      }, [range, byDay, goal, now])

      const template = `22px repeat(${grid.cols.length}, 13px)`

      return h('section', { className: 'sd-card-block' }, [
        h('div', { className: 'sd-block-head', key: 'h' }, [
          h('h2', { className: 'sd-block-title', key: 't' }, '学习热力图'),
          h('span', { className: 'sd-block-sub', key: 's' },
            `近 ${range} 周 · 共 ${fmtMinutes(grid.total)} · 学习 ${grid.active} 天`),
          h('div', { className: 'sd-row sd-row-end', key: 'r' },
            [13, 26, 53].map((w) => h('button', {
              key: w, className: 'sd-pill sm' + (range === w ? ' on' : ''),
              onClick: () => { setRange(w); store.apply('settings.update', { patch: { heatmapWeeks: w } }) },
            }, `${w} 周`))),
        ]),
        h('div', { className: 'sd-heat-scroll', key: 'g' },
          h('div', { className: 'sd-heat', style: { gridTemplateColumns: template } }, [
            h('div', { className: 'sd-heat-corner', key: 'corner', style: { gridColumn: 1, gridRow: 1 } }),
            ...grid.months.map((m, idx) => h('div', {
              key: 'm' + idx,
              className: 'sd-heat-month',
              style: { gridColumn: m.i + 2, gridRow: 1, gridColumnEnd: `span ${Math.min(4, grid.cols.length - m.i)}` },
            }, m.label)),
            ...WEEKDAYS.map((label, di) => (di % 2 === 0
              ? h('div', { key: 'w' + di, className: 'sd-heat-day', style: { gridColumn: 1, gridRow: di + 2 } }, label)
              : null)),
            ...grid.cols.flatMap((col, wi) => col.days.map((d, di) => h('div', {
              key: `${wi}-${di}`,
              className: 'sd-cell' + (d ? ' lv' + d.level + (d.key === dayKey(now) ? ' today' : '') : ' empty'),
              style: { gridColumn: wi + 2, gridRow: di + 2 },
              title: d ? `${d.key} · 专注 ${d.minutes} 分钟${d.count ? ` · ${d.count} 段` : ''}` : '',
            }))),
          ])),
        h('div', { className: 'sd-heat-foot', key: 'f' }, [
          h('span', { className: 'sd-heat-note', key: 'n' },
            `点亮条件：当天实际复习满 1 分钟；越亮 = 越接近每日 ${fmtMinutes(goal)} 的目标`),
          h('span', { className: 'sd-legend', key: 'l' }, [
            h('span', { key: 'a' }, '少'),
            ...[0, 1, 2, 3, 4].map((lv) => h('i', { key: lv, className: 'sd-cell legend lv' + lv })),
            h('span', { key: 'b' }, '多'),
          ]),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // 看板
    // -----------------------------------------------------------------------

    let dragId = null

    function Card({ task, minutes, confirmId, setConfirmId, onMove, onDelete, dragging, setDragging }) {
      const spent = minutes[task.id] || 0
      const confirming = confirmId === task.id
      return h('article', {
        className: 'sd-card' + (task.status === 'done' ? ' done' : '') + (dragging ? ' dragging' : ''),
        draggable: true,
        onDragStart: (e) => {
          dragId = task.id
          setDragging(task.id)
          try { e.dataTransfer.setData('text/plain', task.id) } catch { /* 忽略 */ }
          e.dataTransfer.effectAllowed = 'move'
        },
        onDragEnd: () => { dragId = null; setDragging(null) },
        onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); onMove(task.id, task.status, task.id, true) },
      }, [
        h('div', { className: 'sd-card-top', key: 'top' }, [
          task.pinned ? h('span', { className: 'sd-pin', key: 'p', title: '置顶' }, '★') : null,
          h('div', { className: 'sd-card-title', key: 't' }, task.title),
        ]),
        task.note ? h('div', { className: 'sd-card-note', key: 'note' }, task.note) : null,
        h('div', { className: 'sd-card-foot', key: 'foot' }, [
          task.subject ? h('span', { className: 'sd-tag', key: 's' }, task.subject) : null,
          spent ? h('span', { className: 'sd-spent', key: 'm', title: '累计投入' }, fmtShort(spent)) : null,
          task.estimateMin && !spent ? h('span', { className: 'sd-est', key: 'e', title: '预计' }, '~' + fmtShort(task.estimateMin)) : null,
          h('span', { className: 'sd-card-acts', key: 'a' }, confirming
            ? [
              h('button', { key: 'yes', className: 'sd-act danger', title: '确认删除', onClick: () => { setConfirmId(null); onDelete(task.id) } }, '删除'),
              h('button', { key: 'no', className: 'sd-act', title: '取消', onClick: () => setConfirmId(null) }, '取消'),
            ]
            : [
              task.status !== 'todo' ? h('button', {
                key: 'l', className: 'sd-act', title: '移到左边一列',
                onClick: () => onMove(task.id, task.status === 'done' ? 'doing' : 'todo', null),
              }, h(Icon, { name: 'left', size: 13 })) : null,
              task.status !== 'done' ? h('button', {
                key: 'r', className: 'sd-act', title: task.status === 'todo' ? '开始做' : '标记完成',
                onClick: () => onMove(task.id, task.status === 'todo' ? 'doing' : 'done', null),
              }, task.status === 'todo' ? '开始' : h(Icon, { name: 'check', size: 13 })) : null,
              task.status === 'done' ? h('button', {
                key: 'r2', className: 'sd-act', title: '放回进行中',
                onClick: () => onMove(task.id, 'doing', null),
              }, h(Icon, { name: 'right', size: 13 })) : null,
              h('button', {
                key: 'x', className: 'sd-act', title: '删除这张卡',
                onClick: () => setConfirmId(task.id),
              }, h(Icon, { name: 'cross', size: 13 })),
            ]),
        ]),
      ])
    }

    function Composer({ status, subjects, onAdd }) {
      const [open, setOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      const [subject, setSubject] = React.useState('')
      const ref = React.useRef(null)

      React.useEffect(() => { if (open && ref.current) ref.current.focus() }, [open])

      const commit = () => {
        const title = text.trim()
        if (!title) { setOpen(false); return }
        onAdd({ title, subject, status })
        setText('')
        if (ref.current) ref.current.focus()
      }

      if (!open) {
        return h('button', { className: 'sd-add', onClick: () => setOpen(true) },
          [h(Icon, { name: 'plus', size: 14, key: 'i' }), h('span', { key: 't' }, '新建')])
      }

      return h('div', { className: 'sd-composer' }, [
        h('textarea', {
          key: 'ta',
          ref,
          className: 'sd-composer-input',
          rows: 2,
          value: text,
          placeholder: '要做什么？回车保存，Shift+回车换行',
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
            if (e.key === 'Escape') { setOpen(false); setText('') }
          },
        }),
        h('div', { className: 'sd-composer-foot', key: 'f' }, [
          h('select', {
            key: 's',
            className: 'sd-select sm',
            value: subject,
            onChange: (e) => setSubject(e.target.value),
          }, [h('option', { key: '', value: '' }, '科目…'), ...subjects.map((x) => h('option', { key: x.id, value: x.label }, x.label))]),
          h('div', { className: 'sd-row', key: 'b' }, [
            h('button', { key: 'c', className: 'sd-textbtn', onClick: () => { setOpen(false); setText('') } }, '取消'),
            h('button', { key: 'k', className: 'sd-textbtn primary', onClick: commit }, '保存'),
          ]),
        ]),
      ])
    }

    function Column({ meta, tasks, minutes, subjects, hover, setHover, confirmId, setConfirmId, dragging, setDragging, onMove, onDelete, onAdd }) {
      return h('section', {
        className: 'sd-col' + (hover === meta.id ? ' hover' : ''),
        onDragOver: (e) => { e.preventDefault(); setHover(meta.id) },
        onDragLeave: () => setHover((cur) => (cur === meta.id ? null : cur)),
        onDrop: (e) => {
          e.preventDefault()
          setHover(null)
          if (dragId) onMove(dragId, meta.id, null)
          dragId = null
          setDragging(null)
        },
      }, [
        h('div', { className: 'sd-col-head', key: 'h' }, [
          h('span', { className: 'sd-col-latin', key: 'l' }, meta.latin),
          h('span', { className: 'sd-col-label', key: 'n' }, meta.label),
          h('span', { className: 'sd-col-count', key: 'c' }, String(tasks.length)),
        ]),
        h('div', { className: 'sd-col-body', key: 'b' }, [
          ...tasks.map((t) => h(Card, {
            key: t.id,
            task: t,
            minutes,
            confirmId,
            setConfirmId,
            dragging: dragging === t.id,
            setDragging,
            onMove: (id, status, before, isHover) => {
              if (isHover) return
              onMove(id, status, before)
            },
          })),
          tasks.length ? null : h('div', { className: 'sd-col-empty', key: 'e' }, meta.id === 'done' ? '还没有完成的卡' : '空的'),
          h(Composer, { key: 'composer', status: meta.id, subjects, onAdd }),
        ]),
      ])
    }

    function Board() {
      const s = useStore()
      const [hover, setHover] = React.useState(null)
      const [confirmId, setConfirmId] = React.useState(null)
      const [dragging, setDragging] = React.useState(null)
      const subjects = (s.state.settings && s.state.settings.subjects) || []

      const move = (id, status, beforeId) => store.apply('task.move', { id, status, beforeId: beforeId || undefined })
      const del = (id) => store.apply('task.delete', { id })
      const add = (payload) => store.apply('task.add', payload)

      return h('div', { className: 'sd-board' }, STATUS_META.map((meta) => {
        let tasks = tasksIn(meta.id)
        if (meta.id === 'done') {
          tasks = tasks.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 30)
        }
        return h(Column, {
          key: meta.id,
          meta,
          tasks,
          minutes: s.minutes,
          subjects,
          hover,
          setHover,
          confirmId,
          setConfirmId,
          dragging,
          setDragging,
          onMove: move,
          onDelete: del,
          onAdd: add,
        })
      }))
    }

    // -----------------------------------------------------------------------
    // 统计条
    // -----------------------------------------------------------------------

    function Stats({ now }) {
      const s = useStore()
      const bySubject = React.useMemo(() => {
        const from = addDays(startOfDay(now), -29)
        const map = new Map()
        for (const x of s.state.sessions) {
          if (x.kind !== 'focus' || x.at < from) continue
          const label = x.subject || '未归类'
          map.set(label, (map.get(label) || 0) + x.minutes)
        }
        return [...map.entries()].map(([label, minutes]) => ({ label, minutes })).sort((a, b) => b.minutes - a.minutes)
      }, [s.state.sessions, now])

      const max = bySubject.reduce((m, x) => Math.max(m, x.minutes), 0)
      const totalMonth = bySubject.reduce((m, x) => m + x.minutes, 0)

      return h('section', { className: 'sd-card-block' }, [
        h('div', { className: 'sd-block-head', key: 'h' }, [
          h('h2', { className: 'sd-block-title', key: 't' }, '近 30 天'),
          h('span', { className: 'sd-block-sub', key: 's' }, totalMonth ? `共 ${fmtMinutes(totalMonth)}` : '还没有记录'),
        ]),
        bySubject.length
          ? h('div', { className: 'sd-subj-list', key: 'l' }, bySubject.map((x) => h('div', { className: 'sd-subj', key: x.label }, [
            h('span', { className: 'sd-subj-label', key: 'n' }, x.label),
            h('div', { className: 'sd-subj-bar', key: 'b' },
              h('div', { className: 'sd-bar-fill', style: { width: (max ? (x.minutes / max) * 100 : 0) + '%' } })),
            h('span', { className: 'sd-subj-min', key: 'm' }, fmtMinutes(x.minutes)),
          ])))
          : h('div', { className: 'sd-empty-block', key: 'e' }, '完成一个番茄后，这里会按科目显示投入分布。'),
      ])
    }

    // -----------------------------------------------------------------------
    // 整页面板
    // -----------------------------------------------------------------------

    function Panel() {
      const s = useStore()
      const now = useTick(500)
      usePoll(20000)
      return h('div', { className: 'sd-page' }, [
        h(Head, { key: 'head', now }),
        h(TimerPanel, { key: 'timer', now }),
        s.error ? h('div', { className: 'sd-error', key: 'err' }, '工作台数据读取失败：' + s.error) : null,
        h('div', { className: 'sd-section-title', key: 'st' }, [
          h('span', { key: 'a' }, '待办墙'),
          h('span', { className: 'sd-section-hint', key: 'b' }, '拖动卡片换列 · 或点卡片上的箭头'),
        ]),
        h(Board, { key: 'board' }),
        h('div', { className: 'sd-two', key: 'two' }, [
          h(Heatmap, { key: 'heat', now }),
          h(Stats, { key: 'stats', now }),
        ]),
        h('div', { className: 'sd-foot', key: 'f' },
          `数据：${s.deskFile || '—'}${s.version ? ` · dsh-study-desk v${s.version}` : ''}`),
      ])
    }

    // -----------------------------------------------------------------------
    // 常驻迷你计时条（shell.overlay）
    // -----------------------------------------------------------------------

    // 迷你条的落点：存 localStorage，纯本地偏好，不占 desk.json
    function readMiniPos() {
      try {
        const raw = window.localStorage.getItem(MINI_POS_KEY)
        if (!raw) return null
        const p = JSON.parse(raw)
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y }
      } catch (error) { /* 读不到就当没挪过 */ }
      return null
    }

    function writeMiniPos(p) {
      try {
        if (!p) window.localStorage.removeItem(MINI_POS_KEY)
        else window.localStorage.setItem(MINI_POS_KEY, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }))
      } catch (error) { /* 写不进去就这一次不记 */ }
    }

    // 拖出去不许丢：永远留一条边在视口里
    function clampMiniPos(p, w, h) {
      const pad = 6
      const vw = window.innerWidth || 0
      const vh = window.innerHeight || 0
      const maxX = Math.max(pad, vw - (w || 0) - pad)
      const maxY = Math.max(pad, vh - (h || 0) - pad)
      return { x: Math.min(Math.max(pad, p.x), maxX), y: Math.min(Math.max(pad, p.y), maxY) }
    }

    // 松手吸附：横向永远贴最近的一边，纵向离上下边太近就吸到边
    function snapMiniPos(p, w, h) {
      const pad = 12
      const edge = 48
      const vw = window.innerWidth || 0
      const vh = window.innerHeight || 0
      const width = w || 0
      const height = h || 0
      const x = (p.x + width / 2) < vw / 2 ? pad : Math.max(pad, vw - width - pad)
      const maxY = Math.max(pad, vh - height - pad)
      let y = Math.min(Math.max(pad, p.y), maxY)
      if (Math.abs(y - pad) <= edge) y = pad
      else if (Math.abs(maxY - y) <= edge) y = maxY
      return { x, y }
    }

    function MiniBar() {
      const s = useStore()
      const now = useTick(500)
      usePoll(30000)
      const [open, setOpen] = React.useState(false)
      const [hidden, setHidden] = React.useState(false)
      const [pos, setPos] = React.useState(readMiniPos)
      const [snapping, setSnapping] = React.useState(false)
      const dragRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const justDraggedRef = React.useRef(false)
      const timer = s.state.timer

      // 拖动：只在非按钮处按下才起拖，按钮该收的还是收到点击
      const dragHandlers = {
        onPointerDown: (event) => {
          if (event.button !== 0) return
          if (event.target && event.target.closest && event.target.closest('button')) return
          const el = event.currentTarget
          const rect = el.getBoundingClientRect()
          dragRef.current = {
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            w: rect.width,
            h: rect.height,
            moved: false,
          }
          try { el.setPointerCapture(event.pointerId) } catch (error) { /* 拿不到捕获也照样能拖 */ }
        },
        onPointerMove: (event) => {
          const d = dragRef.current
          if (!d) return
          d.moved = true
          setPos(clampMiniPos({ x: event.clientX - d.dx, y: event.clientY - d.dy }, d.w, d.h))
        },
        onPointerUp: (event) => {
          const d = dragRef.current
          dragRef.current = null
          if (!d) return
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* 同上 */ }
          if (d.moved) {
            // 拖完那一下松手别再当成点击（小圆点会被误展开）
            justDraggedRef.current = true
            setTimeout(() => { justDraggedRef.current = false }, 0)
            // 松手吸附：横向贴最近的一边，纵向离上下边近就吸上去
            setSnapping(true)
            setPos((current) => {
              const next = snapMiniPos(current || readMiniPos() || { x: 18, y: 18 }, d.w, d.h)
              writeMiniPos(next)
              return next
            })
            setTimeout(() => setSnapping(false), 280)
          }
        },
        onDoubleClick: () => { setPos(null); writeMiniPos(null) },
      }
      const posStyle = pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' } : null

      // 窗口变小 / 展开收起导致尺寸变化时，把落点收回视口内
      React.useEffect(() => {
        setPos((current) => {
          if (!current) return current
          const el = rootRef.current
          if (!el) return current
          const rect = el.getBoundingClientRect()
          return clampMiniPos(current, rect.width, rect.height)
        })
      }, [hidden, open])

      React.useEffect(() => {
        function onResize() {
          setPos((current) => {
            if (!current) return current
            const el = rootRef.current
            if (!el) return current
            const rect = el.getBoundingClientRect()
            return clampMiniPos(current, rect.width, rect.height)
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      if (hidden) {
        return h('button', Object.assign({
          ref: rootRef,
          className: 'sd-mini-fab' + (snapping ? ' snapping' : ''),
          title: '展开专注计时（可拖动，双击回右下角）',
          onClick: () => { if (!justDraggedRef.current) setHidden(false) },
          style: posStyle,
        }, dragHandlers), h(Icon, { name: 'clock', size: 16 }))
      }
      const remaining = timerRemaining(timer, now)
      const isFocus = !timer || timer.kind === 'focus'
      return h('div', Object.assign({
        ref: rootRef,
        className: 'sd-mini' + (open ? ' open' : '') + (timer ? '' : ' idle') + (snapping ? ' snapping' : ''),
        style: posStyle,
      }, dragHandlers), [
        h('div', { className: 'sd-mini-main', key: 'm' }, [
          h('span', { key: 'g', className: 'sd-mini-grip', title: '按住这里拖动（双击回右下角）' }),
          h('button', {
            key: 'play',
            className: 'sd-iconbtn sm',
            title: !timer ? '开始专注' : timer.running ? '暂停' : '继续',
            onClick: () => {
              if (!timer) store.apply('timer.start', { minutes: s.state.settings.focusMin || 25, kind: 'focus' })
              else if (timer.running) store.apply('timer.pause')
              else store.apply('timer.resume')
            },
          }, h(Icon, { name: !timer ? 'play' : timer.running ? 'pause' : 'play', size: 14 })),
          h('span', {
            key: 'c',
            className: 'sd-mini-clock' + (timer && !isFocus ? ' break' : ''),
            title: timer ? (isFocus ? `专注 · 第 ${timer.round} 轮` : '休息') : '番茄钟',
          }, timer ? fmtClock(remaining) : '--:--'),
          timer && timer.title ? h('span', { className: 'sd-mini-task', key: 't', title: timer.title }, timer.title) : null,
          h('button', {
            key: 'x',
            className: 'sd-iconbtn sm',
            title: open ? '收起' : '展开',
            onClick: () => setOpen((v) => !v),
          }, h(Icon, { name: open ? 'collapse' : 'expand', size: 14 })),
        ]),
        open ? h('div', { className: 'sd-mini-panel', key: 'p' }, [
          h('div', { className: 'sd-mini-row', key: 'r1' }, [
            h('span', { className: 'sd-mini-cap', key: 'c' }, '今日'),
            h('span', { key: 'v' }, `${fmtMinutes(s.todayMinutes)} / ${fmtMinutes(Number(s.state.settings.dailyGoalMin) || 180)}`),
            h('span', { className: 'sd-mini-cap', key: 's' }, `连续 ${s.streak} 天`),
          ]),
          h('div', { className: 'sd-mini-row', key: 'r2' }, [
            h('span', { className: 'sd-mini-cap', key: 'c' }, '待办墙'),
            h('span', { key: 'v' }, `${tasksIn('doing').length} 进行中 · ${tasksIn('todo').length} 待办`),
          ]),
          timer && isFocus && !timer.running ? h('button', {
            key: 'abandon', className: 'sd-textbtn', onClick: () => store.apply('timer.reset'),
          }, '放弃这一段') : null,
          h('div', { className: 'sd-mini-row sd-mini-actions', key: 'r3' }, [
            h('button', {
              key: 'open', className: 'sd-textbtn primary',
              onClick: () => {
                const layout = getLayout()
                if (!layout || typeof layout.selectPanel !== 'function') {
                  reportDiag({
                    kind: 'open-panel-failed',
                    where: 'mini.打开工作台',
                    message: '拿不到 layout 服务',
                    detail: {
                      hasCtx: Boolean(clientCtx),
                      hasGet: Boolean(clientCtx && typeof clientCtx.get === 'function'),
                      hasProp: Boolean(clientCtx && clientCtx.layout),
                    },
                  })
                  return
                }
                try {
                  layout.selectPanel(PANEL_ID)
                } catch (error) {
                  reportDiag({
                    kind: 'open-panel-failed',
                    where: 'mini.打开工作台',
                    message: 'selectPanel 抛错：' + String((error && error.message) || error),
                    stack: String((error && error.stack) || '').split('\n').slice(0, 12).join('\n'),
                  })
                }
              },
            }, '打开工作台'),
            h('button', { key: 'hide', className: 'sd-textbtn', onClick: () => { setOpen(false); setHidden(true) } }, '收起成小圆点'),
          ]),
        ]) : null,
      ])
    }

    // -----------------------------------------------------------------------
    // 设置页
    // -----------------------------------------------------------------------

    function NumField({ label, hint, value, min, max, onCommit }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => setDraft(String(value)), [value])
      const commit = () => {
        const n = Math.round(Number(draft))
        if (!Number.isFinite(n) || n < (min || 1)) { setDraft(String(value)); return }
        onCommit(Math.max(min || 1, Math.min(max || 9999, n)))
      }
      return h('label', { className: 'sd-field' }, [
        h('span', { className: 'sd-field-label', key: 'l' }, label),
        h('input', {
          key: 'i', className: 'sd-input', type: 'number', value: draft, min, max,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') commit() },
        }),
        hint ? h('span', { className: 'sd-field-hint', key: 'h' }, hint) : null,
      ])
    }

    function Settings() {
      const s = useStore()
      usePoll(60000)
      const st = s.state.settings || {}
      const patch = (p) => store.apply('settings.update', { patch: p })
      return h('div', { className: 'sd-settings' }, [
        h('p', { className: 'sd-settings-note', key: 'n' },
          '考研工作台：待办墙 + 学习热力图 + 番茄钟。数据只存在本机，不联网。'),
        h('div', { className: 'sd-settings-grid', key: 'g' }, [
          h(NumField, { key: 'goal', label: '每日目标（分钟）', value: st.dailyGoalMin || 180, min: 10, max: 1440, onCommit: (v) => patch({ dailyGoalMin: v }) }),
          h(NumField, { key: 'focus', label: '专注时长（分钟）', value: st.focusMin || 25, min: 1, max: 180, onCommit: (v) => patch({ focusMin: v }) }),
          h(NumField, { key: 'sb', label: '短休息（分钟）', value: st.shortBreakMin || 5, min: 1, max: 60, onCommit: (v) => patch({ shortBreakMin: v }) }),
          h(NumField, { key: 'lb', label: '长休息（分钟）', value: st.longBreakMin || 15, min: 1, max: 120, onCommit: (v) => patch({ longBreakMin: v }) }),
          h(NumField, { key: 'rw', label: '几轮后长休息', value: st.roundsBeforeLong || 4, min: 2, max: 12, onCommit: (v) => patch({ roundsBeforeLong: v }) }),
          h(NumField, { key: 'sm', label: '打卡门槛（分钟）', hint: '一天至少专注这么多才算连续打卡', value: st.streakMin || 10, min: 1, max: 240, onCommit: (v) => patch({ streakMin: v }) }),
        ]),
        h('label', { className: 'sd-field sd-field-inline', key: 'inj' }, [
          h('input', {
            key: 'c', type: 'checkbox', checked: st.injectPrompt !== false,
            onChange: (e) => patch({ injectPrompt: e.target.checked }),
          }),
          h('span', { key: 'l' }, '每轮对话把「今天该做什么」告诉模型'),
          h('span', { className: 'sd-field-hint', key: 'h' }, '关掉能省一点上下文'),
        ]),
        h('div', { className: 'sd-settings-file', key: 'f' }, `数据文件：${s.deskFile || '—'}`),
      ])
    }

    // -----------------------------------------------------------------------
    // 样式：全部走 --dsw-* token，零硬编码颜色
    // -----------------------------------------------------------------------

    const CSS = [
      // 页面骨架
      '.sd-page{display:flex;flex-direction:column;gap:18px;padding:22px 26px 48px;max-width:1220px;margin:0 auto;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary)}',
      '.sd-page *{box-sizing:border-box}',
      // 顶部
      '.sd-head{display:flex;flex-direction:column;gap:12px}',
      '.sd-head-row{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}',
      '.sd-head-row-end{align-items:center}',
      '.sd-head-main{display:flex;flex-direction:column;gap:4px}',
      '.sd-title{margin:0;font-size:24px;font-weight:600;letter-spacing:.02em;font-family:ui-serif,Georgia,"Songti SC","Noto Serif CJK SC",serif}',
      '.sd-subtitle{font-size:12.5px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
      '.sd-count{display:flex;align-items:baseline;gap:4px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}',
      '.sd-count-num{font-size:26px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}',
      '.sd-count-cap{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sd-count-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px;letter-spacing:.04em}',
      // 节点 chips
      '.sd-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.sd-chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.sd-chip b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.sd-chip-now{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}',
      '.sd-chip-now b,.sd-chip-now span{color:var(--dsw-alias-state-business-primary)}',
      '.sd-chip-past{opacity:.5}',
      '.sd-chip-approx{font-style:normal;font-size:10px;opacity:.7;border:1px solid currentColor;border-radius:4px;padding:0 3px;line-height:1.3}',
      // 今日进度
      '.sd-today{display:flex;flex-direction:column;gap:3px;min-width:190px}',
      '.sd-today-cap{font-size:11px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}',
      '.sd-today-num{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.sd-today-goal{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.sd-today-bar{margin-top:4px}',
      '.sd-today-streak{min-width:auto;align-items:flex-end}',
      '.sd-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;width:100%}',
      '.sd-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}',
      '.sd-bar-muted .sd-bar-fill{background:var(--dsw-alias-state-idle-primary)}',
      // 计时卡
      '.sd-timer-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.sd-timer-row{display:flex;align-items:center;gap:14px}',
      '.sd-timer-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.sd-timer-clock{font-size:34px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:.01em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.sd-timer-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.sd-phase{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px}',
      '.sd-phase-focus{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.sd-phase-break{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
      '.sd-dot{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex:none}',
      '.sd-timer-task{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}',
      '.sd-timer-sub{color:var(--dsw-alias-label-tertiary)}',
      '.sd-timer-bar{margin-top:2px}',
      '.sd-timer-side{display:flex;align-items:center;gap:6px;flex:none}',
      '.sd-timer-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;flex-wrap:wrap}',
      // 通用控件
      '.sd-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sd-row-end{margin-left:auto}',
      '.sd-mini-cap{font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}',
      '.sd-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:border-color .12s ease,color .12s ease,background .12s ease}',
      '.sd-iconbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}',
      '.sd-iconbtn-lg{width:42px;height:42px;border-radius:12px;color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}',
      '.sd-iconbtn.sm{width:22px;height:22px;border-radius:6px}',
      '.sd-textbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:3px 10px;border-radius:7px;cursor:pointer;transition:color .12s ease,border-color .12s ease}',
      '.sd-textbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '.sd-textbtn.primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sd-pill{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:3px 11px;border-radius:999px;cursor:pointer;transition:color .12s ease,border-color .12s ease,background .12s ease}',
      '.sd-pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '.sd-pill.on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.sd-pill.sm{font-size:11px;padding:2px 8px}',
      '.sd-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 8px;font-size:12px;max-width:200px;outline:none}',
      '.sd-select:disabled{opacity:.55}',
      '.sd-select.sm{font-size:11.5px}',
      '.sd-input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:4px 9px;font-size:13px;width:88px;outline:none}',
      '.sd-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      // 分区标题
      '.sd-section-title{display:flex;align-items:baseline;gap:10px;font-size:12px;letter-spacing:.1em;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:7px}',
      '.sd-section-hint{letter-spacing:0;font-size:11px;color:var(--dsw-alias-label-dimmed);margin-left:auto}',
      // 看板
      '.sd-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}',
      '.sd-col{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:10px;display:flex;flex-direction:column;gap:9px;min-height:120px;transition:border-color .15s ease,background .15s ease}',
      '.sd-col.hover{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-1))}',
      '.sd-col-head{display:flex;align-items:center;gap:7px;padding:2px 4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.sd-col-latin{font-size:10px;letter-spacing:.16em;color:var(--dsw-alias-label-dimmed)}',
      '.sd-col-label{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.sd-col-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:1px 8px}',
      '.sd-col-body{display:flex;flex-direction:column;gap:8px}',
      '.sd-col-empty{font-size:11.5px;color:var(--dsw-alias-label-dimmed);padding:10px 6px;text-align:center}',
      // 卡片
      '.sd-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:9px 11px;display:flex;flex-direction:column;gap:6px;cursor:grab;transition:border-color .12s ease,box-shadow .12s ease,opacity .12s ease}',
      '.sd-card:hover{border-color:var(--dsw-alias-border-l3)}',
      '.sd-card.dragging{opacity:.45}',
      '.sd-card.done{opacity:.68}',
      '.sd-card.done .sd-card-title{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}',
      '.sd-card-top{display:flex;align-items:flex-start;gap:6px}',
      '.sd-pin{color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:1.5}',
      '.sd-card-title{font-size:13px;line-height:1.5;word-break:break-word}',
      '.sd-card-note{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}',
      '.sd-card-foot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sd-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid transparent}',
      '.sd-spent{font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}',
      '.sd-est{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-dimmed)}',
      '.sd-card-acts{margin-left:auto;display:flex;align-items:center;gap:4px;opacity:0;transition:opacity .12s ease}',
      '.sd-card:hover .sd-card-acts,.sd-card:focus-within .sd-card-acts{opacity:1}',
      '.sd-act{display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px 5px;border-radius:5px;font-size:11px;transition:color .12s ease,background .12s ease}',
      '.sd-act:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.sd-act.danger{color:var(--dsw-alias-state-error-primary)}',
      '.sd-act.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      // 新建
      '.sd-add{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:7px;border-radius:9px;cursor:pointer;transition:color .12s ease,border-color .12s ease}',
      '.sd-add:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '.sd-composer{display:flex;flex-direction:column;gap:7px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-base)}',
      '.sd-composer-input{width:100%;resize:vertical;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;font-family:inherit}',
      '.sd-composer-foot{display:flex;align-items:center;gap:8px}',
      '.sd-composer-foot .sd-row{margin-left:auto}',
      // 块
      '.sd-two{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:14px;align-items:start}',
      '.sd-card-block{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px;display:flex;flex-direction:column;gap:10px}',
      '.sd-block-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.sd-block-title{margin:0;font-size:13px;font-weight:600;letter-spacing:.03em}',
      '.sd-block-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      // 热力图
      '.sd-heat-scroll{overflow-x:auto;padding-bottom:4px}',
      '.sd-heat{display:grid;gap:3px;width:max-content}',
      '.sd-heat-corner{width:22px}',
      '.sd-heat-month{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-bottom:2px}',
      '.sd-heat-day{font-size:9.5px;line-height:13px;color:var(--dsw-alias-label-dimmed);text-align:right;padding-right:2px}',
      '.sd-cell{width:13px;height:13px;border-radius:2.5px;background:var(--dsw-alias-bg-layer-3)}',
      '.sd-cell.empty{background:transparent}',
      '.sd-cell.lv0{background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}',
      '.sd-cell.lv1{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-3))}',
      '.sd-cell.lv2{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-bg-layer-3))}',
      '.sd-cell.lv3{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,var(--dsw-alias-bg-layer-3))}',
      '.sd-cell.lv4{background:var(--dsw-alias-brand-primary)}',
      '.sd-cell.today{outline:1px solid var(--dsw-alias-label-primary);outline-offset:1px}',
      '.sd-cell.legend{display:inline-block;vertical-align:middle;margin:0 2px}',
      '.sd-heat-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.sd-legend{display:inline-flex;align-items:center;gap:3px;margin-left:auto}',
      // 科目分布
      '.sd-subj-list{display:flex;flex-direction:column;gap:7px}',
      '.sd-subj{display:grid;grid-template-columns:minmax(0,7.5em) minmax(0,1fr) auto;align-items:center;gap:9px;font-size:11.5px}',
      '.sd-subj-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sd-subj-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.sd-subj-min{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.sd-empty-block{font-size:11.5px;color:var(--dsw-alias-label-dimmed);line-height:1.6}',
      '.sd-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
      '.sd-foot{font-size:10.5px;color:var(--dsw-alias-label-dimmed);text-align:center;word-break:break-all}',
      // 迷你条
      '.sd-mini{position:fixed;right:18px;bottom:18px;z-index:40;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:0 8px 26px rgba(0,0,0,.28);backdrop-filter:blur(10px);font-size:12px;color:var(--dsw-alias-label-primary);max-width:280px}',
      '.sd-mini-main{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;touch-action:none;user-select:none}',
      '.sd-mini-main:active{cursor:grabbing}',
      '.sd-mini-grip{flex:none;width:8px;height:14px;opacity:.4;background-image:radial-gradient(currentColor 1px,transparent 1.3px);background-size:4px 4px;background-position:1px 2px;background-repeat:repeat}',
      '.sd-mini-clock{font-variant-numeric:tabular-nums;font-size:15px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.sd-mini-clock.break{color:var(--dsw-alias-state-success-primary)}',
      '.sd-mini-task{font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sd-mini-panel{border-top:1px solid var(--dsw-alias-border-l1);padding:9px 10px;display:flex;flex-direction:column;gap:7px}',
      '.sd-mini-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.sd-mini-row .sd-mini-cap{flex:none}',
      '.sd-mini-actions{gap:6px}',
      '.sd-mini-fab{position:fixed;right:18px;bottom:18px;z-index:40;width:34px;height:34px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;box-shadow:0 6px 20px rgba(0,0,0,.25)}',
      '.sd-mini-fab:hover{color:var(--dsw-alias-brand-primary)}',
      // 松手吸附时给 left/top 加一段过渡，视觉上「啪」地贴边
      '.sd-mini.snapping,.sd-mini-fab.snapping{transition:left .22s cubic-bezier(.2,.8,.2,1),top .22s cubic-bezier(.2,.8,.2,1)}',
      '.sd-error{margin:16px;padding:14px 16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.sd-error-stack{margin:10px 0 0;padding:10px;max-height:320px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:6px}',
      // 设置
      '.sd-settings{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.sd-settings-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65}',
      '.sd-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}',
      '.sd-field{display:flex;flex-direction:column;gap:5px}',
      '.sd-field-inline{flex-direction:row;align-items:center;gap:9px;flex-wrap:wrap}',
      '.sd-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sd-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.sd-settings-file{font-size:11px;color:var(--dsw-alias-label-dimmed);word-break:break-all}',
      '@media (max-width:900px){.sd-board{grid-template-columns:minmax(0,1fr)}.sd-two{grid-template-columns:minmax(0,1fr)}}',
    ].join('')

    // -----------------------------------------------------------------------
    // apply
    // -----------------------------------------------------------------------

    let clientCtx = null

    const inject = ['slots']

    function apply(ctx) {
      clientCtx = ctx

      // 浏览器里没有能读的控制台，先把环境摸清楚回传一份，再把 window 上的
      // 全局异常也接住。这些都不影响主流程，失败就算了。
      reportDiag({
        kind: 'boot',
        where: 'client',
        message: 'client half applied',
        detail: {
          href: String(window.location && window.location.href),
          ua: String(navigator.userAgent || ''),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          hasSlots: Boolean(ctx.get && ctx.get('slots')),
          hasLayout: Boolean(getLayout()),
          reactVersion: String((React && React.version) || '未知'),
        },
      })
      window.addEventListener('error', (event) => {
        reportDiag({
          kind: 'window-error',
          where: 'window',
          message: String((event && event.message) || event),
          stack: String(((event && event.error && event.error.stack) || '')).split('\n').slice(0, 12).join('\n'),
          detail: { file: String((event && event.filename) || ''), line: (event && event.lineno) || 0, col: (event && event.colno) || 0 },
        })
      })
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event && event.reason
        reportDiag({
          kind: 'unhandled-rejection',
          where: 'window',
          message: String((reason && reason.message) || reason),
          stack: String((reason && reason.stack) || '').split('\n').slice(0, 12).join('\n'),
        })
      })

      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-study-desk: styles')

      store.refresh()
      startWatcher()
      ctx.effect(() => () => {
        if (watchTimer) { clearInterval(watchTimer); watchTimer = 0 }
      }, 'dsh-study-desk: watcher')

      const slots = ctx.get('slots')
      if (slots === undefined) {
        reportDiag({ kind: 'no-slots', where: 'client', message: '拿不到 slots 服务，界面不注册' })
        console.warn('[dsh-study-desk] 拿不到 slots 服务，界面不注册')
        return
      }

      // 每个槽位都用自己的 error boundary 包一层：某一处渲染炸了不该白屏，
      // 而且要把栈回传到磁盘，否则在浏览器里根本看不见。
      const register = (slot, meta, render, where) => {
        try {
          slots.inject(slot, () => slots.register(meta, (...args) => {
            let node
            try {
              node = render(...args)
            } catch (error) {
              reportDiag({
                kind: 'render-throw',
                where,
                message: 'factory 抛错：' + String((error && error.message) || error),
                stack: String((error && error.stack) || '').split('\n').slice(0, 12).join('\n'),
              })
              throw error
            }
            // 渲染成功也回传一次（同 where 只报第一次）：这样「面板没出来」
            // 到底是没渲染、还是渲染了但看不见，从磁盘上就能分辨。
            reportDiag({ kind: 'render-ok', where, message: 'factory 渲染成功' })
            return h(Boundary, { where }, node)
          }))
        } catch (error) {
          reportDiag({
            kind: 'register-failed',
            where,
            message: '注册槽位失败：' + String((error && error.message) || error),
            stack: String((error && error.stack) || '').split('\n').slice(0, 12).join('\n'),
          })
        }
      }

      // 左侧栏图标：id 与 main 的 key 同名，侧栏点它就会 dispatch 到 main 的同一格
      register('sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '考研工作台' },
        (props) => h(Icon, { name: 'board', size: (props && props.size) || 18 }),
        'sidebar.panellist')

      // 整页工作台
      register('main',
        { name: 'main', key: PANEL_ID },
        () => h(Panel, { key: 'panel' }),
        'main')

      // 右下角常驻迷你计时条（跨面板存活）
      register('shell.overlay',
        { name: 'shell.overlay', id: 'study-desk-mini', order: 80, label: '专注计时' },
        () => h(MiniBar, { key: 'mini' }),
        'shell.overlay')

      // 设置页
      register('settings.section',
        { name: 'settings.section', id: 'study-desk', order: 27, label: '考研工作台' },
        () => h(Settings, { key: 'settings' }),
        'settings.section')

      reportDiag({ kind: 'slots-registered', where: 'client', message: '四个槽位注册调用已完成' })
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { fmtClock, daysUntil, tasksIn }
    return module.exports
  },
})
