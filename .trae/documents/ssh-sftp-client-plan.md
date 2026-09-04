# mssh — Electron SSH+SFTP 客户端实施计划

## 一、概述

基于现有 electron-vite + React 18 + TypeScript 模板，从零实现一个完整的 SSH+SFTP 桌面客户端：

- **多主题**：暗色 / 亮色双主题（CSS 变量令牌体系，可扩展），严格按设计图配色（近黑底 + 绿色强调 #22c55e 系 / 白底 + 绿色强调）
- **多语言**：简体中文 / English，自研轻量 i18n（Context + 字典），设置页可切换
- **SSH 终端**：主进程 `ssh2`（纯 JS，无原生编译，利于打包）+ 渲染进程 `@xterm/xterm`
- **SFTP 双面板**：本地 / 远程文件管理，拖拽上传/下载、传输队列进度
- **全局通用组件封装**：Modal、Message、Table、Button、Input、Select、Switch、Segmented、Tabs、ContextMenu、Dropdown、Progress、Empty、Tooltip 等，保证一致性
- **界面 1:1 参照设计图**：左侧栏（logo/搜索/快速连接/连接分组/主题切换/设置）、标签页栏、新建连接弹窗、设置弹窗、SFTP 双栏、底部状态栏（SSH2 | 加密算法 | host:port | UTF-8）

## 二、现状分析

| 项 | 现状 |
|---|---|
| 脚手架 | electron-vite 模板（vite-plugin-electron），React 18.2，TS 5.2，Electron 30，electron-builder 24 |
| 业务代码 | 无（App.tsx 为官方计数器 Demo，需清理） |
| 依赖 | 仅 react/react-dom，无 ssh2/xterm/状态管理 |
| pnpm | 已配置 .npmrc 代理（127.0.0.1:10808），workspace allowBuilds 关闭了 electron/esbuild 构建钩子 |
| 主进程 | 默认 main.ts（创建窗口+加载页面），preload 暴露了裸 ipcRenderer |

**关键决策（假设，如不符请指出）**：
1. SSH 库用 `ssh2`（纯 JS）而非 node-pty+系统 ssh —— 避免 Windows 原生编译问题，且天然集成 SFTP 子系统
2. 多主题 = 暗/亮双主题（设计图 4 所示），通过 CSS 变量可继续扩展；强调色绿色
3. 多语言 = zh-CN + en-US，字典式可扩展
4. 不引入 UI 组件库（antd 等），全部自研以匹配设计图并满足"全局组件封装一致性"要求
5. 状态管理用 `zustand`（轻量）
6. 数据持久化：`~/.ssh-hub/` 目录（设计图设置页所示），JSON 存储；密码用 Electron `safeStorage` 加密，不可用时降级 base64 混淆
7. 拖拽上传：渲染进程通过 `webUtils.getPathForFile()`（Electron 30 支持）获取拖入文件真实路径，交给主进程 sftp.fastPut；面板间拖拽=上传/下载

## 三、新增依赖

```
pnpm add ssh2 zustand
pnpm add -D @types/ssh2 @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

## 四、目录结构（最终形态）

```
electron/                        # 主进程
  main.ts                        # 窗口创建(无边框+自定义标题栏)、IPC 注册入口
  preload.ts                     # contextBridge 暴露类型化 api
  ipc/
    index.ts                     # 统一注册所有 handler
    appIpc.ts                    # 窗口控制(min/max/close)、打开目录
    configIpc.ts                 # 设置/连接/分组的读写
    sshIpc.ts                    # ssh 连接生命周期
    sftpIpc.ts                   # 远程文件操作
    localFsIpc.ts                # 本地文件操作
  services/
    configStore.ts               # ~/.ssh-hub/config.json 读写 + safeStorage 加密
    sshService.ts                # ssh2 连接池: connect/write/resize/close, shell 流转发
    sftpService.ts               # sftp 子系统: list/mkdir/rm/rename/stat/upload/download(进度事件)
    localFs.ts                   # 本地 list/mkdir/rm/rename/驱动器列表
  shared/
    types.ts                     # 主/渲染共享类型(Connection/Group/Settings/FileInfo/TransferItem)

