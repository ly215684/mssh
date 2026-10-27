# mssh

基于 Electron + React + TypeScript 的多协议远程连接客户端，支持 SSH / Telnet / VNC、SFTP 双栏文件管理、远程编辑、Docker / 定时任务管理、AI 运维助手（对话 / 代理双模式，内置 MCP 服务）、资源监控面板、系统管理（systemd / 软件包 / 防火墙）与自动更新。

## ✨ 功能特性

### 终端
- 基于 xterm.js 的高性能终端，支持 **SSH / Telnet** 两种协议（Telnet 默认端口 23）
- SSH 支持 password / keyboard-interactive / 公私钥 三种认证方式
- Telnet 支持 IAC 选项协商；用户名/密码留空时在终端交互登录，填写后自动应答 login / password 提示
- Telnet 连接自动隐藏 SFTP / Docker / 定时任务等依赖 SSH 通道的入口
- **X11 转发**：可按连接开启，远程 GUI 程序直接显示到本地；连接成功后自动探测本地 X 服务器并给出排查提示，显示地址可在 设置 → SSH 中调整（Windows 需运行 VcXsrv / Xming）
- 右键复制 / 粘贴，支持 **Ctrl+Shift+C / Ctrl+Shift+V** 快捷键
- 多行粘贴自动使用 bracketed paste mode，避免误执行
- 连接状态可视化（连接中 / 已连接 / 错误 / 已断开 + 自动重连）

### VNC 远程桌面
- 新建连接时选择 **VNC** 协议（默认端口 5900），密码直连 VNC 服务器
- 基于 noVNC 渲染远程桌面，主进程内置 WebSocket → TCP 桥接（仅监听 `127.0.0.1` 随机端口）
- 工具栏支持发送 **Ctrl+Alt+Del**、适应窗口 / 原始大小切换、**只读模式**、断开
- 远程剪贴板内容自动同步到本地
- 连接状态、自动重连、断线原因展示与终端共用一套逻辑

### SFTP 文件管理
- **双栏布局**：本地 ↔ 远程，拖拽互传
- **传输队列**：进度条 + 速度 + 已传/总量，可取消
- **断点续传**：上传 / 下载按目标端已有文件大小从断点续写，中断后重新发起即可接着传
- **传输限速**：可在 设置 → SSH 中为单个传输任务设置速度上限（KB/s，0 为不限速）
- **打包传输**：右键本地文件/目录「打包上传（tar.gz）」，或右键远程文件/目录「打包下载（tar.gz）」，自动打包、传输、解压并清理临时压缩包；远程缺少 tar 时会询问是否一键安装并自动续做
- **远程文本编辑**：右键/工具栏打开编辑器，Ctrl+S 保存，文件上限可配置（默认 2MB），二进制自动拒绝
- **同目录快速切换**：编辑器右侧列出同目录可编辑文件，点击即可切换；各文件内容与未保存修改独立保留，关闭前二次确认
- **粘贴规范化**：自动统一换行、空格与缩进；Makefile 类文件（`Makefile` / `*.mk` 等）保留 Tab 与行尾空白
- **批量操作**：多选删除 / 移动，右键「添加执行权限」批量 `chmod +x`
- **新建文件/文件夹**：工具栏 + 空白右键菜单
- **解压**：支持 zip / tar / tar.gz / tar.bz2 / tar.xz / 7z / gz / bz2 / xz，远程走 SSH 命令，本地走系统工具；远程 zip 解压前自动检测 unzip，缺失时可一键流式安装
- 文件过滤（全部 / 文档 / 图片 / 压缩包）、排序、路径导航、桌面快捷跳转

