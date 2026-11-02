import {
  Activity,
  ArrowUpDown,
  Bot,
  CalendarClock,
  Container,
  Server,
  type LucideIcon,
} from 'lucide-react'
import type { ToolbarItemId } from '../../../electron/shared/types'
import type { DictKey } from '../../i18n/zh-CN'

/** 终端工具栏按钮元数据（工具栏与设置页共用） */
export interface ToolbarMeta {
  id: ToolbarItemId
  icon: LucideIcon
  labelKey: DictKey
  descKey: DictKey
}

export const TOOLBAR_META: Record<ToolbarItemId, ToolbarMeta> = {
  ai: { id: 'ai', icon: Bot, labelKey: 'term.ai', descKey: 'settings.toolbar.aiDesc' },
  docker: {
    id: 'docker',
    icon: Container,
    labelKey: 'term.docker',
    descKey: 'settings.toolbar.dockerDesc',
  },
  cron: {
    id: 'cron',
    icon: CalendarClock,
    labelKey: 'term.cron',
    descKey: 'settings.toolbar.cronDesc',
  },
  monitor: {
    id: 'monitor',
    icon: Activity,
    labelKey: 'term.monitor',
    descKey: 'settings.toolbar.monitorDesc',
  },
  system: {
    id: 'system',
    icon: Server,
    labelKey: 'term.system',
    descKey: 'settings.toolbar.systemDesc',
  },
  sftp: {
    id: 'sftp',
    icon: ArrowUpDown,
    labelKey: 'term.transfer',
    descKey: 'settings.toolbar.sftpDesc',
  },
}
