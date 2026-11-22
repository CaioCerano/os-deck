// Text made safe before it is stored, drawn or notified: control characters out (the engine refuses
// a whole pane for one), credentials masked. The rules read untrusted text of any
// length (commands, agent answers, pull request titles), so each is linear: a repeat that can be
// retried from many starting points is bounded.

const MASK = '•••'
/** Text past this is not scanned, so it is not kept either. */
const MAX_SCAN = 50_000
/** Dropped from the end of cut text: a secret the cut split no longer matches its rule. */
const CUT_MARGIN = 512

const RULES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]{0,30}PRIVATE KEY[A-Z ]{0,10}-----[\s\S]*?(?:-----END [A-Z ]{0,50}-----|$)/g, MASK],
  // Authorization: <scheme> <credential>, as a header, an assignment or JSON.
  [/(authorization\\?["']?\s{0,5}[:=]\s{0,5}\\?["']?(?:(?:bearer|basic|token|digest|negotiate|bot|api-?key)\s{1,5})?)[^\s"'\\]+/gi, `$1${MASK}`],
  [/\b(bearer\s{1,5})[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MASK}`],
  // Tokens known by their shape.
  [/\b(?:sk|pk|rk|xox[abeoprs]|xapp)[-_][A-Za-z0-9_-]{8,}/g, MASK],
  [/(?:\bgh[opsur]_|\bgithub_pat_)[A-Za-z0-9_]{8,}/g, MASK],
  [/\b(?:glpat-|pypi-|ya29\.)[A-Za-z0-9._-]{16,}/g, MASK],
  [/\b(?:npm_|hf_)[A-Za-z0-9]{16,}/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{4,8000}\.[A-Za-z0-9_-]*/g, MASK],
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi, `$1${MASK}`],
  // A name that ends like a secret's, then = or :, then the value: shell, env, JSON, YAML, query strings.
  [
    /((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?key|private[_-]?key|account[_-]?key|auth[_-]?key|token|secret|password|passwd|passphrase|pwd)\\?["']?\s{0,5}[=:]\s{0,5})(?:\\"[^"\n]*"?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|[^\s&]+)/gi,
    `$1${MASK}`,
  ],
  [/(\b[A-Z0-9_]{0,80}(?:KEY|TOKEN|SECRET|PASSWORD|PASS)=)(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/g, `$1${MASK}`],
  [/([?&](?:key|sig|signature|auth|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // Command-line flags.
  [/(--(?:[a-z0-9]{1,20}-){0,3}(?:token|password|passwd|api-?key|secret|secret-key|passphrase)(?:=|[ \t]{1,5}))(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/gi, `$1${MASK}`],
  [/(\bcurl(?:\.exe)?\b[^\n|;]{0,300}?\s(?:-u|--user|-U|--proxy-user)(?:=|[ \t]{0,5})["']?[^\s:"']{0,100}:)[^\s"']+/g, `$1${MASK}`],
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)(?:\.exe)?\b[^\n|;&]{0,300}?\s-p)\S+/g, `$1${MASK}`],
  [/(\bsshpass\s{1,3}-p\s{0,3})(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/g, `$1${MASK}`],
  [/(\b(?:set-)?cookie["']?\s{0,5}:\s{0,5})[^\r\n"']+/gi, `$1${MASK}`],
  [/(\bdocker(?:\.exe)?\s{1,3}login\b[^\n|;&]{0,300}?\s(?:-p|--password)(?:=|[ \t]{0,5}))\S+/g, `$1${MASK}`],
  [/(\bredis-cli(?:\.exe)?\b[^\n|;&]{0,300}?\s-a[ \t]{1,5})\S+/g, `$1${MASK}`],
  // Credentials in a URL's authority.
  [/(:\/\/[^\s/:@]{0,200}:)[^\s@]{1,500}(?:@[^\s@/]{1,200}){0,3}@/g, `$1${MASK}@`],
  [/(:\/\/)[A-Za-z0-9_%-]{20,500}@/g, `$1${MASK}@`],
]

/** Terminal sequences, the other control characters, and the characters that hide or reorder text. */
const plainText = (text: string) =>
  text
    .replace(/(?:\x1b\[|\x9b)[0-?]{0,64}[ -/]{0,8}[@-~]?/g, '')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f؜​‎‏‪-‮⁦-⁩﻿\u{e0000}-\u{e007f}]/gu, '')

/** The text as plain text with credentials masked; what is past the scan limit is left out, never passed through. */
export const redact = (text: string): string => {
  const isCut = text.length > MAX_SCAN
  const out = RULES.reduce((t, [re, to]) => t.replace(re, to), plainText(isCut ? text.slice(0, MAX_SCAN) : text))
  return isCut ? `${out.slice(0, -CUT_MARGIN)}…` : out
}

/** Every string inside a value redacted, its shape kept. */
export const redactDeep = <T>(value: T, depth = 0): T => {
  if (typeof value === 'string') return redact(value) as T
  if (typeof value !== 'object' || value === null) return value
  if (depth >= 12) return (Array.isArray(value) ? [] : {}) as T
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as T
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, depth + 1)])) as T
}
