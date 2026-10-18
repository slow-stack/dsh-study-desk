# AGENTS.md · dsh-study-desk

给任何在这个目录里干活的 agent（DSH 会话、其他 harness、编辑器里的助手）看的项目说明。
**动手之前先读完这一页**，里面两条坑是踩出来的，不读会重踩。

---

## 这是什么

一个 DeepSeek Harness 插件的**独立源码工程**。装进某个 profile 之后，DSH 里会多出：

- **待办墙**：Notion 式三列（待办 / 进行中 / 已完成），卡片带科目、预计时长、累计投入，可拖拽换列；
- **学习热力图**：点亮条件是**当天实际复习了多少分钟**，不是「当天有没有消耗 token / 有没有开过会话」；
- **番茄钟**：专注 / 短休 / 长休自动轮换，换面板、刷新、关掉浏览器再打开都按绝对截止时间恢复；
- **常驻迷你条**：右下角小胶囊，在对话页也能看见剩余时间。

它**不属于 DSH 官方**，也不依赖任何第三方包（运行时依赖为零）。宿主半边只额外用到 DSH 自己的
`@deepseek-ai/dsh-tools`，且做了三级兜底（见坑 2）。

## 文件地图

| 文件 | 是什么 |
| --- | --- |
| `desk.js` | 纯数据层：读写 `desk.json`、任务增删改排、**间隔重复排期（简化 SM-2）**、**遗忘曲线 / 到期预报 / 今日建议**、标签归一化、日复盘、热力图分档、连续打卡、周报、按科目统计。**不依赖 dsh 运行时，可独立单测。** |
| `markdown.js` | Markdown 导出 / 读回（纯函数）：`toMarkdown` 生成 Obsidian 友好的 `desk.md`，`fromMarkdown` + `mergeMarkdown` 按 id 合并读回。机器字段放在行尾 `<!-- desk:… -->` 注释里。 |
| `bbdc.js` | **不背单词打卡桥**（纯数据层，零依赖）：从腾讯 Androws 虚拟磁盘里的 App 数据读打卡/时长/词书，再用 App WebView 缓存里挖到的 `sid` 打 `learnywhere.cn` 的统计接口补累计词数。**只读**，不回写 App。`bbdcView()` 把采集结果裁成面板要看的紧凑形状（挡住 sid 摘要与临时目录）；`readBbdc()` 带 10 分钟缓存 + 并发去重。 |
| `timer.js` | 番茄钟状态机：`start/pause/resume/reset/complete/reconcile`。真相是绝对时间戳，不用「还剩多少毫秒」。 |
| `index.js` | **宿主半边**：`study_desk` 工具（11 个 action）+ `/api/dsh-study-desk` 路由 + 往 system prompt 注入今日摘要。派生数据（复习队列（每张带 `curve`）/统计/`forecast` 七日预报/`plan` 今日建议/周报/标签/单词打卡）一律由 `desk.js` / `bbdc.js` 算好再随快照发出。 |
| `client.js` | **客户端半边**：整页看板（复习队列 / 过滤栏 / 热力图 / 周报 / 复盘）+ 独立的「单词打卡」面板 + 设置页 + 迷你条，注册 6 个槽位（2 个侧栏入口 + 2 个 main + 1 个迷你条 + 1 个设置节）。 |
| `cordis.patch.yml` | 让宿主把本插件 insert 进 loader 树。 |
| `package.json` | `dsh.bundle.patch` 指向上面那个 patch；`dsh.client` 声明客户端半边与注入的运行时包。 |
| `test/desk.test.js` | 30 个单测，`node --test`。 |
| `test/markdown.test.js` | 4 个单测：导出→读回往返、手写 Markdown 读回、id 命中即更新。 |
| `test/bbdc.test.js` | 11 个单测：prefs 解析、按月求和（累计 293 词就是 48 个月的 `learnNum` 相加）、`sid` 编码变体等。 |
| `test/mini-dock.test.js` | 3 个单测：迷你条松手不贴边、仍会被收回视口、吸附实现已移除。 |
| `apply-probe.mjs` | 离线冒烟：用 stub ctx 把两侧 `apply()` 真跑一遍，不启动 DSH 就能抓加载期错误。 |
| `install.mjs` | 把自己的路径写进某个 profile 的 `package.json`，跑 pnpm，并维护 patch 里的入口 URL。 |