### Docker 管理
- 终端工具栏一键打开 **Docker 管理面板**（独立标签页，与终端/SFTP 共享同一 SSH 会话）
- **容器列表**：名称 / 镜像 / 状态 / **CPU** / **内存** / 端口映射，状态点颜色区分（运行中绿 / 暂停黄 / 停止灰）
- **镜像列表**：仓库 / 标签 / 镜像 ID / 大小
- **容器操作**：右键启动 / 停止 / 重启 / 查看日志 / 删除（危险操作二次确认）；删除运行中容器会自动强制停止，并可选择同时删除其镜像
- **镜像操作**：右键从镜像启动容器或删除镜像
- **拉取镜像**：输入镜像名执行 `docker pull`，实时流式显示拉取进度
- **从镜像启动容器**：表单配置容器名 / 端口映射 / 环境变量 / 卷挂载 / 后台运行 / 启动命令 / 额外参数，流式展示结果
- **容器日志**：双击或右键查看，支持跟随模式（`docker logs -f` 实时流式输出、自动滚底）与快照模式（最近 1000 行），可随时刷新
- **Docker Compose 一键启动**：浏览远程文件系统选择 compose 文件（仅显示目录与 yml/yaml），在其目录执行 `docker compose up -d`（自动回退 `docker-compose`），实时流式显示拉取/启动输出，完成后自动刷新容器列表
- 自动检测 Docker 可用性，未安装或无权限时给出对应处理提示；未安装时支持**一键安装**（自动识别 Ubuntu / Debian / CentOS / RHEL / Fedora / Alpine / Arch 等系统，区分 root 与免密 sudo，流式展示安装日志）
- 断开 SSH 连接时同步关闭该连接下的所有标签（终端 / SFTP / Docker / Cron / VNC / 监控 / 系统管理）

### 定时任务管理
- 终端工具栏一键打开 **Cron 管理面板**（独立标签页，共享同一 SSH 会话，管理当前连接用户的 crontab）
- **任务列表**：状态点（启用中 / 已禁用）+ 任务备注 / 执行周期 / 命令
- **新建 / 编辑**：任务名称（备注）、执行周期（预设每分钟 / 每小时 / 每天 / 每周 / 每月 / 重启时 + 自定义 5 字段表达式）、命令；自定义周期的数值输入支持聚焦自由编辑、范围自动修正与失焦回退
- **选择脚本**：浏览远程文件系统选择脚本文件（仅显示目录与常见脚本 / 可执行文件），按后缀自动生成执行命令（`.sh` 用 bash、`.py` 用 python3、`.js` 用 node 等，其他可执行文件直接执行）
- **右键菜单**：编辑 / 启用 / 禁用（注释切换）/ 删除（危险操作二次确认），双击编辑
- 写回时保留 crontab 中的环境变量（`MAILTO=` 等）与原有结构，保存后 cron 守护进程自动加载
- 解析 `@reboot` / `@hourly` 等特殊表达式与被注释掉的禁用任务行

### AI 运维助手
- 终端工具栏一键打开 **AI 助手**（与 Docker / 定时任务按钮同排），面板悬浮在终端右侧，不占用标签页，仅在终端页面显示
- **两种模式**（设置 → AI 助手切换，默认 **对话模式**；顶栏实时显示当前模式）：
  - **对话模式**：只对话、不操作服务器，仅提供建议与命令文本，可一键复制后自行执行
  - **代理模式**：AI 可调用 MCP 工具直接操作当前终端所在的服务器；**每次工具调用都弹出确认卡片，由用户点击「允许」后才会执行**，拒绝则把结果回填给模型继续对话
- **内置 MCP 服务**：进程内实现的 JSON-RPC 2.0 服务（`initialize` / `tools/list` / `tools/call`），提供 4 个工具——`run_command`（执行命令，需确认）、`write_file`（写入文件，需确认）、`read_file`、`list_directory`；工具执行结果（退出码 / stdout / stderr / 文件内容截断）显示在工具卡片并回传给模型；工具调用轮次不设上限，直到模型不再调用工具或用户点击停止
- 代理模式绑定当前终端会话，未连接 SSH 时禁止发送并提示先建立连接；点击「停止」会中止生成并把未决的工具调用按拒绝处理
- **主流大模型**：内置 DeepSeek、OpenAI、Kimi（Moonshot）、通义千问、智谱 GLM、豆包（火山方舟）、硅基流动预设，也支持任意 OpenAI 兼容接口（自定义 Base URL / 模型名）
- **流式对话**：SSE 实时输出，可随时停止、失败重试、重新生成
- **多会话管理**：新建 / 切换 / 删除，历史记录本地持久化，自动携带最近 40 条上下文 + 自定义系统提示词
- **Markdown 渲染**：标题、列表、表格等基础语法，**代码块（命令）一键复制**，整条回复也可复制
- **设置页测试连接**：保存前即可验证 Key / 接口 / 模型是否可用，针对超时、代理、域名解析等网络问题给出中文排查提示
- API Key 经系统 `safeStorage` 加密存储；请求由主进程代理（Chromium 网络栈，自动遵循系统代理，无 CORS 问题）
- 空会话内置运维场景快捷提问（查磁盘、找大文件、看端口、看 CPU 进程）