src/
  main.tsx
  App.tsx                        # Provider 装配 + MainLayout
  styles/
    tokens.css                   # 主题 CSS 变量(dark/light 两套令牌)
    base.css                     # reset、滚动条、全局样式
  theme/ThemeProvider.tsx        # 主题状态(持久化, html[data-theme])
  i18n/
    I18nProvider.tsx             # t() 函数、语言切换、按 app.getLocale() 初始化
    zh-CN.ts / en-US.ts          # 字典
  components/ui/                 # ★ 全局通用组件库（一致性核心）
    Button.tsx  Input.tsx  Select.tsx  Switch.tsx  Segmented.tsx
    Modal.tsx  Message.tsx  Confirm.tsx  Table.tsx  Tabs.tsx
    ContextMenu.tsx  Dropdown.tsx  Progress.tsx  Empty.tsx  Tooltip.tsx
    index.ts                     # 统一导出
  layouts/
    MainLayout.tsx               # 标题栏+侧栏+标签区+状态栏 整体骨架
    TitleBar.tsx                 # 自定义标题栏(拖拽区+窗口控制按钮)
    Sidebar.tsx                  # logo/搜索/快速连接/连接树/主题切换/设置入口
    TabBar.tsx                   # 会话标签(终端/SFTP 类型图标、+、×)
    StatusBar.tsx                # SSH2 | cipher | host:port | UTF-8
  stores/
    appStore.ts                  # zustand: 设置/主题/语言
    connStore.ts                 # 连接与分组、侧栏树
    sessionStore.ts              # 会话标签(tab)与激活态、ssh 会话状态
    transferStore.ts             # 传输队列
  pages/
    connect/NewConnectionModal.tsx   # 新建/编辑连接弹窗(设计图1)
    connect/QuickConnectModal.tsx    # 快速连接
    terminal/TerminalView.tsx        # xterm 终端 + 工具条(上传/下载/断开)
    terminal/Terminal.tsx            # xterm 封装(fit/web-links/IME)
    sftp/SftpView.tsx                # 双栏容器+传输队列
    sftp/FilePane.tsx                # 单侧文件面板(列表/筛选/拖拽/右键菜单)
    sftp/TransferQueue.tsx           # 传输队列面板
    settings/SettingsModal.tsx       # 设置弹窗(通用/终端/SSH 三节)