## 设计约束（改的时候别破坏）

1. **绝不写死颜色。** `client.js` 整块只消费 `--dsw-alias-*` / `--dsw-static-*` 主题 token，不覆写任何 token。
   这条是硬的：用户是 Obsidian / Notion 用户，明确要求「不要改变我看板的主题，看板融入就好」。
   需要带色就用 `color-mix(in srgb, var(--dsw-alias-brand-primary) N%, transparent)`。
2. **热力图的语义是「复习分钟数」。** 别改成按会话数 / token 数点亮 —— 那正是市面上同类插件的问题，也是本插件存在的理由。
3. **数据落 `<DSH_HOME>/study-desk/desk.json`**（本机即 `D:\DSH\.dsh\study-desk\desk.json`），不放进这个工程目录：
   源码和数据分开，工程目录可以整体搬走 / 丢进 git。写入必须是「临时文件 + rename」原子替换；
   文件坏了改名留档，**不要清空**。
4. **计时器一律用绝对时间戳当真相。** `running` 时看 `endsAt`，暂停才把剩余量固化到 `remainingMs`。
   `spentMs` 记已经走过的量，所以暂停过的一段按真实投入记账，不虚报整段。
5. **`cordis.patch.yml` 提交时必须是裸包名** `dsh-study-desk`（可移植、可发布）。
   本机为了在**跑着的** DSH 里热挂载调试，`install.mjs` 会把它改写成带绝对路径的 `file://…?v=N`；
   那是本机形态，**不要提交**（`git checkout cordis.patch.yml` 就还原了）。
   所以在这台机器上 `git status` 常年显示这一个文件「已修改」—— 正常。
6. **提交信息不要带 AI 署名**（用户的硬规则）。对外文本里也不要出现本机用户名，
   或 Windows 用户目录那种绝对路径（`C:` 下 Users 里带真名的那种）—— CI 会 grep 直接红。
7. **复习排期、队列排序、周报、标签聚合只在 `desk.js` 一处算。** 宿主把 `review / due / tags / weekly / journal`
   随快照发出，`client.js` 只画不算。浏览器里再实现一遍 SM-2 迟早和宿主对不上。
8. **Markdown 读回是「合并」不是「覆盖」**：`desk.md` 里没出现的卡不动；靠行尾 `<!-- desk:id:… -->` 对回原卡，
   注释被删就当新卡。导出的 Markdown 里不许出现本机绝对路径。
9. **不背单词那边只读，且凭据不出门。** `bbdc.js` 只读 App 数据与官方 H5 的公开统计接口，
   不回写、不改 App 任何文件。它挖到的 `sid` 是**她的登录凭据**：缓存落盘前必须只留前 10 位
   （`bbdcView()` 里做裁剪），面板、日志、提交、导出 Markdown 里都不许出现完整值或本机绝对路径。
   `sid` 的编码形态也是坑：缓存里那串**已经是百分号编码过的**，必须原样拼进 query
   （用 `URLSearchParams.set` 或 `encodeURIComponent` 会二次编码 `%`→`%25`，服务端不报错，
   但会返回**别人的**游客数据 —— 表现是「数字全都对不上」而不是「报错」）。

## 三个必须知道的坑

### 坑 0：客户端有**两个**面板，别把 `main` 的 key 配错

侧栏入口的 `id` 必须与对应 `main` 的 `key` **完全一致**，否则宿主的
`layout.selectPanel` 会直接 `throw`：`main panel "<id>" is not registered`。
现在两对是 `study-desk`（学习工作台）与 `study-desk-bbdc`（单词打卡）。

### 坑 1：运行时热挂载的 entry 认不出裸包名

