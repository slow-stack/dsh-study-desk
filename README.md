# dsh-study-desk · 考研工作台

一个 DeepSeek Harness 插件，把 DSH 里多出一间自习室：

- **待办墙**：Notion 式三列（待办 / 进行中 / 已完成），卡片带科目、预计时长、累计投入，可拖拽换列。
- **学习热力图**：GitHub 贡献图那种格子，但点亮条件是**当天实际复习满 1 分钟**，越亮越接近你设的每日目标。
  市面上的热力图插件基本都按「当天有没有消耗 token / 有没有开过会话」点亮，那是使用强度，不是学习量。
- **番茄钟**：25/45/60 分钟三档，自动轮换短休 / 长休；换面板、刷新、关掉浏览器再打开，倒计时都按原截止时间恢复。
- **常驻迷你条**：右下角一个小胶囊，在对话里也能看见剩余时间和今日进度。

## 视觉

整块界面**只消费** `--dsw-alias-*` 与 `--dsw-static-*` 主题 token，**不覆写任何 token、不写死任何颜色**。
所以它不会改你的主题，而是跟着当前主题（含 catppuccin 之类的 remap）一起变。想换个风格，换主题就行。

## 安装

在 DSH 的 profile 目录里把它加成一个 bundle：

```bash
dsh plugin --profile <profile> add link:<这个目录>
```

再把包名 `dsh-study-desk` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组。
（也可以直接用 DSH 自带的插件管理界面安装。）

装完记得**新开一个会话**：DSH 的工具表是会话开始时的快照，插件新增的工具要新会话才会加载。

## 数据

`<DSH_HOME>/study-desk/desk.json`，纯 JSON，可直接打开看、手工改、丢进 git 做版本。

```
tasks[]     卡片：id / title / status / subject / note / estimateMin / order / doneAt / pinned
sessions[]  专注记录：一分钟往上的每一段都在这里，热力图和统计的唯一数据源
timer       当前番茄钟（绝对截止时间戳），换页面/关页面都能恢复
settings    每日目标、专注时长、休息时长、打卡门槛等
```

写入走「临时文件 + rename」原子替换；文件坏了会改名留档而不是清空。

## 工具

给模型一个 `study_desk` 工具：

| action | 作用 |
| --- | --- |
| `board` | 看当前看板全貌（距考试天数、今日进度、进行中、待办、今天完成） |
| `add` | 新建卡（`title` / `subject` / `status` / `estimateMin` / `pinned`） |
| `move` | 卡片换列或排序（`id` 或 `title` + `status` + `beforeId`） |
| `update` | 改卡片字段 |
| `remove` | 删卡 |
| `focus` | 起停番茄钟（`minutes` / `task` / `off`） |
| `stats` | 最近 N 天的专注统计与科目分布 |

另外每轮对话会往系统提示里注入一小段「距初试几天 / 今天专注多少 / 进行中是什么」，
让模型说话时知道你现在在干什么。不想要就在设置页关掉。

## 开发

```bash
node --test             # 10 个单测：数据层与番茄钟状态机，不依赖 dsh 运行时
node apply-probe.mjs    # 离线冒烟：用 stub ctx 把两侧的 apply() 真跑一遍
```

宿主半边（`index.js`）与客户端半边（`client.js`）都是手写 ESM / 纯 JS 模块，没有构建步骤。

### 改了代码，怎么让跑着的 DSH 认

宿主半边是 ESM，**模块按 URL 缓存**，所以要两步：

1. 改完 `index.js`，把 `cordis.patch.yml` 里的 `?v=5` 递增成 `?v=6`；
2. 再去插件管理里把本插件**关掉、再打开**（要看到 `changed: true` 才算重新装配）。

只改文件不递增 → 跑的还是旧代码；只递增但不停用再启用 → 装配根本不重跑。
客户端半边（`client.js`）没有这层缓存，改完刷新页面就行。

### 为什么 patch 里是个绝对路径

`cordis.patch.yml` 的 entry name 目前是 `file:///D:/dsh-study-desk/index.js?v=5`。
启动时从 `dsh.profile.bundles` 装配的 entry 能按裸包名解析，但**运行中热挂载进来的新 entry 解析基准不一样**：
裸包名 `dsh-study-desk` 会在模块加载阶段直接失败，对外只报一句没有任何细节的 `failed to import`
（真正的异常被 loader 吞进 logger，所以从报错里看不出原因）。
给完整 `file://` URL 就正常。

这是本地安装的取舍：重启 DSH 后可以把 name 换回裸包名 `dsh-study-desk`（启动期组装的 entry 有正确的解析基准）。
要发给别人用之前，必须换回裸包名——patch 里写死某台机器的目录，别人装完直接起不来。

## License

MIT
