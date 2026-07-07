import type { DocHolder as PassportHolder } from './types'

export const MRZ_LENGTH = 41

const encode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '<')

/**
 * Machine readable zone line from holder data, encoded the way real MRZ
 * encodes fields: filler '<', surname << given names, then document fields.
 */
export function generateMrz(holder: PassportHolder, issued: string): string {
  const names = holder.fullName.trim().split(/\s+/)
  const surname = names.length > 1 ? names[names.length - 1] : names[0] ?? ''
  const given = names.length > 1 ? names.slice(0, -1) : []
  const line = `P<SOC${encode(surname)}<<${given.map(encode).join('<')}<${encode(holder.company)}<${encode(issued)}`
  return line.padEnd(MRZ_LENGTH, '<').slice(0, MRZ_LENGTH)
}