启动时从 `dsh.profile.bundles` 装配的 entry 能按裸包名 `dsh-study-desk` 解析；
但**运行中热挂载进来的新 entry 解析基准不一样**，写裸包名会在**模块加载阶段**直接失败。

最恶心的是：loader 把真正的异常吞进 `ctx.logger`，对外只报一句
`dsh-study-desk (dsh-study-desk): failed to import` —— 没有任何细节，看报错完全判断不出原因
（`inactiveEntries()` 里 `fiber === undefined` 就归为这一类）。
排查时是拿一个**零顶层 import 的诊断壳**替换 `index.js` 才证明「不是我的代码有问题」。

解法：本机调试时把 entry 名写成**完整文件 URL**（`install.mjs` 会自动干这件事）。

```yaml
- insert:
    - id: dsh-study-desk
      name: file:///D:/dsh-study-desk/index.js?v=5
```

反过来，**重启 DSH 之后裸包名是能认的**（启动期装配走的是和 `dsh-sticker` 一样的解析），
所以仓库里存的是裸包名；URL 只是「不重启也要认」的本地形态。

### 坑 2：`@deepseek-ai/dsh-tools` 在磁盘上不存在

它打包在 `app.asar` 里，任何 `node_modules` 都找不到它，连官方模板 `dsh-sticker` 也一样
（裸 Node 跑 `import('dsh-sticker')` 会 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`，
但它在 DSH 里工作正常 —— 说明这是 DSH 自带的解析，不是插件写错了）。

但热挂载的 entry **可能真的 import 不到它**。而 `defineTool` 不是简单透传：它把「友好 schema 描述」
编译成 registry-ready 的 JSON Schema，少了这层编译，注册时会抛

```
JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
```

所以 `index.js` 里那个兜底**必须老老实实做转换**（`localValueSchema` / `localParameters`），
不能写成 `const defineTool = (o) => o`。

### 附带一条：`ctx.set` 要先 `provide`

```js
ctx.provide('studyDesk', { ... })   // 对
ctx.set('studyDesk', { ... })       // 抛 Error: cannot set property "studyDesk" without provide
```

### 坑 3：宿主外壳不替你滚、也不替你抬层（客户端布局）

这两条都来自 `app.asar` 里的 `@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css`，
在本仓库里 grep 不到，只能反编译宿主看：

```css
.BynINW_centerCol   { display:flex; flex-direction:column; overflow:hidden }
.BynINW_overlayLayer{ position:absolute; inset:0; z-index:20; pointer-events:none }
.BynINW_overlayLayer > * { pointer-events:auto }
```

- **`main` 面板必须自己出滚动容器。** 中心列 `overflow:hidden` 且不滚，
  所以 `.sd-page` 直接铺进去会被压扁、下半截永远看不见。
  照官方任务管理页那套四层写：`sd-panel`（`flex:1;min-height:0;display:flex`）
  → `sd-scroll`（`flex:1;min-height:0;overflow-y:auto`）→ `sd-page`（内容）。
- **`shell.overlay` 里的浮层要 portal 到 `document.body`。** 那一层自己是
  `z-index:20` 的独立层叠上下文：里面写 `z-index:40` 也只跟层内比，出了这层永远排在 20，
  任何 body 级 `position:fixed`（宿主的模态 1000、菜单/气泡 1100、tooltip 100）都能盖住它，
  表现就是「卡片看得见但点不动、拖不动」。`client.js` 里用 `require('react-dom').createPortal`
  挂到 body，并自带 `pointer-events:auto` 与 `z-index:900`（压在模态下面）。
  主题 token 定义在 `body` 上，所以 portal 之后 `--dsw-alias-*` 照样取得到。
  验证过的对照：同一个右下角落点，层内形态被 body 级浮层盖住（`elementFromPoint` 命中的是别人），
  portal 形态命中自己。

## 改完怎么生效

宿主半边是 ESM，**模块按 URL 缓存**：

1. 改完 `index.js` → `node install.mjs --bump`（把裸包名写成 `file:///…?v=6`，或把已有的 `?v=5` 递增）；
2. 去 DSH 插件管理里把本插件**关掉、再打开**（要看到 `changed: true` 才会重新装配）。

