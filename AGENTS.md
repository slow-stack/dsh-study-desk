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
| `desk.js` | 纯数据层：读写 `desk.json`、任务增删改排、**间隔重复排期（简化 SM-2）**、标签归一化、日复盘、热力图分档、连续打卡、周报、按科目统计。**不依赖 dsh 运行时，可独立单测。** |
| `markdown.js` | Markdown 导出 / 读回（纯函数）：`toMarkdown` 生成 Obsidian 友好的 `desk.md`，`fromMarkdown` + `mergeMarkdown` 按 id 合并读回。机器字段放在行尾 `<!-- desk:… -->` 注释里。 |
| `timer.js` | 番茄钟状态机：`start/pause/resume/reset/complete/reconcile`。真相是绝对时间戳，不用「还剩多少毫秒」。 |
| `index.js` | **宿主半边**：`study_desk` 工具（10 个 action）+ `/api/dsh-study-desk` 路由 + 往 system prompt 注入今日摘要。派生数据（复习队列/统计/周报/标签）一律由 desk.js 算好再随快照发出。 |
| `client.js` | **客户端半边**：整页看板（复习队列 / 过滤栏 / 热力图 / 周报 / 复盘）+ 设置页 + 迷你条，注册 4 个槽位。 |
| `cordis.patch.yml` | 让宿主把本插件 insert 进 loader 树。 |
| `package.json` | `dsh.bundle.patch` 指向上面那个 patch；`dsh.client` 声明客户端半边与注入的运行时包。 |
| `test/desk.test.js` | 16 个单测，`node --test`。 |
| `test/markdown.test.js` | 4 个单测：导出→读回往返、手写 Markdown 读回、id 命中即更新。 |
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
6. **提交信息不要带 AI 署名**（用户的硬规则）。对外文本也不要出现本机用户名或 `C:\Users\...` 路径。
7. **复习排期、队列排序、周报、标签聚合只在 `desk.js` 一处算。** 宿主把 `review / due / tags / weekly / journal`
   随快照发出，`client.js` 只画不算。浏览器里再实现一遍 SM-2 迟早和宿主对不上。
8. **Markdown 读回是「合并」不是「覆盖」**：`desk.md` 里没出现的卡不动；靠行尾 `<!-- desk:id:… -->` 对回原卡，
   注释被删就当新卡。导出的 Markdown 里不许出现本机绝对路径。

## 三个必须知道的坑

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
node --test             # 20 个单测：数据层 + 番茄钟状态机 + 复习排期 + Markdown 往返
node apply-probe.mjs    # 离线冒烟：stub ctx 跑两侧 apply()，检查工具 / 路由 / 槽位注册 / 新 op
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

## 安装到别的 profile

```bash
node install.mjs --profile <profile 目录>     # 装（幂等）
node install.mjs --profile <profile 目录> --check   # 只看不动
node install.mjs --profile <profile 目录> --uninstall
```

它会：备份 profile 的 `package.json` → 加 `link:` 依赖 → 把包名加进 `dsh.profile.bundles`
→ 跑一次 pnpm install → 校验 junction 指回本目录。
装完**新开一个会话**：DSH 的工具表是会话开始时的快照，新增的工具要新会话才会加载。
