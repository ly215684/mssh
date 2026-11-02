import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  AllConfig,
  AppSettings,
  ConnGroup,
  Connection,
  LayoutState,
  SyncData,
  SyncScope,
} from '../shared/types'
import { DEFAULT_SETTINGS, normalizeToolbarSettings } from '../shared/types'

/** 数据目录：~/.ssh-hub/（与设置页展示一致） */
export const DATA_DIR = path.join(app.getPath('home'), '.ssh-hub')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json')

interface StoredConnection extends Omit<Connection, 'password' | 'keyPassphrase' | 'privateKey'> {
  /** 加密后的密码（safeStorage 不可用时降级 base64） */
  password?: string
  keyPassphrase?: string
  /** 加密后的私钥内容 */
  privateKey?: string
}

interface StoredConfig {
  settings: AppSettings
  connections: StoredConnection[]
  groups: ConnGroup[]
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

// ---------- 凭据加解密 ----------

function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  }
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64')
}

function decryptSecret(stored: string | undefined): string {
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8')
  }
  return stored
}

// ---------- 配置读写 ----------

/** 深拷贝默认设置（嵌套对象需独立，避免运行时修改污染常量） */
function defaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    terminal: { ...DEFAULT_SETTINGS.terminal },
    toolbar: normalizeToolbarSettings(),
    ssh: { ...DEFAULT_SETTINGS.ssh },
    ai: { ...DEFAULT_SETTINGS.ai },
    sync: { ...DEFAULT_SETTINGS.sync, webdav: { ...DEFAULT_SETTINGS.sync.webdav } },
  }
}

function readConfig(): StoredConfig {
  ensureDir()
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredConfig>
    // 嵌套对象需与默认值合并，保证旧配置升级后新增字段有默认值
    const settings: AppSettings = {
      ...defaultSettings(),
      ...parsed.settings,
      terminal: { ...DEFAULT_SETTINGS.terminal, ...parsed.settings?.terminal },
      toolbar: normalizeToolbarSettings(parsed.settings?.toolbar),
      ssh: { ...DEFAULT_SETTINGS.ssh, ...parsed.settings?.ssh },
      ai: { ...DEFAULT_SETTINGS.ai, ...parsed.settings?.ai },
      sync: {
        ...DEFAULT_SETTINGS.sync,
        ...parsed.settings?.sync,
        webdav: { ...DEFAULT_SETTINGS.sync.webdav, ...parsed.settings?.sync?.webdav },
      },
    }
    // 敏感字段落盘为密文，读取后还原明文
    settings.ai.apiKey = decryptSecret(settings.ai.apiKey)
    settings.sync.password = decryptSecret(settings.sync.password)
    settings.sync.webdav.password = decryptSecret(settings.sync.webdav.password)
    return {
      settings,
      connections: parsed.connections ?? [],
      groups: parsed.groups ?? [],
    }
  } catch {
    return { settings: defaultSettings(), connections: [], groups: [] }
  }
}

function writeConfig(cfg: StoredConfig) {
  ensureDir()
  // 敏感字段加密后落盘（复制一层，避免把传入的明文 settings 改成密文）
  const stored: StoredConfig = {
    ...cfg,
    settings: {
      ...cfg.settings,
      ai: { ...cfg.settings.ai, apiKey: encryptSecret(cfg.settings.ai.apiKey) },
      sync: {
        ...cfg.settings.sync,
        password: encryptSecret(cfg.settings.sync.password),
        webdav: {
          ...cfg.settings.sync.webdav,
          password: encryptSecret(cfg.settings.sync.webdav.password),
        },
      },
    },
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2), 'utf8')
}

/** 仅读取设置（供主进程内部服务使用，如 AI 服务读取最新 Key） */
export function getSettings(): AppSettings {
  return readConfig().settings
}

export function getAll(): AllConfig {
  const cfg = readConfig()
  let layout: LayoutState | null = null
  try {
    layout = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')) as LayoutState
  } catch {
    layout = null
  }
  return {
    settings: cfg.settings,
    connections: cfg.connections.map(c => ({
      ...c,
      password: decryptSecret(c.password),
      keyPassphrase: decryptSecret(c.keyPassphrase),
      privateKey: decryptSecret(c.privateKey),
    })),
    groups: cfg.groups,
    layout,
    dataDir: DATA_DIR,
  }
}

export function saveSettings(settings: AppSettings) {
  const cfg = readConfig()
  cfg.settings = settings
  writeConfig(cfg)
}