### 连接管理
- **多协议**：SSH / Telnet / VNC，切换协议时自动联动默认端口（22 / 23 / 5900）
- Telnet 可留空用户名/密码在终端交互登录，VNC 仅需主机与端口（可选密码）
- SSH 连接可按需开启 **X11 转发**
- 连接列表分组（拖拽创建分组）
- 密码 / 私钥通过 `safeStorage` 加密存储
- 右键菜单：连接 / 编辑 / 创建副本 / 删除
- 快速连接弹窗

### 资源监控
- 终端工具栏一键打开 **监控面板**（独立标签页，共享同一 SSH 会话），默认 **2 秒** 实时采样，可暂停
- **概览卡片**：CPU / 内存 / Swap / 网络上下行速率，均为带渐变趋势的曲线图；CPU 区展示负载与核心数
- **磁盘**：按挂载点列出各分区容量与占用进度条
- **进程管理**：进程表显示 PID / 用户 / CPU% / 内存% / 常驻内存 / 状态 / 运行时长 / 命令，可按 CPU / 内存 / PID 排序，支持搜索并按 PID 或命令结束进程（先 SIGTERM，失败再 SIGKILL，二次确认）
- SSH 连接成功后状态栏也实时显示远程 **CPU / 内存 / 磁盘** 占用（10 秒轮询，失败自动退避）
- 阈值颜色变化：<70% 青、70-90% 黄、≥90% 红

### 系统管理
- 终端工具栏一键打开 **系统管理面板**（独立标签页，共享同一 SSH 会话），包含服务 / 软件包 / 防火墙三个标签页
- **systemd 服务**：列出全部 service 单元（名称 / 状态 / 子状态 / 描述），支持搜索、启动 / 停止 / 重启 / 开机自启切换与查看日志（`journalctl -u` 最近 300 行）
- **软件包管理**：自动识别 apt / dnf / yum / apk / pacman / zypper，列出已安装软件包（名称 / 版本，列表超 3000 项时提示用搜索缩小范围），支持按名称安装 / 卸载与刷新软件源索引
- **防火墙**：自动识别 ufw / firewalld / nft / iptables 并展示规则（ufw 为编号规则列表，可直接删除；其余展示原始输出），支持放行指定端口（TCP / UDP）写入对应工具规则
- 危险操作二次确认，执行过程与安装/卸载日志流式展示；非 root 用户自动使用 `sudo -n`（需已配置免密 sudo）

### 设置弹窗
- **通用**：语言、主题、启动恢复会话、自动检查更新、打开数据目录
- **终端**：字体、字号、光标样式（块/下划线/竖线）、光标闪烁、滚动回滚行数、编辑器文件上限、铃声
- **SSH**：keepalive 间隔、连接超时、压缩传输、传输并发数、传输限速、X11 显示地址
- **AI 助手**：模式（对话 / 代理）、服务商预设、API Key、接口地址、模型名、系统提示词、测试连接
- 设置通过主进程 `safeStorage` 持久化（含 API Key 加密）

### 会话恢复
- 启动时自动恢复上次的连接标签（终端 / SFTP / Docker / Cron / VNC / 监控 / 系统管理），可在设置中开关

### 其它
- **多主题**：深色 / 浅色，CSS 变量 + Tailwind v4
- **多语言**：中文 / 英文
- **自动更新**：基于 electron-updater，差量更新（blockmap）
- **全局组件库**：Modal / Input / Button / Table / Message / Confirm / ContextMenu / Tooltip

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换下一个 / 上一个标签 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+N` | 新建连接 |
| `Ctrl+,` | 打开设置 |
| `Ctrl+Shift+C` | 终端：复制选中 |
| `Ctrl+Shift+V` | 终端：粘贴 |
| `Ctrl+S` | 文件编辑器：保存 |

> 终端内的 `Ctrl+W` 等按键会透传给 shell，不会触发关闭标签。

## 🛠 技术栈

| 层级 | 技术 |
|---|---|
| 桌面框架 | Electron 30 |
| 前端 | React 18 + TypeScript |
| 样式 | Tailwind CSS v4（CSS 变量主题） |
| 状态管理 | Zustand |
| 终端 | xterm.js + addon-fit / addon-web-links |
| SSH/SFTP | ssh2 |
| Telnet | 自研 Telnet 服务（IAC 协商 / 自动登录） |
| VNC | noVNC + ws（主进程 WebSocket → TCP 桥） |
| 编辑器 | Monaco Editor |
| 构建 | Vite 5 + vite-plugin-electron |
| 打包 | electron-builder |
| 自动更新 | electron-updater |
| CI | GitHub Actions（Windows / Linux / macOS） |

## 🚀 开发

```bash
# 安装依赖
pnpm install

