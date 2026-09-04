import type { ReactNode } from 'react'
import { Empty } from './Empty'

export interface Column<T> {
  key: string
  title: ReactNode
  render?: (row: T) => ReactNode
  width?: number | string
  align?: 'left' | 'center' | 'right'
}

interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  empty?: ReactNode
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string
}

/** 全局表格组件 */
export function Table<T>({ columns, rows, rowKey, empty, onRowClick, rowClassName }: TableProps<T>) {
  if (rows.length === 0) return <>{empty ?? <Empty />}</>

  return (
    <table className="w-full text-[13px] border-collapse">
      <thead>
        <tr className="text-dim border-b border-bd">
          {columns.map(c => (
            <th
              key={c.key}
              style={{ width: c.width, textAlign: c.align ?? 'left' }}
              className="font-normal px-3 h-9 whitespace-nowrap"
            >
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr
            key={rowKey(r)}
            onClick={() => onRowClick?.(r)}
            className={`border-b border-bd/50 transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${
              rowClassName?.(r) ?? ''
            } hover:bg-hover`}
          >
            {columns.map(c => (
              <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className="px-3 h-9">
                {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
