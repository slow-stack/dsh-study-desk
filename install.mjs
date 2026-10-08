#!/usr/bin/env node
/**
 * dsh-study-desk 安装器
 *
 * 把一个 profile 接到本目录上：加 link: 依赖 → 包名进 dsh.profile.bundles → 跑 pnpm → 校验 junction。
 * 同时维护 cordis.patch.yml 里的入口 URL（详见 AGENTS.md 的「坑 1」与「改完怎么生效」）。
 *
 *   node install.mjs                          # 装进 $DSH_PROFILE_DIR（或 $DSH_HOME/profiles/$DSH_PROFILE）
 *   node install.mjs --profile <profile 目录或名字>
 *   node install.mjs --check                  # 只体检，不写任何东西
 *   node install.mjs --bump                   # 只把 ?v=N 递增（改了 index.js 之后用）
 *   node install.mjs --uninstall              # 卸下（保留 DSH_HOME 里的数据）
 *   node install.mjs --no-pnpm                # 跳过 pnpm install
 *   node install.mjs --pnpm <pnpm.cjs 路径>    # 指定 pnpm
 *
 * 幂等：重复跑不会重复加条目；被改过的文件都先备份成 <名字>.bak-study-desk-<时间戳>。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const NAME = PKG.name
const PATCH_FILE = join(HERE, 'cordis.patch.yml')
const LINK_SPEC = 'link:' + HERE.replace(/\\/g, '/')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const val = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const say = (line = '') => console.log(line)
const ok = (line) => console.log('  ok   ' + line)
const bad = (line) => console.log('  FAIL ' + line)

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  return env || join(homedir(), '.dsh')
}

function resolveProfile() {
  const given = val('--profile', '')
  if (given) {
    if (isAbsolute(given) || existsSync(given)) return resolve(given)
    return join(dshHome(), 'profiles', given)
  }
  const envDir = String(process.env.DSH_PROFILE_DIR || '').trim()
  if (envDir) return resolve(envDir)
  return join(dshHome(), 'profiles', String(process.env.DSH_PROFILE || 'desktop').trim() || 'desktop')
}

// ---------------------------------------------------------------------------
// cordis.patch.yml 里的入口 URL
// ---------------------------------------------------------------------------

export function entryUrl(version) {
  return pathToFileURL(join(HERE, 'index.js')).href + '?v=' + version
}

export function readPatchVersion(text) {
  const m = String(text).match(/\?v=(\d+)/)
  return m ? Number(m[1]) : 0
}

export function withEntryName(text, name) {
  if (!/^\s*name:\s*/m.test(text)) {
    return text.replace(/\s*$/, '\n') + `- insert:\n    - id: ${NAME}\n      name: ${name}\n`
  }
  return text.replace(/^(\s*)name:\s*.*$/m, `$1name: ${name}`)
}

// ---------------------------------------------------------------------------
// profile 的 package.json
// ---------------------------------------------------------------------------

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function backups(file) {
  const stamp = Date.now()
  const to = file + '.bak-study-desk-' + stamp
  copyFileSync(file, to)
  return to
}

/** 返回 { changed, needs } —— 只算了要不要改，不改文件。 */
function planProfilePackage(pkg) {
  const deps = pkg.dependencies || (pkg.dependencies = {})
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  return {
    needsDep: deps[NAME] !== LINK_SPEC,
    needsBundle: !bundles.includes(NAME),
    deps,
    bundles,
  }
}

// ---------------------------------------------------------------------------
// pnpm
// ---------------------------------------------------------------------------

function findPnpm() {
  const explicit = val('--pnpm', String(process.env.DSH_PNPM || '').trim())
  if (explicit) {
    if (!existsSync(explicit)) return null
    return { cmd: process.execPath, args: [explicit], label: explicit }
  }
  const probe = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' })
  if (probe.status === 0) return { cmd: 'pnpm', args: [], label: 'pnpm（PATH 上）' }
  return null
}

