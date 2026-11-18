# gh-view

[English](./README.en.md) | 中文

按 **`#number`** 查阅 GitHub 仓库、Issue 和 Pull Request —— 可以来自编码 agent、DSH 窗口的侧边面板，也可以来自完全没有图形界面的终端（此时你会得到一张**渲染好的图片卡片**）。

![gh-view 总览](./gh-view-overview.png)

专为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）构建，也适用于任何能读文件或调用 CLI 的 agent 终端。

---

## 它做什么

| 入口 | 你能得到什么 |
|---|---|
| **Agent 工具** | `gh_repo`、`gh_list`、`gh_view`、`gh_search` —— 每个都同时返回一张 PNG 卡片**和**一段文字摘要 |
| **侧边面板** | DSH 窗口右边缘的一栏：输入 `owner/repo`，再用 `#123` 打开 Issue 或 PR |
| **图片卡片** | 仓库 / Issue / Pull Request / 列表，渲染为 PNG，供无法显示 HTML 的终端使用 |

所有入口共用同一套数据层，因此面板与 agent 看到的内容始终一致。

---

## 安装

需要 **DeepSeek Harness `^0.2.2-rc.3`**（即 `0.2.x` 中低于 `0.3.0` 的版本）以及 Node.js 22+。这个包是一个 bundle：安装后只新增一行插件配置。

按包名安装：

- **插件管理器** —— **Plugins → Add plugin**，目标填 `dsh-gh-view`
- **CLI** —— `dsh plugin --profile <profile> add dsh-gh-view`

开发时想用本地 checkout，则改为添加绝对目录：

```bash
dsh plugin --profile <profile> add /path/to/dsh-gh-view
```

bundle 的 patch 会插入这一行：

```yaml
- insert:
    - id: gh-view
      name: dsh-gh-view
      config: {}
```

---

## Agent 工具

四个工具都会返回卡片图片加一份紧凑的文字摘要，并且都接受 `image: false` 以跳过渲染。

### `gh_view` —— 你最常用的一个

```
gh_view(ref: "#123", repo?: "owner/repo", kind?: "any" | "issue" | "pr", image?: true)
```

`ref` 接受 `#123`、`123` 或 `owner/repo#123`。它会自行判断编号对应的是 Issue 还是 Pull Request。

```
gh_view(ref="#11099", repo="AstrBotDevs/AstrBot")
```

### `gh_repo` —— 仓库概览

```
gh_repo(repo?: "owner/repo", image?: true)
```

和其他工具一样，`repo` 默认取从工作区检测到的仓库。内容包括描述、star、watcher、fork、开放的 Issue/PR 数量、语言、许可证、默认分支、topics、最新 release、最近推送时间。

### `gh_list` —— 列表

```
gh_list(repo?: "owner/repo", kind?: "issue" | "pr" | "any",
        state?: "open" | "closed" | "all", labels?, search?,
        sort?: "created" | "updated", limit?, image?: true)
```

`search` 只保留标题包含这些词的条目。`sort` 默认是 `created` —— 按最后更新时间排序会把刚被评论的多年老 Issue 排在真正的新 Issue 前面。

### `gh_search` —— GitHub 搜索语法

```
gh_search(query: "repo:owner/name is:open label:bug", limit?, image?: true)
```

### 默认仓库 —— 跟随工作区

仓库类工具接受显式 `repo`。省略时，gh-view 会读取当前会话工作目录的 git remote 并自动选择一个：

- **`upstream` 优先于 `origin`** —— 在 fork 中，你真正关心的 Issue 和 PR 属于 `upstream`。
- 如果只有 `origin`，就用它。
- 如果两者都不是 GitHub remote，工具会说明并让你提供 `owner/repo`。

所以在任何 checkout 里可以直接说 `gh_view("#42")`。

作用域仅限当前目录，永远不是全局设置：两个不同项目的会话会解析到两个不同的仓库。

---

## GitHub 面板

插件以**全屏主面板**的形式打开：点击左侧边栏（Plugins 和 Scheduled tasks 之下）里的 **GitHub** 行 —— 要点击整行，不只是图标。它同时注册为右侧栏标签页，因此可以在你工作时停在对话旁边。

- **关闭** —— 面板的 **×** 返回对话。
- **返回** —— 面板内的 **← Back** 位于原来标签页那一行，也就是阅读者视线所在的位置；它返回你来自的列表，并保留列表的筛选条件。从详情页点击另一个标签页也会回到对应列表。
- **刷新** —— 面板自己的读取缓存为 30 秒；**⟳** 会清掉这份客户端缓存并重新请求（Host 侧仍有 60 秒缓存，所以刚变化的行最多可能滞后一分钟）。
- **查询区** —— 一旦检测到仓库，工作区/remote/查询区会**自动折叠**（用标题栏的 ⌄ / ⌃ 切换），把高度留给列表，而不是四行控件。

