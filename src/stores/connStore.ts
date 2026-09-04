import { create } from 'zustand'
import type { ConnGroup, Connection } from '../../electron/shared/types'

interface ConnState {
  connections: Connection[]
  groups: ConnGroup[]
  hydrate: (connections: Connection[], groups: ConnGroup[]) => void
  saveConnection: (conn: Connection) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  saveGroup: (group: ConnGroup) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  toggleGroup: (id: string) => void
  getConnection: (id: string) => Connection | undefined
  /** 注册仅存在于内存的连接（快速连接），不持久化 */
  registerMemory: (conn: Connection) => void
}

/** 连接与分组 store（持久化由主进程负责） */
export const useConnStore = create<ConnState>((set, get) => ({
  connections: [],
  groups: [],

  hydrate: (connections, groups) => set({ connections, groups }),

  registerMemory: conn => {
    set(s =>
      s.connections.some(c => c.id === conn.id)
        ? {}
        : { connections: [...s.connections, conn] },
    )
  },

  saveConnection: async conn => {
    await window.api.saveConnection(conn)
    set(s => {
      const idx = s.connections.findIndex(c => c.id === conn.id)
      const connections = [...s.connections]
      if (idx >= 0) connections[idx] = conn
      else connections.push(conn)
      return { connections }
    })
  },

  deleteConnection: async id => {
    await window.api.deleteConnection(id)
    set(s => ({ connections: s.connections.filter(c => c.id !== id) }))
  },

  saveGroup: async group => {
    await window.api.saveGroup(group)
    set(s => {
      const idx = s.groups.findIndex(g => g.id === group.id)
      const groups = [...s.groups]
      if (idx >= 0) groups[idx] = group
      else groups.push(group)
      return { groups }
    })
  },

  deleteGroup: async id => {
    await window.api.deleteGroup(id)
    set(s => ({
      groups: s.groups.filter(g => g.id !== id),
      connections: s.connections.map(c => (c.groupId === id ? { ...c, groupId: null } : c)),
    }))
  },

  toggleGroup: id => {
    const groups = get().groups.map(g => (g.id === id ? { ...g, collapsed: !g.collapsed } : g))
    set({ groups })
    const group = groups.find(g => g.id === id)
    if (group) window.api.saveGroup(group)
  },

  getConnection: id => get().connections.find(c => c.id === id),
}))
