# mssh

基于 Electron + React + TypeScript 的 SSH & SFTP 桌面客户端，支持多主题、多语言、双栏文件管理、远程编辑、资源监控与自动更新。

## ✨ 功能特性

### 终端
- 基于 xterm.js 的高性能终端
- 支持 password / keyboard-interactive / 公私钥 三种认证方式
- 右键复制 / 粘贴，支持 **Ctrl+Shift+C / Ctrl+Shift+V** 快捷键
- 多行粘贴自动使用 bracketed paste mode，避免误执行
- 连接状态可视化（连接中 / 已连接 / 错误 / 已断开 + 重连）

### SFTP 文件管理
- **双栏布局**：本地 ↔ 远程，拖拽互传
- **传输队列**：进度条 + 速度 + 已传/总量，可取消
- **远程文本编辑**：右键/工具栏打开编辑器，Ctrl+S 保存，2MB 上限，二进制自动拒绝
- **新建文件/文件夹**：工具栏 + 空白右键菜单
- **解压**：支持 zip / tar / tar.gz / tar.bz2 / tar.xz / 7z / gz / bz2 / xz，远程走 SSH 命令，本地走系统工具
- 文件过滤（全部 / 文档 / 图片 / 压缩包）、排序、路径导航、桌面快捷跳转

### Docker 管理
- 终端工具栏一键打开 **Docker 管理面板**（独立标签页，与终端/SFTP 共享同一 SSH 会话）
- **容器列表**：名称 / 镜像 / 状态 / 端口映射，状态点颜色区分（运行中绿 / 暂停黄 / 停止灰）
- **镜像列表**：仓库 / 标签 / 镜像 ID / 大小
- **右键菜单**：启动 / 停止 / 重启容器（危险操作二次确认），操作成功后自动刷新
- **容器日志**：双击或右键查看，支持跟随模式（`docker logs -f` 实时流式输出、自动滚底）与快照模式（最近 1000 行），可随时刷新
- **Docker Compose 一键启动**：浏览远程文件系统选择 compose 文件（仅显示目录与 yml/yaml），在其目录执行 `docker compose up -d`（自动回退 `docker-compose`），实时流式显示拉取/启动输出，完成后自动刷新容器列表
- 自动检测 Docker 可用性，未安装或无权限时给出对应处理提示
- 断开 SSH 连接时同步关闭该连接下的所有标签（终端 / SFTP / Docker / Cron）

### 定时任务管理
- 终端工具栏一键打开 **Cron 管理面板**（独立标签页，共享同一 SSH 会话，管理当前连接用户的 crontab）
- **任务列表**：状态点（启用中 / 已禁用）+ 任务备注 / 执行周期 / 命令
- **新建 / 编辑**：任务名称（备注）、执行周期（预设每分钟 / 每小时 / 每天 / 每周 / 每月 / 重启时 + 自定义 5 字段表达式）、命令
- **选择脚本**：浏览远程文件系统选择脚本文件（仅显示目录与常见脚本 / 可执行文件），按后缀自动生成执行命令（`.sh` 用 bash、`.py` 用 python3、`.js` 用 node 等，其他可执行文件直接执行）
- **右键菜单**：编辑 / 启用 / 禁用（注释切换）/ 删除（危险操作二次确认），双击编辑
- 写回时保留 crontab 中的环境变量（`MAILTO=` 等）与原有结构，保存后 cron 守护进程自动加载
- 解析 `@reboot` / `@hourly` 等特殊表达式与被注释掉的禁用任务行

### 连接管理
- 连接列表分组（拖拽创建分组）
- 密码 / 私钥通过 `safeStorage` 加密存储
- 右键菜单：连接 / 编辑 / 创建副本 / 删除
- 快速连接弹窗

### 系统监控
- 连接成功后状态栏实时显示远程 **CPU / 内存 / 磁盘** 占用（5 秒轮询）
- 阈值颜色变化：<70% 青、70-90% 黄、≥90% 红

### 设置弹窗
- **通用**：语言、主题、启动恢复会话、自动检查更新、打开数据目录
- **终端**：字体、字号、光标样式（块/下划线/竖线）、光标闪烁、滚动回滚行数、铃声
- **SSH**：keepalive 间隔、连接超时、压缩传输
- 设置通过主进程 `safeStorage` 持久化

### 会话恢复
- 启动时自动恢复上次的连接标签（终端 / SFTP / Docker / Cron），可在设置中开关

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

脚本会自动：校验 git 工作区 → 更新 `package.json` 版本 → 提交 → 打 annotated tag → 推送分支与 tag → 触发 GitHub Actions 三平台打包并上传到 Releases。

## 📁 项目结构

```
mssh/
├── electron/                  # 主进程
│   ├── ipc/                   # IPC handler（连接/SFTP/本地文件/设置/更新）
│   ├── services/              # sshService / sftpService / localFs / configStore / autoUpdate
│   ├── shared/api.ts          # 渲染进程可调用的 API 类型声明
│   ├── preload.ts             # 上下文桥接
│   └── main.ts                # 应用入口
├── src/                       # 渲染进程
│   ├── components/ui/         # 通用组件库
│   ├── i18n/                  # 国际化（zh-CN / en-US）
│   ├── layouts/               # 主布局 / 侧栏 / 标签栏 / 状态栏 / 标题栏
│   ├── pages/
│   │   ├── connect/           # 新建连接 / 快速连接
│   │   ├── terminal/          # 终端视图
│   │   ├── sftp/              # SFTP 双栏 / 文件面板 / 编辑器 / 传输队列
│   │   ├── docker/            # Docker 管理面板（容器 / 镜像 / 日志 / Compose）
│   │   ├── cron/              # 定时任务管理面板（crontab 增删改 / 脚本选择）
│   │   └── settings/          # 设置弹窗（通用 / 终端 / SSH）
│   ├── stores/                # Zustand 状态
│   ├── styles/                # tokens.css（设计令牌）/ base.css
│   └── utils/                 # 文件工具 / 终端主题
├── scripts/release.mjs        # 发版脚本
├── .github/workflows/         # CI 工作流
└── electron-builder.json5     # 打包配置
```

## ⚠️ 已知限制

- 远程解压依赖服务器已安装对应工具（tar / unzip / 7z）
- 本地 `.7z` 解压需要系统安装 7-Zip 并加入 PATH
- 自动更新仅在打包版本中生效，`pnpm dev` 下会跳过
