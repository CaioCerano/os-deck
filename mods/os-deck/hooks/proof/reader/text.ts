// What of a text or a file can be put before a person as it is, and what bytes hold.
import { redact } from '../../redact'
import { hasSecret } from '../showable'

const MAX_MANIFEST = 256 * 1024
export const MAX_BODY = 1000
const MAX_CONFIG = 8000

// ---------------------------------------------------------------- what can be shown

// By number: typed in, they could not be seen here either. A blank braille cell, and what an undecodable byte becomes.
const LOOKS_BLANK = [0x2800, 0xfffd].map(code => String.fromCharCode(code))
const BOM = String.fromCharCode(0xfeff)

/** Whether a text holds what does not show as itself: the plain space is the only blank that does. */
export const hidesSomething = (text: string) =>
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(text.replaceAll(' ', '')) || LOOKS_BLANK.some(ch => text.includes(ch))

/** Why a text would not be shown as what runs; null where it would. */
export const showProblem = (text: string): string | null =>
  text.length > MAX_BODY
    ? 'is too long to show whole'
    : hidesSomething(text)
      ? 'holds a character that does not show'
      : redact(text) !== text
        ? 'holds what looks like a secret'
        : null

/** The same for a file shown whole, where lines and tabs are its form. */
export const fileProblem = (body: string): string | null =>
  body.length > MAX_CONFIG
    ? 'is too long to show whole'
    : hidesSomething(body.replace(/\r\n|[\n\t]/g, ' '))
      ? 'holds a character that does not show'
      : hasSecret(body)
        ? 'holds what looks like a secret'
        : null

export const textOf = (bytes: Uint8Array) => {
  const text = new TextDecoder().decode(bytes)
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** An object a file holds as JSON; null where it holds none. */
export const objectIn = (bytes: Uint8Array): Record<string, unknown> | null => {
  if (bytes.length > MAX_MANIFEST) return null
  try {
    const value: unknown = JSON.parse(textOf(bytes))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The scripts of a package.json's bytes, a Map: a script may be named like what every object has. */
export const scriptsIn = (bytes: Uint8Array): Map<string, unknown> | null => {
  const manifest = objectIn(bytes)
  if (!manifest) return null
  const { scripts } = manifest
  return new Map(typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? Object.entries(scripts) : [])
}