function runPnpm(profileDir) {
  if (has('--no-pnpm')) {
    say('  skip 按 --no-pnpm 跳过 pnpm install')
    return true
  }
  const pnpm = findPnpm()
  if (!pnpm) {
    bad('找不到 pnpm —— 手工在 profile 目录跑一次 `pnpm install`，或用 --pnpm 指定（DSH 自带的在 <DSH 安装目录>/resources/runtime/pnpm/bin/pnpm.cjs）')
    return false
  }
  say('  run  ' + pnpm.label + ' install（cwd=' + profileDir + '）')
  const r = spawnSync(pnpm.cmd, [...pnpm.args, 'install'], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: pnpm.cmd === 'pnpm',
  })
  if (r.status !== 0) {
    bad('pnpm install 退出码 ' + r.status)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 各模式
// ---------------------------------------------------------------------------

function check(profileDir) {
  say('工程目录：' + HERE)
  say('profile：' + profileDir)
  say()
  say('代码：')
  for (const f of ['index.js', 'client.js', 'desk.js', 'timer.js', 'package.json', 'cordis.patch.yml']) {
    const p = join(HERE, f)
    if (existsSync(p)) ok(f + '（' + statSync(p).size + ' bytes）')
    else bad('缺 ' + f)
  }

  say()
  say('patch 入口：')
  if (!existsSync(PATCH_FILE)) {
    bad('缺 cordis.patch.yml')
  } else {
    const text = readFileSync(PATCH_FILE, 'utf8')
    const v = readPatchVersion(text)
    const m = text.match(/^\s*name:\s*(.*)$/m)
    const name = m ? m[1].trim() : '(没有 name 行)'
    say('  name: ' + name)
    if (name.startsWith('file:')) {
      if (v > 0) ok('是完整 URL，?v=' + v + '（热挂载可用）')
      else bad('是 URL 但没有 ?v=N 版本号 —— 改了 index.js 不会重载')
    } else if (name === NAME) {
      say('  note 是裸包名：启动时装配 OK；运行中热挂载这个 entry 会报没有细节的 failed to import')
    } else {
      bad('name 既不是本包名也不是 file: URL')
    }
  }

  say()
  say('profile 接线：')
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(profileDir) || !existsSync(pkgFile)) {
    bad('找不到 ' + pkgFile)
    return 1
  }
  const pkg = readJSON(pkgFile)
  const plan = planProfilePackage(pkg)
  plan.needsDep ? bad('dependencies 里没有（或不是）' + LINK_SPEC) : ok('dependencies: ' + LINK_SPEC)
  plan.needsBundle ? bad('dsh.profile.bundles 里没有 ' + NAME) : ok('dsh.profile.bundles 里有 ' + NAME)

  const link = join(profileDir, 'node_modules', NAME)
  if (!existsSync(link)) {
    bad('node_modules/' + NAME + ' 不存在 —— 需要跑一次 pnpm install')
  } else {
    const st = lstatSync(link)
    if (st.isSymbolicLink()) {
      // junction 在 Windows 上会带 \\?\ 前缀（还可能带尾随 \0），去掉再比较
      const target = resolve(readlinkSync(link).replace(/^\\\\\?\\/, '').replace(/\0/g, '').trim())
      if (target === resolve(HERE)) ok('junction → ' + HERE)
      else bad('junction 指向 ' + target + '（不是本目录 —— 装成别处的拷贝了？）')
    } else {
      bad('node_modules/' + NAME + ' 不是链接而是'
        + (st.isDirectory() ? '真实目录（说明装的是拷贝，改这里没用）' : '其它类型'))
    }
  }
  return 0
}

function bumpOnly() {
  if (!existsSync(PATCH_FILE)) {
    bad('缺 cordis.patch.yml')
    return 1
  }
  const text = readFileSync(PATCH_FILE, 'utf8')
  const from = readPatchVersion(text)
  const to = from + 1
  copyFileSync(PATCH_FILE, backups(PATCH_FILE))
  writeFileSync(PATCH_FILE, withEntryName(text, entryUrl(to)))
  say(`patch 入口：?v=${from} → ?v=${to}`)
  say('接下来要做的：去 DSH 插件管理里把本插件关掉、再打开（要看到 changed: true）。')
  return 0
}

function uninstall(profileDir) {
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) {
    bad('找不到 ' + pkgFile)
    return 1
  }
  const pkg = readJSON(pkgFile)
  const plan = planProfilePackage(pkg)
  let touched = false
  if (pkg.dependencies && NAME in pkg.dependencies) {
    say('  备份 ' + backups(pkgFile))
    delete pkg.dependencies[NAME]
    touched = true
  }
  if (plan.bundles.includes(NAME)) {
    if (!touched) say('  备份 ' + backups(pkgFile))
    const rest = plan.bundles.filter((x) => x !== NAME)
    pkg.dsh.profile.bundles = rest
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    touched = true
  }
  if (existsSync(PATCH_FILE)) {
    copyFileSync(PATCH_FILE, backups(PATCH_FILE))
    writeFileSync(PATCH_FILE, withEntryName(readFileSync(PATCH_FILE, 'utf8'), NAME))
  }
  runPnpm(profileDir)
  say()
  say('已卸下。数据（' + join(dshHome(), 'study-desk', 'desk.json') + '）没动。')
  return 0
}

function install(profileDir) {
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) {
    bad('找不到 ' + pkgFile + ' —— profile 目录对不对？用 --profile 指定')
    return 1
  }

  // 1) patch 入口 URL
  if (!existsSync(PATCH_FILE)) {
    writeFileSync(PATCH_FILE, `- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`)
  }
  const patchText = readFileSync(PATCH_FILE, 'utf8')
  const oldV = readPatchVersion(patchText)
  const newV = oldV + 1
  copyFileSync(PATCH_FILE, backups(PATCH_FILE))
  writeFileSync(PATCH_FILE, withEntryName(patchText, entryUrl(newV)))
  say('patch 入口：' + (oldV ? '?v=' + oldV + ' → ' : '裸包名 → ') + '?v=' + newV)

  // 2) profile package.json
  const pkg = readJSON(pkgFile)
  const plan = planProfilePackage(pkg)
  if (!plan.needsDep && !plan.needsBundle) {
    ok('profile 的 package.json 已经接好了，不用改')
  } else {
    say('  备份 ' + backups(pkgFile))
    plan.deps[NAME] = LINK_SPEC
    if (plan.needsBundle) plan.bundles.push(NAME)
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    if (plan.needsDep) ok('dependencies += "' + NAME + '": "' + LINK_SPEC + '"')
    if (plan.needsBundle) ok('dsh.profile.bundles += "' + NAME + '"')
  }

  // 3) pnpm
  if (!runPnpm(profileDir)) return 1

  // 4) 校验
  say()
  say('校验：')
  return check(profileDir)
}

// ---------------------------------------------------------------------------

const profileDir = resolveProfile()
if (has('--check')) process.exit(check(profileDir))
if (has('--bump')) process.exit(bumpOnly())
if (has('--uninstall')) process.exit(uninstall(profileDir))
process.exit(install(profileDir))