# 启动开发模式
pnpm dev
```

## 📦 构建

```bash
# 本地打包（生成当前平台安装包）
pnpm build
```

## 🏷 发版

```bash
# patch 版本（默认）
pnpm release
# minor / major
pnpm release minor
pnpm release major
# 或指定具体版本
pnpm release 1.2.3
```

脚本会自动：校验 git 工作区 → 更新 `package.json` 版本 → 提交 → 打 annotated tag → 推送分支与 tag → 触发 GitHub Actions 三平台打包并上传到 Releases，同时自动生成发布日志附加到 Release。

## 📁 项目结构

```
mssh/
├── electron/                  # 主进程
│   ├── ipc/                   # IPC handler（连接/SFTP/本地文件/设置/更新/AI）
│   ├── services/              # sshService / telnetService / vncService / sftpService / localFs / configStore / aiService / mcpService / autoUpdate
│   ├── shims/                 # ws 原生可选依赖的 CJS 桩（bufferutil / utf-8-validate）
│   ├── shared/api.ts          # 渲染进程可调用的 API 类型声明
│   ├── preload.ts             # 上下文桥接
│   └── main.ts                # 应用入口
├── src/                       # 渲染进程
│   ├── components/ui/         # 通用组件库
│   ├── i18n/                  # 国际化（zh-CN / en-US）
│   ├── layouts/               # 主布局 / 侧栏 / 标签栏 / 状态栏 / 标题栏
│   ├── pages/
│   │   ├── connect/           # 新建连接 / 快速连接
│   │   ├── terminal/          # 终端视图（SSH / Telnet）
│   │   ├── vnc/               # VNC 远程桌面视图（noVNC）
│   │   ├── sftp/              # SFTP 双栏 / 文件面板 / 编辑器 / 传输队列
│   │   ├── docker/            # Docker 管理面板（容器 / 镜像 / 日志 / Compose）
│   │   ├── cron/              # 定时任务管理面板（crontab 增删改 / 脚本选择）
│   │   ├── monitor/           # 资源监控面板（指标曲线 / 磁盘 / 进程管理）
│   │   ├── system/            # 系统管理面板（systemd / 软件包 / 防火墙）
│   │   ├── ai/                # AI 助手悬浮面板（双模式 / 工具审批卡片 / 流式对话 / Markdown 渲染）
│   │   └── settings/          # 设置弹窗（通用 / 终端 / SSH / AI）
│   ├── stores/                # Zustand 状态
│   ├── styles/                # tokens.css（设计令牌）/ base.css
│   └── utils/                 # 文件工具 / 终端主题
├── scripts/release.mjs        # 发版脚本
├── .github/workflows/         # CI 工作流
└── electron-builder.json5     # 打包配置
```

## ⚠️ 已知限制

- 远程解压依赖服务器已安装对应工具（tar / unzip / 7z），zip 缺失时可一键安装
- 本地 `.7z` 解压需要系统安装 7-Zip 并加入 PATH
- Telnet 不支持 SFTP / Docker / 定时任务 / 资源监控 / 系统管理；VNC 仅提供远程桌面，不提供文件传输与命令执行
- 使用 VNC 需服务器已启动 VNC 服务（如 TigerVNC / RealVNC）并开放对应端口
- X11 转发需要本地运行 X 服务器（Windows：VcXsrv / Xming），且服务器开启 `X11Forwarding`
- AI 助手不内置模型额度，需自行准备兼容 OpenAI 接口的 API Key
- AI 代理模式只能操作当前终端所在的 SSH 会话（不支持 Telnet / VNC），且需逐个确认工具调用；内置 MCP 工具仅包含命令执行与文件读写/列目录，不含交互式命令（如 `top`、`vim`）
- 监控面板与状态栏指标依赖 Linux 的 `/proc` 与 `ps` / `df`，非 Linux 系统可能无法采集
- 系统管理面板依赖目标系统的 systemd / 包管理器 / 防火墙工具，非 root 执行需已配置免密 `sudo`
- 打包上传 / 下载依赖远程 `tar`（缺失时可一键安装）；断点续传仅当目标端同名文件小于源文件时生效，否则从头写入
- 自动更新仅在打包版本中生效，`pnpm dev` 下会跳过