### 仓库选择

默认范围是**当前会话的目录**，并从它的 git remote 检测仓库。工作区会记住你上次在那里选择的仓库，来回切换时会恢复你的选择，而不是重新检测。

### 分页

列表每页显示 20 行，只要上一页是满的就会出现 **Load more** 控件 —— GitHub 的列表远不止一屏，静默截断会被读成"就这些了"。

### 列表为什么分两趟加载

每行的徽章（checks、review 结论、关联 PR）每行要花一两次请求，曾让 20 行的列表在出现任何内容前耗时五秒。因此面板会请求两次：

1. `badges=0` 只返回行本身（约一秒），列表先画出来；
2. 完整请求在后台补齐徽章，并按 Issue 编号合并，避免并发切换标签页时互相覆盖。

Pull Request 通常跳过这一步：GraphQL 列表已经带有 review 结论和 check rollup，因此面板只发一次列表请求。`gh` 路径不可用时，REST 回退会像 Issue 列表一样在第二趟补齐徽章。

### 概览

Overview 标签页的末尾是仓库的 **README**，使用与 Issue 正文相同的 markdown 规则渲染。

### 列表行显示什么

两个列表都带有 GitHub 网页版会放在行上的徽章，因此一眼就能回答同一个问题：

- **PR / Issue 图标**，按状态着色（open、closed、merged、draft）
- **Draft** 标记，以及分支无法合并时的 **Conflicts**
- **status checks** —— rollup 状态（passing、failing、running）；详情页会列出每一项 check 及其日志
- **review 结论** —— Approved / Changes requested / Review required，使用 GitHub 自己的 `reviewDecision`（它会计入分支要求的 review，而不仅是原始 approve 数）
- **assignees**、review 数和评论数
- Issue 上的**关联 Pull Request**，带 draft 标记

Pull Request 列表通过一次 GraphQL 往返获取，所以列表画出时徽章已经就位，而不是之后才陆续出现。

### 详情页

Issue 或 Pull Request 详情会渲染它的 **markdown 正文** —— 每条评论也一样（最多 30 条）。渲染器处理真实 GitHub 文本中实际存在的内容：

- 标题、列表、任务列表（真正的复选框）、围栏代码块、引用、表格
- 行内粗体 / 斜体 / 删除线 / 代码 / 链接，以及 GitHub 放行的 HTML（`<strong>`、`<em>`、`<code>`、`<del>`、`<sub>`、`<sup>`、`<kbd>`、`<a>`）
- **GitHub 警告提示框** —— `> [!IMPORTANT]`、`[!NOTE]`、`[!WARNING]` 等会渲染成带标签的面板，而不是一行字面量方括号
- **`<details>` 块**保持可展开/折叠，CodeRabbit 之类的机器人正是用它折叠成千上万行生成内容
- **HTML 注释会被移除**（CodeRabbit 等会输出机器标记）

原始 HTML 永远不会被当作标记注入，因此正文无法夹带脚本或样式规则。长正文和长评论默认收起为 **Show N more lines**，而不是用省略号截断。

**图片会被渲染。** README 徽章和截图是内容，不是链接：

- `![alt](url)` 变成真正的 `<img>`，懒加载
- `[![alt](img)](link)` —— 徽章盾牌形式 —— 用括号配平的分组解析，嵌套图片保持完整，不会被切成 `![alt` 加零散标点
- 原始 `<img src="…" width="…">` 会被识别，`width` 也会生效
- 仓库相对路径（`/docs/x.png`、`./x.png`）解析到 `raw.githubusercontent.com/<owner>/<repo>/HEAD/`，这里的 `HEAD` 是默认分支 —— 与 GitHub 网页版为 README 图片使用的目标一致
- 加载失败时回退到 alt 文本，而不是一个空框

### 状态检查

checks 徽章是**可点击的**，会展开成逐项 checks，失败的排在最前，GitHub 提供 URL 时每项都链接到它的日志。只有数字只能回答"绿了吗"；下一个问题永远是"是哪一项"。

### 筛选与排序

Issues 和 Pull requests 标签页使用 GitHub 自己的查询词汇，在服务端生效：