只改文件不递增 → 跑的还是旧代码；只递增不停用再启用 → 装配根本不重跑。
客户端半边（`client.js`）没有这层缓存，改完刷新页面即可。

提交前记得 `git checkout cordis.patch.yml`，把本机 URL 换回裸包名。

## 测试

```bash
node --test             # 48 个单测：数据层 + 番茄钟状态机 + 复习排期 + 遗忘曲线/预报/建议 + Markdown 往返 + 不背单词 prefs 解析
node apply-probe.mjs    # 离线冒烟：stub ctx 跑两侧 apply()，检查工具 / 路由 / 槽位注册 / 新 op / 快照新字段
node install.mjs --check  # 体检：本目录与某个 profile 的接线是否完整
```

注意 `apply-probe.mjs` 会加载 `client.js`，而客户端 `apply()` 起了盯倒计时的 `setInterval`，
进程不会自己退出 —— 所以它结尾必须 `process.exit(...)`。另外 `client.js` 的 `apply()` 需要
`globalThis.fetch` 存在（探针里 stub 了一份完整快照）。

### 客户端界面怎么验（不启动 DSH）

冒烟探针只跑到「factory 返回了 Boundary」，跑不到组件内部 —— 界面改动的正确验法是**真挂载**：
拿一份 React 18 的 UMD 构建（本机任意 `node_modules/react{,-dom}/umd/*.production.min.js`），
写一个 HTML 复刻宿主外壳（`frame > centerCol(flex, overflow:hidden) + overlayLayer(z-index:20, pointer-events:none)`），
塞进宿主的 `body{--dsw-alias-*}` 主题 token，替换 `window.fetch` 成一个小假宿主，
然后用 `def.factory(require)` 拿到模块、`ReactDOM.createRoot` 把四个槽位挂出来，
再用真 `MouseEvent('click')` 点一遍按钮、断言 POST 出去的 op。
暗色只要给 `<body>` 加 `data-ds-dark-theme`（注意：暗色标记在 **body** 上，不是 html）。
无头 Edge 出图与结果：`msedge --headless=new --dump-dom`（把断言写进一个屏外 `<pre>`）+ `--screenshot`。

**更省事的一档：`exports.__test`。** `client.js` 末尾把几个组件连同 `store` 一起挂了出来
（`MemoryCurve / Forecast / PlanStrip / ReviewQueue / store`），所以可以不起浏览器：
`new Function('require','module','exports', code)` 在真全局里加载 bundle
（预置 `globalThis.window.__ModuleLoader__.load` 接住 factory，再补 `document / fetch / navigator /
localStorage / requestAnimationFrame / ResizeObserver / matchMedia` 几个桩），
`store.absorb(一份与宿主 `snapshot()` 同形状的快照)` 之后用 `react-dom/server` 的
`renderToStaticMarkup` 直接把组件渲成 HTML 断言。改组件时用它最快，
**但它渲不出布局与点击**（宿主外壳的 `overflow:hidden`、层叠上下文那些坑照样得过真挂载那一关）。
真 React 得自带：宿主的 `app.asar` 里没有 `react`（只有 `fast-deep-equal` 的同名文件）。

## 安装到别的 profile

```bash
node install.mjs --profile <profile 目录>     # 装（幂等）
node install.mjs --profile <profile 目录> --check   # 只看不动
node install.mjs --profile <profile 目录> --uninstall
```

它会：备份 profile 的 `package.json` → 加 `link:` 依赖 → 把包名加进 `dsh.profile.bundles`
→ 跑一次 pnpm install → 校验 junction 指回本目录。
装完**新开一个会话**：DSH 的工具表是会话开始时的快照，新增的工具要新会话才会加载。

## 发版

`package.json` 的 `version` 是唯一真相，tag 用 `v<版本>`，CHANGELOG 顶部加一段。三处对齐后：