```

## 五、设计系统（tokens.css）

按设计图取色的双主题令牌，所有组件只允许用令牌：

```css
:root[data-theme='dark'] {
  --bg: #0b0f0c;            /* 主背景(近黑) */
  --bg-panel: #111712;      /* 侧栏/面板 */
  --bg-elevated: #161d17;   /* 弹窗/浮层 */
  --bg-hover: #1c2620;      /* hover */
  --border: #232d26;
  --accent: #22c55e;        /* 绿色强调 */
  --accent-strong: #16a34a;
  --text: #d6e2d8;  --text-dim: #7d8c80;  --danger: #ef4444;
  --term-bg: #0a0e0b; --term-fg: #4ade80;
}
:root[data-theme='light'] {
  --bg: #f6f8f6; --bg-panel: #ffffff; --bg-elevated: #ffffff;
  --bg-hover: #eef3ee; --border: #e2e8e2;
  --accent: #16a34a; --accent-strong: #15803d;
  --text: #1a2420; --text-dim: #6b7a6e; --danger: #dc2626;
  --term-bg: #0a0e0b; --term-fg: #4ade80;   /* 终端区保持暗色对比(参照设计) */
}
```

## 六、IPC 通道设计（主↔渲染）

| 通道 | 方向 | 用途 |
|---|---|---|
| `ssh:connect` | invoke | 建立 SSH，返回 sessionId；成功事件回传 cipher/kex 等供状态栏 |
| `ssh:data` / `ssh:exit` | main→renderer（按 sessionId） | 终端输出流 / 会话关闭 |
| `ssh:write` `ssh:resize` `ssh:disconnect` | invoke | 终端输入 / 尺寸 / 断开 |
| `sftp:list` `sftp:mkdir` `sftp:rm` `sftp:rename` `sftp:stat` `sftp:realpath` | invoke | 远程文件操作 |
| `sftp:upload` `sftp:download` | invoke | 传输（返回 transferId） |
| `transfer:progress` `transfer:done` `transfer:error` | main→renderer | 传输队列进度 |
| `local:list` `local:home` `local:drives` `local:mkdir` `local:rm` `local:rename` | invoke | 本地面板（Windows 盘符列表） |
| `config:getAll` `config:saveSettings` `conn:save` `conn:delete` `group:save` `group:delete` | invoke | 持久化 |
| `win:min` `win:max` `win:close` `shell:openPath` | invoke | 自定义标题栏/打开数据目录 |

preload 用 `contextBridge` 暴露类型化 `window.api`（不再暴露裸 ipcRenderer，收紧安全面）。

## 七、功能实现要点（对照设计图）

### 1. 左侧栏（两图一致）
- Logo「mssh」（终端图标+绿色）、服务器名搜索框（实时过滤连接树）
- 绿色「+ 快速连接」按钮 → QuickConnectModal
- 「连接」分区头 +「+」（新建连接/新建分组菜单）
- 分组（生产环境/测试环境）可折叠，子项带状态圆点（绿=已连接），右键菜单：连接/编辑/复制/删除
- 底部「暗色模式/亮色模式」切换（Switch）、「设置」→ SettingsModal

### 2. 标签页 + 终端（图1）
- TabBar：`▷ web-prod-01`（终端）、`▢ SFTP` 两类标签，×关闭，+新建连接
- 终端工具行：`root@192.168.1.100:22` 连接信息；右侧 ⤴上传 ⤵下载 ⏻断开（红）按钮——上传/下载在终端页触发时自动切换到 SFTP 标签
- xterm.js：fit 自适应、web-links、中文 IME 原生支持、主题色绑定 tokens、断线自动提示可重连
- StatusBar：`SSH2 | aes256-ctr | 192.168.1.100:22 | UTF-8`（cipher 取自 ssh2 握手信息）

### 3. SFTP 双栏（图2）
- 左「本地文件」（默认用户目录，Windows 列盘符）、右「远程文件 → /home/www」（路径可编辑回车跳转）
- 筛选 chips：全部/文档/图片/压缩包（按扩展名过滤当前列表）
- 文件行：图标+名称；双击进目录；单击多选(Ctrl/Shift)；右键 ContextMenu（打开/重命名/删除/新建文件夹/刷新/上传/下载）
- **拖拽**：OS 文件拖入右栏=上传；右栏拖到左栏=下载；面板内高亮提示
- 底部「传输队列」：文件名、方向、进度条、速度、状态；空闲时显示提示文案（如图）

### 4. 新建连接弹窗（图1）
字段：连接名称(例:生产服务器)、主机地址、端口(默认22)+用户名(默认root)、认证方式 Segmented(密码/密钥)、密码(可见性眼睛) 或 私钥路径(文件选择)+口令；可选分组；取消/连接。编辑模式复用同一弹窗。

### 5. 设置弹窗（图3）
- 左侧导航：通用/终端/SSH
- 通用：界面语言 Select(简体中文/English)、启动时恢复上次会话 Switch、自动检查更新 Switch、数据目录 `~/.ssh-hub/`（可打开）
- 终端：字体、字号、光标样式、回滚行数、响铃
- SSH：keepalive 间隔、连接超时、压缩
- 取消/保存，保存后即时生效（语言/主题热切换）

### 6. 会话恢复
`~/.ssh-hub/layout.json` 记录打开的标签及顺序、激活标签；勾选"恢复上次会话"时启动重建标签（SSH 自动重连）。

## 八、全局组件封装规范（一致性）

- 全部基于 tokens.css 令牌，禁止硬编码色值
- `Modal`：统一遮罩/圆角/头部/关闭钮/底部按钮区，`Confirm` 基于 Modal 提供 `confirm()` 命令式 API（删除连接、删除文件等均用）
- `Message`：命令式 `message.success/error/warning/info`，顶部居中堆叠、自动消失、带类型图标
- `Table`：泛型列定义、排序、空态、行选择（用于传输队列与设置页数据展示）
- `Select`/`Dropdown`/`ContextMenu`：统一用浮层定位工具（getBoundingClientRect 计算，弹窗内自动翻转）
- `Segmented`（密码/密钥切换）、`Switch`（设置页/侧栏主题切换）均按设计图样式实现

## 九、实施步骤（Todo 顺序）

1. **依赖与清理**：安装依赖；删除模板 Demo（App.css/assets/react.svg、public 演示文件引用）；electron-builder.json5 修正 appId/productName=mssh
2. **设计系统**：tokens.css + base.css + ThemeProvider（暗/亮切换持久化）
3. **i18n**：I18nProvider + zh-CN/en-US 字典 + t()
4. **UI 组件库**：按第八节清单逐一实现（含样式）
5. **主进程基础**：shared/types、configStore(safeStorage 加密)、localFs、IPC 注册、preload 类型化 api
6. **布局骨架**：TitleBar(无边框窗口控制)、Sidebar、TabBar、StatusBar、MainLayout、zustand 三 store
7. **连接管理**：Sidebar 连接树/搜索/分组/右键菜单、NewConnectionModal、QuickConnectModal
8. **SSH+终端**：sshService、Terminal.tsx(xterm)、TerminalView、StatusBar cipher 显示
9. **SFTP**：sftpService、SftpView 双栏、FilePane(列表/导航/筛选/右键/多选)
10. **拖拽+传输队列**：webUtils 路径获取、双向拖拽、TransferQueue 进度渲染
11. **设置弹窗**：三节设置项、保存热生效（语言/主题/终端配置实时应用）
12. **会话恢复 + 收尾**：layout.json、空态、错误提示、快捷键(Ctrl+T 新标签等)
13. **验证**：`pnpm dev` 全流程手测（连真实 sshd 或本地测试服），`pnpm build` 打包通过

## 十、验证方式

1. `pnpm dev` 启动，核对三个设计图场景：新建连接弹窗、SFTP 双栏、设置弹窗，暗/亮两主题逐一比对
2. 语言切换：设置页切 English，全部界面文案（含弹窗、菜单、状态栏）无遗漏中文硬编码
3. 连接真实 Linux 主机：终端交互/中文输出/resize；SFTP 上传（拖 OS 文件）、下载（拖到本地栏）、进度条、断点提示
4. 删除类操作全部走 Confirm 弹窗；Message 提示各类型正常
5. `pnpm build` 产物安装后可运行
