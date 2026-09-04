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
} from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

/** 数据目录：~/.ssh-hub/（与设置页展示一致） */
export const DATA_DIR = path.join(app.getPath('home'), '.ssh-hub')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json')

interface StoredConnection extends Omit<Connection, 'password' | 'keyPassphrase'> {
  /** 加密后的密码（safeStorage 不可用时降级 base64） */
  password?: string
  keyPassphrase?: string
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

function readConfig(): StoredConfig {
  ensureDir()
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredConfig>
    return {
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      connections: parsed.connections ?? [],
      groups: parsed.groups ?? [],
    }
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, connections: [], groups: [] }
  }
}

function writeConfig(cfg: StoredConfig) {
  ensureDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
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
  }
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