- **State** —— Open / Closed / All
- **Labels** —— 逗号分隔，必须全部匹配（`bug, client: MXU`）
- **Title** —— 标题中必须出现的词（`in:title`）
- **Order** —— *Newest created* 或 *Recently updated*，都是最新在前。这一点很重要：一个多年老 Issue 刚被评论属于"最近更新"但不算"新建"，默认按创建排序，列表读起来才像时间线。

### 作用域

- **Workspace** —— 面板跟随你选择的工作区，永远不是全局设置。
- **Remote** —— 当 checkout 的 `origin` 和 `upstream` 指向不同仓库时，会出现选择器供你切换，而不是手输其中一个。
- **Jump** —— 输入 `#123`（或 `owner/repo#123`），按 **Jump**

面板是使用宿主主题 token 的纯 DOM 视图。PNG 卡片是给无法渲染该 DOM 的终端准备的。

---

## 数据从哪里来

两个可互换的数据源，自动选择：

1. **`gh` CLI** —— 如果安装了 `gh`，gh-view 会使用它。它继承 CLI 的登录状态，因此私有仓库可用，而本插件从不接触 token。
2. **公开 REST API** —— 否则使用 `api.github.com`，匿名访问；如果设置了 `GITHUB_TOKEN` / `GH_TOKEN` 则带上它。

如果 `gh` 已安装但无法应答 —— 未登录、token 被拒、无网络 —— 自动读取会回退到 REST 路径而不是直接失败；只有 REST 也失败时才会报告 `gh` 的诊断信息。

匿名 API 调用限制为每小时 60 次。达到限制时工具会说明并建议 `gh auth login`。读取结果在 Host 侧缓存 60 秒（remote 检测为 10 分钟），因此重复查询不消耗 API 调用 —— 但 PNG 卡片仍然每次调用都重新栅格化，约 1–2 秒。只需要文字摘要时传 `image: false`。

---

## 图片卡片是怎么生成的

卡片以 HTML 编写，由机器上已有的无头 Chromium 栅格化 —— Microsoft Edge 或 Google Chrome。这样 CJK 换行、字体回退、省略号和 emoji 都与浏览器完全一致，也避免在插件里打包字体或栅格化库。

值得了解的结果：

- **必须安装 Chromium 浏览器。** 没有的话，工具仍会返回文字摘要，并说明已跳过渲染。
- 浏览器会以临时目录里的独立 profile 启动，写出截图后按 PID 终止（只终止该进程树）。
- 整窗截图由内置的小型 PNG 解码器裁到卡片的真实高度，因此没有图片库依赖。
- 每张卡片渲染约两秒。

如果想完全关闭渲染，传 `image: false`；文字摘要包含同样的事实。

---

## HTTP 路由

面板通过以下同源路由与 Host 通信：

| 路由 | 用途 |
|---|---|
| `GET /gh-view/health` | `{ok, version, build, source, canRender, supportsImageTools, remotes}` |
| `GET /gh-view/remotes?dir=` | 某个目录的 GitHub remote：`{ok, data: {origin, upstream, preferred, remotes}}` |
| `GET /gh-view/repo?repo=` | 仓库信息（JSON）；`dir=` 可以替换 `repo=` |
| `GET /gh-view/readme?repo=` | 仓库 README 的 markdown，或 `null` |
| `GET /gh-view/repo-card?repo=` | 仓库卡片（PNG） |
| `GET /gh-view/view?repo=&ref=` | 单个 Issue/PR（JSON） |
| `GET /gh-view/view-card?repo=&ref=` | 单个 Issue/PR 卡片（PNG） |
| `GET /gh-view/list?repo=&kind=&state=&labels=&search=&sort=&limit=&offset=&badges=0` | 列表（JSON），一页 |
| `GET /gh-view/search?q=&limit=` | 搜索（JSON） |

`badges=0` 返回不带逐行 checks/review 查询的行；面板先请求这一页以便立即绘制，再请求同一页的完整版本。

所有接受 `repo=` 的路由也接受 `dir=<workspace path>`，并从该目录的 git remote 检测仓库（`upstream` 优先）。

---

## 在 DSH 之外使用

插件本身是 DSH bundle，但数据层和渲染层是普通 ES 模块，不 import 任何 DSH 内容：

```js
import { getRepo, getPull, getAnyRef } from 'dsh-gh-view/lib/github.js'
import { renderCard } from 'dsh-gh-view/lib/render.js'
import { writeFileSync } from 'node:fs'

const pull = await getAnyRef('AstrBotDevs/AstrBot', 11099)
const { png } = await renderCard(pull)
writeFileSync('card.png', png)
```

