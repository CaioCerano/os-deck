// What setup may offer is what its screen can draw as it is: one rule for both, so a press is
// never bound to more than was shown.
import { redact } from '../redact'
import type { Draft } from './model'

// Marks that read as verified are ours alone to draw.
export const PASS_MARKS = /[✓✔✅☑√🗸🟢🟩💚]/gu
/** Another's words with those marks taken out. */
export const withoutMarks = (text: string): string => text.replace(PASS_MARKS, '*')

// A shown character is one cell and can be told from every other.
export const UNSHOWN = /[^ -~À-ÖØ-öø-ÿ]/u
const ESCAPED: Readonly<Record<string, string>> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

export const quoted = (text: string): string =>
  `"${Array.from(text, ch => ESCAPED[ch] ?? (UNSHOWN.test(ch) ? `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}` : ch)).join('')}"`

// Past these the engine cuts a tree's text, and then what is allowed was not all shown.
const MAX_DRAFT_CHARS = 16_000
const MAX_DRAFT_LINES = 400

/** Whether redaction would show other words than these, its tidying of control characters aside. */
export const hasSecret = (text: string): boolean => {
  const plain = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ch => (ch === '\n' ? ch : ''))
  return redact(plain) !== plain
}

/** Why what would run cannot be shown as it is; null where it can. */
export const unshowable = (draft: Draft): string | null => {
  // A draft kept in state from before config was shown has none.
  const files = draft.files ?? []
  const texts = [
    draft.root,
    ...draft.checks.flatMap(c => [c.id, c.dir, ...c.argv]),
    ...draft.scripts.flatMap(x => [x.name, x.body]),
    ...files.flatMap(x => [x.path, x.body]),
  ]
  if (texts.reduce((n, t) => n + quoted(t).length, 0) > MAX_DRAFT_CHARS) return 'too long to show whole'
  if ([...draft.scripts, ...files].reduce((n, x) => n + x.body.split('\n').length, 0) > MAX_DRAFT_LINES) return 'too long to show whole'
  // An argument split from its flag is still read as one line.
  if (texts.some(hasSecret) || draft.checks.some(c => hasSecret(c.argv.join(' ')))) return 'what looks like a secret'
  return null
}
