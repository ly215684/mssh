interface ProgressProps {
  /** 0-100 */
  value: number
  className?: string
}

/** 全局进度条 */
export function Progress({ value, className = '' }: ProgressProps) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className={`h-1.5 w-full bg-hover rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-accent rounded-full transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