```bash
git tag -a v0.6.1 -m 'v0.6.1' && git push origin master v0.6.1
gh release create v0.6.1 --title '…' --notes-file <文件>
```

### 走哪条路

两条都通，**优先走 `release.yml`**（带 provenance 签名，包的可信度更高）：

1. **Actions 触发（首选）**：Trusted Publisher 登记好之后，`gh workflow run release.yml --ref <tag>`，
   OIDC 自动认证，不需要任何 token。
2. **本机直发（兜底）**：本机 token 发布，不带 provenance。

Trusted Publisher 已于 2026-10-18 登记完成（repo `slow-stack/dsh-study-desk`、
workflow `release.yml`、允许 publish），**实测认证已通过**：复验那次失败在
`You cannot publish over the previously published versions: 0.6.1` —— 那是版本号已被本机
直发占用，不是配置问题。真正验证 OIDC 全链路要等下一个新版本号。

顺手记下第一次（未登记时）的报错形状，以后好区分：
`npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-study-desk`，而日志里
`Signed provenance statement` 已经成功。签名过了却被 registry 拒绝，就是没登记；
**这种 404 不是版本冲突，别被它骗去改版本号。**

### Trusted Publisher 只能用浏览器配

2026-07-31 起 npm 把「敏感账号 / 包管理操作」收回到交互式 2FA 后面（见
`https://gh.io/npm-gat-bypass2fa-deprecation`）：`npm trust github …` 用本机的 granular
access token 调 `POST /-/package/<pkg>/trust` 会 403
（`Granular access tokens that bypass two-factor authentication may not perform this action`），
`npm trust list` 同样 403。CLI 补登记这条路是死的，只能去浏览器点。
GAT 从 2027-01 起会失去直接发布权，届时第 2 条路就断了，提前把第 1 条走顺有实际意义。
登记入口：`https://www.npmjs.com/package/dsh-study-desk/settings`。

### 本机直发

```bash
npm publish --access public --no-provenance
```

（`--no-provenance` 必须带：本机不在 Actions 里，默认的 provenance 会失败；`--no-git-checks`
在新版 npm 里已经不是合法 flag 了，别抄老命令。）发完等半分钟到一分钟再 `npm view` 验证，
registry 的 packument 有缓存延迟。

**另一个坑**：`npm publish` 只认 `files` 白名单里的东西，但 `CHANGELOG.md` / `README.md` /
`LICENSE` 是 npm 强制带上的。所以 `npm pack` 的 `total files` 会比白名单多几条 —— CI 里那条
断言是**逐个核对白名单里的文件都在**，不是数总数。

### 换行必须锁死（.gitattributes）

仓库用 `.gitattributes` 的 `* text=auto eol=lf` 把换行锁成 LF，**不要删**。

以前没有这个文件、而本机全局 `core.autocrlf=true`，于是同一份代码在磁盘上是 CRLF、在 git blob
里是 LF。后果是 `npm pack` 在两条路径上产出**字节不同的包**：

| 路径 | client.js | unpacked | shasum |
| --- | --- | --- | --- |
| 本机（工作区 CRLF） | 149009 | 329.2 kB | `68b6decc…` |
| CI（checkout LF） | 146342 | 322.9 kB | `35fbedd7…` |

两个包都能跑（单测都过），但「同一个 tag 装出来的东西」不可复现，也排查不清楚。
加 `.gitattributes` 之后，重新检出的工作区已经是 146342 字节，与 blob 一致。

改完 `.gitattributes` 或怀疑换行跑偏时，用这条核对——它应该输出 0 个不一致：

```bash
cd D:\dsh-study-desk
for f in $(git ls-files); do
  a=$(wc -c < "$f"); b=$(git cat-file -s HEAD:$f)
  [ "$a" != "$b" ] && echo "DIFF $f worktree=$a blob=$b"
done
```

已经 CRLF 的工作区不会自己变过来，需要删掉文件重新 `git checkout -- .`。