包的 `./lib/*` 导出正是为此准备的。如果从普通 checkout 使用，把包名换成相对路径（`./lib/github.js`）即可。

这就是非 DSH agent 终端所需的全部路径：调用函数、写出 PNG、把图片交给用户。

---

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半区：工具注册、`/gh-view/*` 路由 |
| `client.js` | Client 半区：侧边面板与工具卡片 |
| `lib/github.js` | 数据层：`gh` CLI 与 REST、归一化、缓存 |
| `lib/render.js` | 卡片 HTML、无头 Chromium 栅格化、PNG 裁剪 |
| `lib/http-guard.js` | 面板 HTTP 路由的 Origin/Host 校验 |
| `cordis.patch.yml` | bundle patch |
| `locale/{en,zh}.json` | 显示元数据（`meta.title`、`meta.description`） |
| `icon.svg` | bundle 图标，以 `./icon` 导出 |
| `gh-view-overview.png` | 本 README 的总览图；随包发布，npm 与插件管理器详情页才能提供它 |
| `tests/` | Node test runner 检查：manifest、库行为、打包文件清单 |
| `scripts/overview.mjs` | 生成 `gh-view-overview.png`（仅仓库，不随 npm 包发布） |
| `assets/shot-{pr,issue}.png` | 总览脚本内嵌的卡片截图（仅仓库） |
| `.github/workflows/ci.yml` | 在 Node 22 和 24 上运行测试 |
| `CHANGELOG.md` | 发布说明 |

## 关于插件激活的一个说明

Host 半区声明了
`export const inject = ['tools', 'attachments', 'webServer', 'workspaceRegistry']`。
这是关键配置：如果用 `ctx.get()` 读取这些服务，就会与启动顺序产生竞态，因为 `get()` 是严格的，对尚未激活的服务返回 `undefined` —— 冷启动时工具和路由会被静默跳过，而热重载后看起来又正常。

`workspaceRegistry` 是必需项而非便利项：面板的 `dir=` 参数受限于已注册的工作区，通过 `ctx.get()` 读取同样会与启动竞态。那里的竞态不会明显报错 —— 它会静默放宽限制，所以该服务被声明为必需。

`workingDirectory` 特意**不在**该列表中。它只服务于默认仓库的便利功能，因此没有它的 profile 仍然能得到工具（显式传 `repo`），而不是整个插件消失。

有一个值得记录的细节：`workingDirectory.get()` 接受 **Session**，而不是 Agent。它读取会话的 `workingDirectory` 投影，所以传 Agent 会静默返回部署默认值 —— 看起来像"remote 检测坏了"，而不是类型错误。Host 半区会先取出 `agent.session` 再调用。

### Client 半区的依赖

Client 半区声明自己的 `inject`：

```js
inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']
```

这是右侧栏标签页最关键的一行。那两个服务由 sidebar-right 插件**在自己的 effect 内部**发布，因此本插件的 `apply` 首次运行时它们还不可用。Cordis 只为模块级 `inject` 中列出的服务保证顺序，所有已发布的右侧栏插件都是这么做的：

```js
// dsh-client-ui-sidebar-terminal
const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', ...]
```

若在 apply 时用 `ctx.get()` 读取，会得到 `undefined`，标签页类型永远不会注册，症状是静默的：标签页直接不存在，控制台也没有任何信息。`ctx.inject` 和轮询都解决不了 —— 正是这个声明让 Cordis 等待。

一个标签页类型由两次注册组成，两者**缺一不可**：

