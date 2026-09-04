import { useMemo, useState } from 'react'
import {
  Moon,
  Pencil,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Trash2,
  ChevronRight,
  Copy,
  Folder,
} from 'lucide-react'
import type { ConnGroup } from '../../electron/shared/types'
import { useAppStore } from '../stores/appStore'
import { useConnStore } from '../stores/connStore'
import { useSessionStore } from '../stores/sessionStore'
import { useUiStore } from '../stores/uiStore'
import { useT } from '../i18n/I18nProvider'
import {
  Button,
  Dropdown,
  Input,
  Modal,
  Switch,
  confirm,
  errorAlert,
  message,
  useContextMenu,
} from '../components/ui'

/** 左侧栏：logo / 搜索 / 快速连接 / 连接分组树 / 主题切换 / 设置 */
export function Sidebar() {
  const t = useT()
  const theme = useAppStore(s => s.settings.theme)
  const setTheme = useAppStore(s => s.setTheme)
  const connections = useConnStore(s => s.connections)
  const groups = useConnStore(s => s.groups)
  const toggleGroup = useConnStore(s => s.toggleGroup)
  const saveGroup = useConnStore(s => s.saveGroup)
  const deleteGroup = useConnStore(s => s.deleteGroup)
  const saveConnection = useConnStore(s => s.saveConnection)
  const deleteConnection = useConnStore(s => s.deleteConnection)
  const connSessions = useSessionStore(s => s.connSessions)
  const openTerminal = useSessionStore(s => s.openTerminal)
  const openNewConn = useUiStore(s => s.openNewConn)
  const openEditConn = useUiStore(s => s.openEditConn)
  const setQuickConnOpen = useUiStore(s => s.setQuickConnOpen)
  const setSettingsOpen = useUiStore(s => s.setSettingsOpen)

  const [search, setSearch] = useState('')
  const [groupModal, setGroupModal] = useState<
    { mode: 'new' } | { mode: 'rename'; group: ConnGroup } | null
  >(null)
  const [groupName, setGroupName] = useState('')

  const { openContextMenu } = useContextMenu()

  const keyword = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      keyword
        ? connections.filter(c => c.name.toLowerCase().includes(keyword) || c.host.includes(keyword))
        : connections,
    [connections, keyword],
  )

  const groupItems = groups.map(g => ({
    group: g,
    children: filtered.filter(c => c.groupId === g.id),
  }))
  const ungrouped = filtered.filter(c => !c.groupId || !groups.some(g => g.id === c.groupId))

  const statusDot = (connId: string) => {
    const status = connSessions[connId]?.status
    if (status === 'connected') return 'bg-accent'
    if (status === 'connecting') return 'bg-warning animate-pulse'
    if (status === 'error') return 'bg-danger'
    return 'bg-bd-strong'
  }

  const connMenu = () => [
    { key: 'connect', label: t('ctx.connect'), icon: <SquareTerminal /> },
    { key: 'edit', label: t('ctx.edit'), icon: <Pencil /> },
    { key: 'duplicate', label: t('ctx.duplicate'), icon: <Copy /> },
    { key: 'delete', label: t('ctx.deleteConn'), icon: <Trash2 />, danger: true },
  ]

  async function runConnAction(key: string, connId: string) {
    const conn = connections.find(c => c.id === connId)
    if (!conn) return
    switch (key) {
      case 'connect':
        await openTerminal(connId)
        break
      case 'edit':
        openEditConn(conn)
        break
      case 'duplicate': {
        const copy = {
          ...conn,
          id: crypto.randomUUID(),
          name: `${conn.name} ${t('common.copy')}`,
          createdAt: Date.now(),
        }
        await saveConnection(copy)
        message.success(t('msg.saved'))
        break
      }
      case 'delete': {
        const ok = await confirm({
          title: t('msg.deleteConnConfirm', { name: conn.name }),
          danger: true,
        })
        if (ok) {
          await deleteConnection(connId)
          message.success(t('msg.deleted'))
        }
        break
      }
    }
  }

  async function runGroupAction(key: string, group: ConnGroup) {
    if (key === 'rename') {
      setGroupName(group.name)
      setGroupModal({ mode: 'rename', group })
      return
    }
    if (key === 'delete') {
      const ok = await confirm({
        title: t('msg.deleteGroupConfirm', { name: group.name }),
        danger: true,
      })
      if (ok) {
        await deleteGroup(group.id)
        message.success(t('msg.deleted'))
      }
    }
  }

  async function submitGroup() {
    const name = groupName.trim()
    if (!name) return
    try {
      if (groupModal?.mode === 'rename') {
        await saveGroup({ ...groupModal.group, name })
      } else {
        await saveGroup({ id: crypto.randomUUID(), name })
      }
      setGroupModal(null)
    } catch (e) {
      void errorAlert(t('msg.opFailed', { msg: '' }), e)
    }
  }

  return (
    <aside className="flex flex-col w-[var(--sidebar-w)] bg-panel border-r border-bd shrink-0">
      {/* logo */}
      <div className="flex items-center gap-2 px-3.5 h-11 shrink-0">
        <span className="size-6 rounded-md bg-accent-dim text-accent flex items-center justify-center">
          <SquareTerminal size={15} />
        </span>
        <span className="text-[15px] font-semibold tracking-wide">mssh</span>
      </div>

      {/* 搜索 */}
      <div className="px-3 pb-2 shrink-0">
        <div className="flex items-center bg-input border border-bd rounded-md focus-within:border-accent transition-colors">
          <Search size={13} className="ml-2.5 text-faint shrink-0" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('sidebar.searchPh')}
            className="flex-1 h-7.5 bg-transparent px-2 text-xs text-fg placeholder:text-faint outline-none min-w-0"
          />
        </div>
      </div>

      {/* 快速连接 */}
      <div className="px-3 pb-3 shrink-0">
        <Button variant="primary" icon={<Plus size={14} />} className="w-full" onClick={() => setQuickConnOpen(true)}>
          {t('sidebar.quickConnect')}
        </Button>
      </div>

      {/* 连接区 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex items-center justify-between px-1.5 py-1.5 sticky top-0 bg-panel z-10">
          <span className="text-[11px] text-dim font-medium">{t('sidebar.connections')}</span>
          <Dropdown
            align="end"
            items={[
              { key: 'newConn', label: t('sidebar.newConnection'), icon: <SquareTerminal /> },
              { key: 'newGroup', label: t('sidebar.newGroup'), icon: <Folder /> },
            ]}
            onPick={key => {
              if (key === 'newConn') openNewConn()
              else {
                setGroupName('')
                setGroupModal({ mode: 'new' })
              }
            }}
          >
            <button className="size-5 flex items-center justify-center rounded text-dim hover:text-fg hover:bg-hover transition-colors">
              <Plus size={13} />
            </button>
          </Dropdown>
        </div>

        {filtered.length === 0 && keyword && (
          <div className="px-2 py-3 text-xs text-faint">{t('sidebar.noResults')}</div>
        )}

        {groupItems.map(({ group, children }) => {
          const expanded = keyword || !group.collapsed
          return (
            <div key={group.id}>
              <div
                onClick={() => toggleGroup(group.id)}
                onContextMenu={e =>
                  openContextMenu(
                    e,
                    [
                      { key: 'rename', label: t('ctx.renameGroup'), icon: <Pencil /> },
                      { key: 'delete', label: t('ctx.deleteGroup'), icon: <Trash2 />, danger: true },
                    ],
                    key => runGroupAction(key, group),
                  )
                }
                className="group flex items-center gap-1.5 h-7.5 px-1.5 rounded-md text-[13px] text-fg cursor-pointer hover:bg-hover transition-colors"
              >
                <ChevronRight
                  size={13}
                  className={`text-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
                <span className="flex-1 truncate">{group.name}</span>
              </div>
              {expanded &&
                children.map(c => (
                  <ConnRow
                    key={c.id}
                    name={c.name}
                    dot={statusDot(c.id)}
                    menu={connMenu()}
                    onClick={() => openTerminal(c.id)}
                    onAction={key => runConnAction(key, c.id)}
                  />
                ))}
            </div>
          )
        })}

        {ungrouped.length > 0 && (
          <div>
            {groups.length > 0 && (
              <div className="px-1.5 py-1 text-[11px] text-faint">{t('sidebar.ungrouped')}</div>
            )}
            {ungrouped.map(c => (
              <ConnRow
                key={c.id}
                name={c.name}
                dot={statusDot(c.id)}
                menu={connMenu()}
                onClick={() => openTerminal(c.id)}
                onAction={key => runConnAction(key, c.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部：主题切换 + 设置 */}
      <div className="border-t border-bd px-2 py-2 shrink-0">
        <div className="flex items-center gap-2.5 h-8 px-1.5 rounded-md text-[13px] text-dim">
          {theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
          <span className="flex-1">{theme === 'dark' ? t('sidebar.darkMode') : t('sidebar.lightMode')}</span>
          <Switch
            checked={theme === 'dark'}
            onChange={v => setTheme(v ? 'dark' : 'light')}
          />
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-2.5 h-8 px-1.5 rounded-md text-[13px] text-dim hover:text-fg hover:bg-hover transition-colors"
        >
          <Settings size={15} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      {/* 分组新建/重命名弹窗 */}
      <Modal
        open={groupModal !== null}
        onClose={() => setGroupModal(null)}
        title={groupModal?.mode === 'rename' ? t('ctx.renameGroup') : t('sidebar.newGroup')}
        width={380}
        footer={
          <>
            <Button onClick={() => setGroupModal(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={submitGroup}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="pt-1">
          <Input
            autoFocus
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitGroup()}
            placeholder={t('common.name')}
          />
        </div>
      </Modal>
    </aside>
  )
}

/** 连接行（分组子项与未分组项共用） */
function ConnRow({
  name,
  dot,
  onClick,
  onAction,
  menu,
}: {
  name: string
  dot: string
  onClick: () => void
  onAction: (key: string) => void
  menu: Parameters<ReturnType<typeof useContextMenu>['openContextMenu']>[1]
}) {
  const { openContextMenu } = useContextMenu()
  return (
    <div
      onClick={onClick}
      onContextMenu={e => openContextMenu(e, menu, onAction)}
      className="flex items-center gap-2 h-7.5 pl-6 pr-1.5 rounded-md text-[13px] text-fg cursor-pointer hover:bg-hover transition-colors"
    >
      <span className={`size-2 rounded-full shrink-0 ${dot}`} />
      <span className="flex-1 truncate">{name}</span>
    </div>
  )
}
