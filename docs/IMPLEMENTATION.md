# 实现与设计说明

本文记录 gh-view 的实现细节与设计取舍；面向使用者的说明见 [README](../README.md)。

## 列表加载

列表初次出现时发两次请求：

1. `badges=0` 只取行数据，先绘制列表；
2. 第二次请求同一页的完整数据，在后台补齐 checks、review 结论、关联 PR 等徽章，并按 Issue 编号合并，避免切换标签页时互相覆盖。

Pull Request 列表走 GraphQL，一次往返即包含 review 结论与 check rollup，因此通常不需要第二趟；`gh` 不可用时退回 REST，按 Issue 列表的方式补齐。

每次列表请求带单调递增的 token；切换标签页、仓库或筛选后，旧的响应会被丢弃。筛选请求也走同一条加载路径，避免慢请求写进新视图。

## 面板与请求状态

- 面板自身的读取缓存 30 秒；服务端缓存 60 秒，所以 **⟳** 刷新最多仍可能拿到一分钟内的旧数据。
- 详情请求同样带 token：**← Back**、切换标签页或连续跳转时，旧详情不会覆盖新页面。
- 点击列表行时用该行自己的 `repository` 拼 `owner/repo#number`，不会把旧仓库的行开到新仓库。

## 图片卡片

卡片以 HTML 编写，由本机已有的 Microsoft Edge 或 Google Chrome 无头渲染：

- 浏览器以临时目录中的独立 profile 启动，写出截图后按 PID 终止该进程树；
- 截图由内置 PNG 解码器裁到卡片真实高度，不依赖图片库；
- 没有浏览器时工具返回文字摘要，并说明跳过渲染；
- 渲染并发上限为 2，队列上限 16，超出时返回错误而不是无限排队。

## 插件激活

Host 半区：

```js
export const inject = ['tools', 'attachments', 'webServer', 'workspaceRegistry']
```

用 `ctx.get()` 读取这些服务会与启动顺序竞态：`get()` 是严格的，对尚未激活的服务返回 `undefined`，冷启动时工具和路由会被静默跳过。`workspaceRegistry` 是必需项——`dir=` 的限定依赖它，竞态会静默放宽限定。`workingDirectory` 有意不在列表中：它只用于默认仓库检测，缺少时仍可通过显式 `repo` 使用工具。

`workingDirectory.get()` 接受 **Session** 而不是 Agent；传 Agent 会静默返回部署默认值，Host 半区会先取出 `agent.session`。

Client 半区声明：

```js
inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']
```

右侧栏服务由 sidebar-right 插件在其 effect 内发布，`apply` 首次运行时尚不可用；只有模块级 `inject` 能让 Cordis 等待。用 `ctx.get()` 读取会得到 `undefined`，标签页类型静默不注册。

一个标签页类型需要两次注册：

1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` 声明 kind 与起始页胶囊的数据；
2. `ctx.slots.register({ name: 'sidebar.right.tab.guide.entry', key: id }, Card)` 提供绘制胶囊的卡片。

卡片必须自己处理点击（该 slot 只提供 `entryId/kind/title/description`，没有 pick 回调），通过 `ctx.sidebarRight.openTab(kind)` 打开，没有可打开的会话时回退到全屏主面板。自定义卡片会替换外壳的条目框，因此需要自己按外壳度量绘制（380px 宽、56px 最小高、`14px 20px` 内边距、`0.5px` 边框、`--dsw-alias-bg-layer-1` 填充、`--dsl-guide-entry-radius`）。

## 数据源与缓存

- `gh` 可用时优先使用；`gh` 返回失败时，`auto` 模式会回退到 REST。显式 `source: 'gh'` 不会回退，显式 `source: 'api'` 不会走 `gh` 或 GraphQL。
- REST token 在每次读取开始时快照进调用参数，缓存 key 与请求使用同一身份；环境 token 在中途变化不会串用。
- 数据缓存 key 包含来源与凭证摘要；TTL 60 秒，远程检测 10 分钟，缓存上限 200 条。
- 匿名 REST 限制 60 次/小时；`checks` 与 `status` 两个来源同时读取，避免 legacy commit status 被 check-runs 覆盖。

## 安全设计

- **HTTP 路由**：DSH 的 Web 服务器不校验 cookie/Host/Origin，因此插件自行校验。`Origin` 必须与 `Host` 一致（含协议），`Sec-Fetch-Site: cross-site` 拒绝，`Host` 只能是指定地址或 loopback 写法；均为 403。
- **绑定地址**：路由只在 loopback 绑定时提供服务；非 loopback 或无法确认绑定时返回 403（agent 工具不受影响）。
- **`dir=` 限定**：用 `realpath` 规范化并比对工作区注册表；解析后再次校验；Windows UNC/设备路径在触发网络查询前拒绝；拒绝消息统一，避免暴露文件是否存在；注册表不可用时 fail closed。
- **仓库名校验**：`owner/repo` 只接受字母数字、点、短横线、下划线，拒绝前导 `-`/`@` 与裸 `..`，防止 `gh -F name=@path` 读取本地文件，以及 `..` 重定向 API 路径。
- **渲染**：卡片 HTML 在进入无头浏览器前转义；`file://` 页面中的脚本可读本地文件，因此不注入原始 HTML。数字、编号等字段也转义。
- **API 路径**：按段校验，拒绝 `%2e%2e`、反斜杠、`?`、`#` 等可能重定向路径的字符。
- **面板**：正文与评论通过 React 元素渲染，从不使用 `innerHTML`；链接与图片经过协议白名单（`http`、`https`、`mailto`、`#`、`data:image/*`）。
