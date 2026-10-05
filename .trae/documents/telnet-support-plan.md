# 支持 Telnet 连接

## Context

mssh 目前仅支持 SSH 协议。Telnet 仍广泛用于网络设备（交换机/路由器）与老旧主机的管理，用户希望同一客户端内直接发起 Telnet 连接。Telnet 无加密、无 SFTP/Docker/Cron 等扩展能力，本质是基于 TCP 的交互式终端会话，需实现 RFC 854 的 IAC 选项协商。

## 方案概览

**主进程新增独立 `telnetService`，复用现有 `ssh:*` IPC 通道与事件**，渲染端终端、断线重连、自动重试逻辑零改动。不引入新 npm 依赖，基于 `node:net` 自实现轻量 Telnet 协议（约 250 行，符合项目自写 SFTP 管道/Markdown 渲染器的惯例）。

### 1. 数据模型（[types.ts](file:///c:/Users/linyi/Desktop/code/mssh/electron/shared/types.ts)）

- `Connection` 增加可选字段 `protocol?: 'ssh' | 'telnet'`（缺省即 ssh，旧配置无需迁移，所有判断用 `protocol === 'telnet'`）
- 复用现有 `username`/`password` 字段（Telnet 下可选填，用于自动登录）；`authType`/`privateKeyPath`/`x11Forwarding` 对 telnet 无意义，UI 隐藏
- `SshSettings` 不变，telnet 复用 `connectTimeout` 与 `keepaliveInterval`

### 2. 新建 [telnetService.ts](file:///c:/Users/linyi/Desktop/code/mssh/electron/services/telnetService.ts)

镜像 [sshService.ts](file:///c:/Users/linyi/Desktop/code/mssh/electron/services/sshService.ts) 的会话 API，保证 IPC 路由层对称：

- `TelnetSession { id, socket, info, connCfg }` + `sessions: Map<string, TelnetSession>`
- 导出 `connect(cfg, sshSettings): Promise<SshSessionInfo>`（cipher/kex 置空串）、`write`、`resize`、`disconnect`、`disconnectAll`、`isConnected`、`getSession`、`has(sessionId)`、`onSessionClosed`（与 sshService 相同的钩子机制，供未来扩展；sftpService 只认 ssh session，不受影响）
- **IAC 协议处理**（RFC 854）：
  - 解析入站字节流剥离协商序列；`IAC IAC` → 字面 0xFF；`WILL ECHO/SGA` 回应 `DO`，`DO TTYPE/NAWS` 回应 `WILL`，其余一律拒绝（DONT/WONT）
  - TTYPE 子协商应答 `xterm-256color`；NAWS 子协商在收到 `DO NAWS` 及每次 `resize` 时上报 cols/rows
  - 出站数据 0xFF 转义为 `IAC IAC`
- **自动登录（一次性状态机）**：若配置了 username 或 password，监听连接后前若干数据，尾部匹配 `/login|username\s*[:：]?$/i` → 发送 username+`\r`；匹配 `/password\s*[:：]?$/i` → 发送 password+`\r`；各只应答一次，两个提示都未出现或应答完毕后停止监听。未配置则纯交互登录（类 PuTTY）
- **断线处理**：`error`/`close` → 可读原因（ECONNREFUSED/ETIMEDOUT/ECONNRESET/EHOSTUNREACH，仿照 sshService 的 `humanizeExitReason`），`removeAndNotify` 广播 `ssh:exit`（**复用同一事件名**，前端 `onAnySshExit`、断线页、自动重连直接生效）
- 数据下发：`socket.on('data')` → StringDecoder(utf8) → 广播 `ssh:data`（复用事件名，Terminal.tsx 无需改动）
- keepalive：`socket.setKeepAlive(true, keepaliveInterval * 1000)`（TCP 层即可，telnet 多为局域网场景）
- `connectTimeout`：socket.setTimeout 仅在建立连接前生效，连上后清除

### 3. IPC 路由（[sshIpc.ts](file:///c:/Users/linyi/Desktop/code/mssh/electron/ipc/sshIpc.ts)）

- `ssh:connect`：按 `cfg.protocol === 'telnet'` 分发到 telnetService 或 sshService
- `ssh:write` / `ssh:resize` / `ssh:disconnect`：先 `telnet.has(sessionId)` 路由，否则走 ssh
- `ssh:stats` / `ssh:exec` / `ssh:execStream` / 全部 sftp IPC：不改（telnet sessionId 在 sshService 查不到，自然报 "SSH session not found"；且前端会隐藏入口）

### 4. 退出清理（[main.ts](file:///c:/Users/linyi/Desktop/code/mssh/electron/main.ts)）

`before-quit` 中 `disconnectAll()` 旁追加 `telnetDisconnectAll()`。

### 5. 前端改动

- **[NewConnectionModal.tsx](file:///c:/Users/linyi/Desktop/code/mssh/src/pages/connect/NewConnectionModal.tsx)**：
  - 顶部加协议 `Segmented`（SSH / Telnet）
  - 切到 telnet 时：port 为 22 则自动改 23（切回 ssh 时 23→22）；隐藏认证方式/私钥/X11 字段；用户名+密码保留但均非必填，密码下方一行 hint（自动登录说明）；`name` 缺省值 telnet 用 `host:port`
  - `DEFAULT_CONN` 加 `protocol: 'ssh'`
- **[TerminalView.tsx](file:///c:/Users/linyi/Desktop/code/mssh/src/pages/terminal/TerminalView.tsx)**：`conn.protocol === 'telnet'` 时隐藏 Docker/Cron/上传/下载四个按钮（AI 与断开保留）；标题栏 `user@host:port` 中 telnet 无用户名时只显示 `host:port`
- **[sessionStore.ts](file:///c:/Users/linyi/Desktop/code/mssh/src/stores/sessionStore.ts)**：无需改动（`sshConnect` 内部已按协议路由；断线/重连走同一事件）
- **i18n**：[zh-CN.ts](file:///c:/Users/linyi/Desktop/code/mssh/src/i18n/zh-CN.ts) / [en-US.ts](file:///c:/Users/linyi/Desktop/code/mssh/src/i18n/en-US.ts) 新增 `newConn.protocol`、`newConn.telnetAuthHint`（"留空则在终端中交互登录；填写后自动应答 login/password 提示"）
- Sidebar 右键/单击只走 `openTerminal`，无需改动

### 6. 不做的事

- 不加设置页 telnet 专属项（复用 ssh 超时/心跳）
- 不做 telnet over TLS、不做端口转发
- SFTP/Docker/Cron 对 telnet 不提供入口（协议本身不支持）

## 验证

1. `pnpm dev` 启动，新建 Telnet 连接：
   - 无公网 telnet 服务时本地验证：`docker run --rm -p 2323:23 alpine/telnetd` 或 Python 起 mock telnet 服务（发 IAC 协商 + `login:` 提示脚本）；也可直连 `telehack.com 23` 之类的公共服务
2. 覆盖场景：连接/输入/回显、中文输出、窗口 resize（NAWS）、配置用户名密码后自动登录、不配置时手动登录、服务端主动断开显示原因、断线自动重连、手动断开、关闭标签断开、退出应用清理
3. 回归：SSH 连接、SFTP、自动重连、编辑旧连接（无 protocol 字段）不受影响
4. `pnpm build`（或仓库的 typecheck/lint 命令）通过
