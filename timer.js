/**
 * dsh-study-desk —— 番茄钟状态机
 *
 * 计时器的「真相」存在宿主侧（desk.json 的 timer 字段），客户端只负责按 endsAt 画倒计时。
 * 这样做的原因：
 *   1. 换面板 / 刷新页面 / 关掉浏览器再打开，倒计时都按同一个绝对截止时间恢复，不会重置；
 *   2. 计时器归零这件事由 reconcileTimer 兜底——不管当时有没有页面开着，
 *      下一次任何一侧读写状态时都会把该记的专注补进 sessions。
 *
 * 时间一律用绝对时间戳当真相，不用「还剩多少毫秒」：running 时看 endsAt - now，
 * 暂停时才把剩余量固化到 remainingMs 与 endsAt 上。已经走过的量记在 spentMs 里，
 * 所以中途暂停过也能算出真实投入（手动结束时按 spentMs 记，不虚报整段）。
 */

import { logSession } from './desk.js'

const MINUTE = 60000

export function countFocusToday(state, now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const from = d.getTime()
  return state.sessions.filter((s) => s.kind === 'focus' && s.at >= from).length
}

export function phaseMinutes(state, kind, roundsDone) {
  const s = state.settings
  if (kind === 'break') {
    const every = Math.max(1, Number(s.roundsBeforeLong) || 4)
    const long = roundsDone > 0 && roundsDone % every === 0
    return long ? s.longBreakMin : s.shortBreakMin
  }
  return s.focusMin
}

function resolveTask(state, ref) {
  const key = String(ref || '').trim()
  if (!key) return null
  return state.tasks.find((t) => t.id === key)
    || state.tasks.find((t) => t.title === key)
    || state.tasks.find((t) => t.title.toLowerCase() === key.toLowerCase())
    || null
}

/** 这一段实际跑了多少毫秒（不含之前暂停前的累计外的重复计算）。 */
export function elapsedMs(timer, now = Date.now()) {
  if (!timer) return 0
  const spent = Number(timer.spentMs) || 0
  if (!timer.running) return spent
  return spent + Math.max(0, Math.min(now, timer.endsAt) - timer.startedAt)
}

/** 还剩多少毫秒。 */
export function remainingMs(timer, now = Date.now()) {
  if (!timer) return 0
  if (timer.running) return Math.max(0, timer.endsAt - now)
  return Math.max(0, Number(timer.remainingMs) || 0)
}

export function makeTimer(state, input, now = Date.now()) {
  const kind = input && input.kind === 'break' ? 'break' : 'focus'
  const rounds = countFocusToday(state, now)
  const round = kind === 'focus' ? rounds + 1 : Math.max(1, rounds)
  const wanted = Number(input && input.minutes)
  const minutes = Math.max(1, Math.min(600, Math.round(Number.isFinite(wanted) && wanted > 0 ? wanted : phaseMinutes(state, kind, rounds))))
  const task = input && input.taskId ? resolveTask(state, input.taskId) : null
  const span = minutes * MINUTE
  return {
    kind,
    minutes,
    round,
    taskId: task ? task.id : null,
    title: task ? task.title : String((input && input.title) || ''),
    subject: task ? task.subject : String((input && input.subject) || ''),
    startedAt: now,
    endsAt: now + span,
    running: true,
    remainingMs: span,
    spentMs: 0,
  }
}

export function startTimer(state, input, now = Date.now()) {
  state.timer = makeTimer(state, input, now)
  return state.timer
}

export function pauseTimer(state, now = Date.now()) {
  const t = state.timer
  if (!t) return null
  if (!t.running) return t
  t.spentMs = elapsedMs(t, now)
  t.remainingMs = Math.max(0, t.endsAt - now)
  t.running = false
  t.endsAt = now + t.remainingMs
  return t
}

export function resumeTimer(state, now = Date.now()) {
  const t = state.timer
  if (!t) return null
  if (t.running) return t
  t.remainingMs = Math.max(0, Number(t.remainingMs) || 0)
  t.running = true
  t.startedAt = now
  t.endsAt = now + t.remainingMs
  return t
}

export function resetTimer(state) {
  state.timer = null
  return null
}

function pushFocus(state, timer, minutes, at) {
  logSession(state, {
    minutes,
    taskId: timer.taskId,
    title: timer.title,
    subject: timer.subject,
    kind: 'focus',
    at,
  })
}

/**
 * 把已经走完的计时器结账。返回 state 是否被改动。
 * 专注走完 → 记一条 session，并按节奏自动摆上休息；
 * 若人已经离开很久（连休息也过去了），就不再摆一个已经过期的计时器。
 */
export function reconcileTimer(state, now = Date.now()) {
  const t = state.timer
  if (!t || !t.running || !(t.endsAt <= now)) return false
  if (t.kind === 'focus') {
    pushFocus(state, t, t.minutes, t.endsAt)
    const rounds = countFocusToday(state, t.endsAt)
    const minutes = phaseMinutes(state, 'break', rounds)
    const endsAt = t.endsAt + minutes * MINUTE
    state.timer = endsAt > now
      ? {
        kind: 'break',
        minutes,
        round: rounds,
        taskId: null,
        title: '',
        subject: '',
        startedAt: t.endsAt,
        endsAt,
        running: true,
        remainingMs: minutes * MINUTE,
        spentMs: 0,
      }
      : null
  } else {
    state.timer = null
  }
  return true
}

/** 手动结束这一段：按真实跑过的时长记账，然后照常进休息。 */
export function completeTimer(state, now = Date.now()) {
  const t = state.timer
  if (!t) return false
  if (t.kind === 'focus') {
    const ran = Math.round(elapsedMs(t, now) / MINUTE)
    pushFocus(state, t, Math.min(t.minutes, Math.max(1, ran)), now)
    const rounds = countFocusToday(state, now)
    const minutes = phaseMinutes(state, 'break', rounds)
    state.timer = {
      kind: 'break',
      minutes,
      round: rounds,
      taskId: null,
      title: '',
      subject: '',
      startedAt: now,
      endsAt: now + minutes * MINUTE,
      running: true,
      remainingMs: minutes * MINUTE,
      spentMs: 0,
    }
  } else {
    state.timer = null
  }
  return true
}