1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` —— 声明 kind 以及起始页胶囊的*数据*；
2. `ctx.slots.register({ name: 'sidebar.right.tab.guide.entry', key: id }, Card)`
   —— 提供*绘制*该胶囊的卡片。没有它，条目会被分派到 owner 的通用 fallback。

**卡片必须自己处理点击。** 该 slot 的 owner props 只有
`{ entryId, kind, title, description }` —— 没有 pick 回调，这与 owner 内部的 `EntryBox`（接收 `onPick`）不同。只渲染文字的卡片看起来正确，但完全无响应。这里通过 `ctx.sidebarRight.openTab(kind)` 打开标签页；如果侧栏没有可打开的会话，则回退到全屏主面板。

自定义卡片还会**替换**外壳的条目框，而不是嵌套在其中，所以它必须自己绘制胶囊，否则会像带边框行之间的一行裸文字。卡片镜像外壳自身的度量 —— 380px 宽、56px 最小高度、`14px 20px` 内边距、`0.5px` 边框、`--dsw-alias-bg-layer-1` 填充和 `--dsl-guide-entry-radius` —— 因此与内置条目严丝合缝。

面板主体（`sidebar.right.pane.tab`）和主面板入口（`sidebar.panellist` + `main`）是 slot 而非服务，因此它们无条件注册，即使侧栏不存在也能工作。

---

## 开发

```bash
npm test          # manifest、数据层、文档与打包文件检查
npm run overview  # 重新生成 gh-view-overview.png（需要 Edge 或 Chrome）
```

`npm test` 就是 CI 运行的内容（Node 22 和 24，`.github/workflows/ci.yml`）。测试是离线的；渲染真实卡片需要浏览器，但不属于测试范围。

---

## 安全说明

DSH 的 Web 服务器在分派命名路由时不做 cookie、Host 或 Origin 校验，而这些路由会暴露宿主 `gh` 登录能读取的一切。以下后果都做了显式处理：

- **浏览器请求被限制在本服务器自己的 origin。** `Origin` 指向其他主机或协议、`Sec-Fetch-Site: cross-site` 的请求，以及 `Host` 既不是绑定地址也不是 loopback 写法的请求，都会得到 403。这挡住了跨站读取和 DNS rebinding 页面。边界是机器而不是操作系统用户：本机上的另一个进程，甚至另一个本地用户，仍然可以调用这些路由，因为监听器本身没有任何认证。
- **渲染有并发上限。** 最多同时运行两个无头浏览器，因为一张卡片就会启动一个浏览器进程，而这些路由没有认证。
- **路由只在 loopback 绑定时提供服务。** 它们携带宿主 `gh` 登录能读到的内容，而请求头无法证明对端在本机，因此绑定到 LAN 地址的 DSH 服务器 —— 或者无法确认绑定的服务器 —— 会以 403 禁用这些路由（agent 工具仍可用），而不是把私有 GitHub 数据暴露到网络。服务器默认绑定 `127.0.0.1`，这也是预期的部署方式。
- **`dir=` 被限制在已注册的工作区。** 若不限制，它会报告磁盘上任意仓库的 git remote，包括私有仓库。该值会用 `realpath` 规范化并与工作区注册表比对，因此 `..`、大小写技巧以及注册路径内部的 symlink 都无法改变查询目标；如果注册路径本身被替换，则解析为它当前指向的目标 —— 也就是该工作区现在的样子。解析后会再次校验规范化路径，Windows 的 UNC/设备路径会在触发网络查询之前被拒绝，且所有拒绝使用同一条消息，避免该路由变成文件系统存在性探测。注册表不可用时，路由会**fail closed**，而不是回退到开放的读取。
- **仓库名经过严格校验。** `owner/repo` 只接受字母数字、点、短横线和下划线，并拒绝前导 `-` 或 `@` 以及裸 `..`。这堵住了一个真实的漏洞：`gh -F name=@path` 会读取文件并把内容作为值发送，因此未校验的"仓库名" `@C:\…\id_rsa` 会泄露它。同样的校验也阻止 `..` 把 `/repos/../user` 重定向到另一个 API 端点。前导 `.` 被刻意允许 —— `.github` 是 GitHub 上最常见的仓库名之一。

正文通过 React 元素渲染，从不使用 `innerHTML`，每个 `href` 和 `src` 都经过协议白名单（`http`、`https`、`mailto`、`#`、`data:image/*`），因此 Issue 正文里敌意的 `[x](javascript:…)` 不会产生链接。卡片 HTML 在进入无头浏览器之前会转义，而该浏览器从 `file://` origin 加载页面 —— 页面里若有一个活的 `<script>`，就能读取本地文件。

传给 API 的路径按段检查而不是按子串：URL 解析器还会折叠 `%2e%2e`，并在某个特殊 scheme 下把 `\` 当作 `/`，否则 `/repos/%2e%2e/user` 会到达 `/user` 而找不到字面的 `..`。TTL 缓存有界（200 条，每条独立过期时间），因为路由可以按查询字符串生成 key。

---

## 环境要求

- DeepSeek Harness **`^0.2.2-rc.3`** —— 从 `rc.3` 到 `<0.3.0` 的 `0.2.x` 版本（在 `engines.dsh` 中声明；不兼容的 DSH 会拒绝安装）
- Node.js **22+**（在 `engines.node` 中声明）
- 带 `webServer`、`tools`、`attachments` 和 `workspaceRegistry` 的 profile（Web profile 自带）
- `gh` CLI *或* 可访问 `api.github.com` 的网络
- Microsoft Edge 或 Google Chrome，仅图片卡片需要

---

## 许可证

MIT。