export function saveConnection(conn: Connection) {
  const cfg = readConfig()
  const stored: StoredConnection = {
    ...conn,
    password: encryptSecret(conn.password ?? ''),
    keyPassphrase: encryptSecret(conn.keyPassphrase ?? ''),
    privateKey: encryptSecret(conn.privateKey ?? ''),
  }
  // 私钥内容已保存时不再保存文件路径
  if (conn.privateKey) delete stored.privateKeyPath
  const idx = cfg.connections.findIndex(c => c.id === conn.id)
  if (idx >= 0) cfg.connections[idx] = stored
  else cfg.connections.push(stored)
  writeConfig(cfg)
}

export function deleteConnection(id: string) {
  const cfg = readConfig()
  cfg.connections = cfg.connections.filter(c => c.id !== id)
  writeConfig(cfg)
}

export function saveGroup(group: ConnGroup) {
  const cfg = readConfig()
  const idx = cfg.groups.findIndex(g => g.id === group.id)
  if (idx >= 0) cfg.groups[idx] = group
  else cfg.groups.push(group)
  writeConfig(cfg)
}

export function deleteGroup(id: string) {
  const cfg = readConfig()
  cfg.groups = cfg.groups.filter(g => g.id !== id)
  // 组内连接移至未分组
  for (const c of cfg.connections) {
    if (c.groupId === id) c.groupId = null
  }
  writeConfig(cfg)
}

export function saveLayout(layout: LayoutState) {
  ensureDir()
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout), 'utf8')
}

export function clearLayout() {
  fsp.rm(LAYOUT_FILE, { force: true }).catch(() => {})
}

// ---------- 配置同步 ----------

/** 同步载荷中的空同步设置（本机凭据不随载荷外传） */
function emptySyncSettings() {
  return {
    password: '',
    webdav: { ...DEFAULT_SETTINGS.sync.webdav },
  }
}

/** 收集用于导入/导出的明文配置（含连接密码与 AI Key，不含本机同步凭据） */
export function buildSyncData(scope: SyncScope = 'all'): SyncData {
  const all = getAll()
  // 仅连接列表：只带连接与分组，不带设置 / 布局 / AI Key
  if (scope === 'connections') {
    return { scope: 'connections', connections: all.connections, groups: all.groups }
  }
  return {
    scope: 'all',
    settings: { ...all.settings, sync: emptySyncSettings() },
    connections: all.connections,
    groups: all.groups,
    layout: all.layout,
  }
}

/** 将同步载荷按 ID 合并到本地并落盘，返回合并后的完整配置 */
export function applySyncData(data: SyncData): AllConfig {
  const local = readConfig()
  const base = defaultSettings()
  const connectionsOnly = data.scope === 'connections'
  const imported = data.settings

  // 设置：逐节合并（同步源优先），本机同步凭据保持不变；
  // 仅连接列表的备份不包含设置，直接沿用本机设置
  let settings = local.settings
  if (!connectionsOnly && imported) {
    settings = {
      ...base,
      ...imported,
      terminal: { ...base.terminal, ...imported.terminal },
      toolbar: normalizeToolbarSettings(imported.toolbar),
      ssh: { ...base.ssh, ...imported.ssh },
      ai: { ...base.ai, ...imported.ai },
      sync: local.settings.sync,
    }
  }

  // 分组：按 id 覆盖合并，本地独有保留
  const groups = [...local.groups]
  for (const g of data.groups) {
    const idx = groups.findIndex(x => x.id === g.id)
    if (idx >= 0) groups[idx] = g
    else groups.push(g)
  }

  // 连接：按 id 覆盖合并，本地独有保留；敏感字段重新加密
  const connections = [...local.connections]
  for (const c of data.connections) {
    const stored: StoredConnection = {
      ...c,
      password: encryptSecret(c.password ?? ''),
      keyPassphrase: encryptSecret(c.keyPassphrase ?? ''),
      privateKey: encryptSecret(c.privateKey ?? ''),
    }
    if (c.privateKey) delete stored.privateKeyPath
    const idx = connections.findIndex(x => x.id === c.id)
    if (idx >= 0) connections[idx] = stored
    else connections.push(stored)
  }

  writeConfig({ settings, connections, groups })
  // 布局仅覆盖落盘，由下次启动的会话恢复读取，不打断当前会话
  if (!connectionsOnly && data.layout) saveLayout(data.layout)

  return getAll()
}
