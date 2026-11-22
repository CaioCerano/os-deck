// Text made safe before it is stored, drawn or notified: control characters out (the engine refuses
// a whole pane for one), credentials masked. The rules read untrusted text of any
// length (commands, agent answers, pull request titles), so each is linear: a repeat that can be
// retried from many starting points is bounded.

const MASK = '•••'
/** Text past this is not scanned, so it is not kept either. */
const MAX_SCAN = 50_000
/** Dropped from the end of cut text: a secret the cut split no longer matches its rule. */
const CUT_MARGIN = 512

/** Where a token may begin: after anything but a letter or digit, or straight after an escape or a percent-encoded byte. */
const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}))`
const token = (shape: string) => new RegExp(START + shape, 'g')

// Everything that looks like a secret is masked. The exceptions below are each an exact shape that
// holds none: widen one only with a case showing it cannot pass a secret through.

/** Words that open a title such as "Fix token: refresh flow", none of them anybody's password. */
const TITLE_WORD = /^(?:add|allow|avoid|change|check|drop|expire|expiry|fix|handle|move|refresh|rename|remove|reset|rotate|rotation|store|support|update|use|validate|validation)$/
/** Code that reads a secret and holds none: `getToken()`, `os.environ["NAME"]`. */
const CODE_VALUE = /^(?:(?:get|read|load|fetch|create|generate)[A-Z][A-Za-z]{1,24}\(\)|os\.environ\[["'][A-Z_]{1,40}["']\]|os\.getenv\(["'][A-Z_]{1,40}["']\));?$/
const LITERAL_VALUE = /^(?:true|false|null|none|undefined)[,;]?$/i
const WORKING_DIR = /^(?:\/(?:home|Users|root|workspaces?)\/|[A-Za-z]:[\\/]Users[\\/])/
/** Upper-case names that only happen to end in KEY or PASS. */
const NOT_A_SECRET_NAME = /(?:^|_)(?:MONKEY|DONKEY|TURKEY|HOCKEY|BYPASS|COMPASS|SURPASS)=$/
/** `sk-dashboard`, `pk_migration_fix`, `rk_release2026`: short words, at most a year after one. */
const WORDS_NOT_KEY = /^(?:sk|pk|rk)(?:[-_][a-z]{2,14}(?:20\d\d)?){1,5}$/

/** A named value masked, unless it is plainly a title, code, a literal, or the working directory. */
const maskNamed = (whole: string, lead: string, name: string, value: string, at: number, text: string) => {
  if (LITERAL_VALUE.test(value)) return whole
  if (name === 'PWD' && lead === 'PWD=' && WORKING_DIR.test(value)) return whole
  if (/\s=\s+$/.test(lead.slice(-12)) && CODE_VALUE.test(value)) return whole
  const end = at + whole.length
  if (/^(?:token|secret|password)$/i.test(name) && /: $/.test(lead) && TITLE_WORD.test(value) && /^ [A-Za-z]{2}/.test(text.slice(end, end + 3))) return whole
  return `${lead}${MASK}`
}

const maskUpperName = (whole: string, lead: string) => (NOT_A_SECRET_NAME.test(lead) ? whole : `${lead}${MASK}`)
const maskKeyShape = (whole: string) => (WORDS_NOT_KEY.test(whole) ? whole : MASK)

type Rule = readonly [RegExp, string | ((match: string, ...groups: any[]) => string)]

const RULES: readonly Rule[] = [
  [/-----BEGIN [A-Z ]{0,30}PRIVATE KEY[A-Z ]{0,10}-----[\s\S]*?(?:-----END [A-Z ]{0,50}-----|$)/g, MASK],
  // Authorization: <scheme> <credential>, as a header, an assignment or JSON.
  [/(authorization\\?["']?\s{0,5}[:=]\s{0,5}\\?["']?(?:(?:bearer|basic|token|digest|negotiate|bot|api-?key)\s{1,5})?)[^\s"'\\]+/gi, `$1${MASK}`],
  [/\b(bearer\s{1,5})[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MASK}`],
  // Tokens known by their shape. A prefix no word contains needs no boundary before it.
  [/gh[opsur]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/g, MASK],
  [/(?<![A-Z])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, MASK],
  [/(?:shpat|shpss|shpca|whsec)_[A-Za-z0-9]{16,}|dop_v1_[A-Za-z0-9]{16,}/g, MASK],
  [token(String.raw`(?:xox[abeoprs]|xapp)[-_][A-Za-z0-9_-]{8,}`), MASK],
  [token(String.raw`sk-(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{8,}`), MASK],
  [token(String.raw`(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}`), MASK],
  [token(String.raw`(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}`), maskKeyShape],
  [token(String.raw`(?:glpat-|pypi-|ya29\.)[A-Za-z0-9._-]{16,}`), MASK],
  [token(String.raw`xai-[A-Za-z0-9]{16,}`), MASK],
  [token(String.raw`(?:npm_|hf_)[A-Za-z0-9]{16,}`), MASK],
  [token(String.raw`AIza[A-Za-z0-9_-]{16,}`), MASK],
  [token(String.raw`SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}`), MASK],
  [token(String.raw`eyJ[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{4,8000}\.[A-Za-z0-9_-]*`), MASK],
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi, `$1${MASK}`],
  [/(discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]+/gi, `$1${MASK}`],
  // An upper-case name ending like a secret's. Before the query rule: here & is part of the value.
  [/(\b[A-Z0-9_]{0,80}(?:KEY|TOKEN|SECRET|PASSWORD|PASS)\d{0,3}=)(?!•••)(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/g, maskUpperName],
  // In a query string a value ends at the next &; anywhere else & can be part of a password.
  [/([?&](?:[a-z0-9]{1,20}[_.-]){0,3}(?:key|apikey|token|secret|password|passwd|pwd|sig|signature|auth|credential|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // A name that ends like a secret's, then = or :, then the value: shell, env, JSON, YAML.
  [
    /((api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?key|private[_-]?key|account[_-]?key|auth[_-]?key|credentials|token|secret|password|passwd|passphrase|pwd|[_-]pass)(?:[_-](?:base64|base|value|b64|plain|text))?\d{0,4}\\?["']?\s{0,5}[=:]\s{0,5})(?!•••)([|>][+-]?[ \t]{0,5}(?:\n[ \t]{1,16}[^\n]*){1,200}|\\"[^"\n]*"?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|\S+)/gi,
    maskNamed,
  ],
  // Command-line flags.
  [/(--(?:[a-z0-9]{1,20}-){0,3}(?:token|password|passwd|api-?key|secret|secret-key|passphrase)(?:=|[ \t]{1,5}))(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/gi, `$1${MASK}`],
  [/(\bcurl(?:\.exe)?\b[^\n|;]{0,300}?\s(?:-u|--user|-U|--proxy-user)(?:=|[ \t]{0,5})["']?[^\s:"']{0,100}:)[^\s"']+/g, `$1${MASK}`],
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)(?:\.exe)?\b[^\n|;&]{0,300}?\s-p)\S+/g, `$1${MASK}`],
  [/(\bsshpass\s{1,3}-p\s{0,3})(?:"[^"\n]*"?|'[^'\n]*'?|\S+)/g, `$1${MASK}`],
  [/(\b(?:set-)?cookie["']?\s{0,5}:\s{0,5})[^\r\n"']+/gi, `$1${MASK}`],
  [/(\bdocker(?:\.exe)?\s{1,3}login\b[^\n|;&]{0,300}?\s(?:-p|--password)(?:=|[ \t]{0,5}))\S+/g, `$1${MASK}`],
  [/(\bredis-cli(?:\.exe)?\b[^\n|;&]{0,300}?\s-a[ \t]{1,5})\S+/g, `$1${MASK}`],
  // Credentials in a URL's authority; not a port and then a scoped package (`:443/@types`).
  [/(:\/\/[^\s/:@]{0,200}:)(?!\d{1,5}\/@[a-z])[^\s@]{1,500}(?:@[^\s@/]{1,200}){0,3}@/g, `$1${MASK}@`],
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
  const out = RULES.reduce<string>((t, [re, to]) => (typeof to === 'string' ? t.replace(re, to) : t.replace(re, to)), plainText(isCut ? text.slice(0, MAX_SCAN) : text))
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
