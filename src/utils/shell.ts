/** shell 单引号安全包裹（POSIX） */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
