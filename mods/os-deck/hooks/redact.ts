// Text made safe before it is stored, drawn or notified: control characters out (the engine refuses
// a whole pane for one), credentials masked. The rules read untrusted text of any
// length (commands, agent answers, pull request titles), so each is linear: a repeat that can be
// retried from many starting points is bounded.

const MASK = '•••'
/** Text past this is not scanned, so it is not kept either. */
const MAX_SCAN = 50_000
/** Dropped from the end of cut text: a secret the cut split no longer matches its rule. */
const CUT_MARGIN = 512

// RULES only ever grows at MORE: changing or reordering these has leaked what they used to hide.
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

// Formats added since. They run after RULES, so they can only hide more.
const MORE: readonly [RegExp, string][] = [
  // Known shapes where a word boundary misses them: after `_`, an escape, or a percent-encoded byte.
  [/(?<=_|\\[nrt]|%[0-9A-Fa-f]{2})(?:gh[opsur]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,})/g, MASK],
  [/(?:shpat|shpss|shpca)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{16,}|dop_v1_[A-Za-z0-9]{16,}/g, MASK],
  [/(?<![A-Za-z0-9])xai-[A-Za-z0-9]{16,}/g, MASK],
  [/(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}/g, MASK],
  [/(discord(?:app)?\.com\/api\/(?:v\d{1,3}\/)?webhooks\/)[A-Za-z0-9/_-]+/gi, `$1${MASK}`],
  // Secret names with an ending: SECRET2, secret_key_base, client_secret_value, db_pass, CREDENTIALS.
  [/((?:api[_-]?key|secret[_-]?key|secret|token|password|passwd)(?:[_-](?:base64|base|value|b64|plain|text)\d{0,4}|\d{1,4})\\?["']?\s{0,5}[=:]\s{0,5})(?:\\"[^"\n]*"?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|\S+)/gi, `$1${MASK}`],
  [/([_-]pass\\?["']?\s{0,3}[=:]\s{0,3})(?:\\"[^"\n]*"?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|\S+)/gi, `$1${MASK}`],
  [/(\b[A-Z0-9_]{0,80}CREDENTIALS=)(?:\\"[^"\n]*"?|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|\S+)/g, `$1${MASK}`],
  // YAML under a secret's name: the lines indented deeper than it carry on the value RULES just masked.
  [/^([ \t]{0,40})([^\n:]{0,80}(?:password|passwd|passphrase|pwd|secret|token|key|credentials|[_-]pass)\d{0,3}["']?[ \t]{0,3}:[ \t]{0,3}(?:•••|[|>][+-]?\d?[+-]?)[ \t]{0,5}(?:#[^\n]{0,200})?)(?:\n[ \t]{0,40}(?=\n)|\n\1[ \t][^\n]*){1,200}/gim, `$1$2\n$1  ${MASK}`],
  // Outside a query string an & is part of the password.
  [/((?:^|\s)[\w.-]{0,40}(?:password|passwd|pwd|secret|token)=•••)&\S+/gi, `$1`],
]

// Ordinary text the rules would hide. Each is whole space-separated words from a closed list, so none
// can hold a secret or the trigger of a rule (a path or a URL can hold `--token`, so neither is here).
// Extend the lists; never open one up to "anything that looks like words".
const FLAG = String.raw`(?:BYPASS|COMPASS|SURPASS|MONKEY|DONKEY|TURKEY|HOCKEY)=(?:0|1|true|false|yes|no|on|off)`
const NAME_PART = '(?:learn|contrib|dashboard|migration|fix|release|index|build|test|column|constraint|image|docs)'
const KEY_LIKE_NAME = String.raw`(?:(?:feature|fix|chore|release)/)?(?:sk|pk|rk)(?:[-_]${NAME_PART}(?:20\d\d)?){1,4}(?:/${NAME_PART})?(?:\.(?:ts|tsx|js|py|md))?`
const CODE = String.raw`(?:token|secret|password|apiKey) = (?:(?:get|read|load|fetch|create|generate)(?:Token|Secret|Password|ApiKey|Key|Credentials)\(\)|os\.environ\[["'][A-Z_]{1,24}["']\]);?`
const TITLE = String.raw`(?:token|secret|password): (?:add|allow|avoid|check|expire|expiry|fix|handle|refresh|rename|remove|reset|rotate|rotation|support|update|use|validate|validation)(?= [A-Za-z]{2})`
const ORDINARY = new RegExp(`(?<=^|\\s)(?:${[FLAG, KEY_LIKE_NAME, CODE, TITLE].join('|')})(?=\\s|$)`, 'g')
/** One character stands in for each piece of ordinary text while the rules run. Never valid text. */
const HOLDER = /[﷐-﷯]/g
const HOLDERS = 32

/** Masks with every rule, ordinary text held out of their way. */
const maskSecrets = (text: string) => {
  const kept: string[] = []
  const held = text
    .replace(HOLDER, '')
    .replace(ORDINARY, found => (kept.length < HOLDERS ? String.fromCharCode(0xfdd0 + kept.push(found) - 1) : found))
  return [...RULES, ...MORE].reduce((t, [re, to]) => t.replace(re, to), held).replace(HOLDER, ch => kept[ch.charCodeAt(0) - 0xfdd0] ?? '')
}

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
  const out = maskSecrets(plainText(isCut ? text.slice(0, MAX_SCAN) : text))
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
