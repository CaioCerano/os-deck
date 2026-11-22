// A line of shell as sh and cmd would both read it, or why it cannot be told.

/** `isPlain`: every shell reads it as this one word, so it may name what runs. */
export type Word = { text: string; isPlain: boolean; isQuoted: boolean }
type Line = { commands: Word[][]; joins: string[] }

export const literal = (text: string): Word => ({ text, isPlain: true, isQuoted: false })

/**
 * A script's line split as sh and cmd both would, or why not: what one shell reads otherwise than the
 * other, or expands, is not guessed at.
 */
export const readLine = (line: string): Line | { why: string } => {
  if (/%[^%]+%/.test(line)) return { why: 'it expands a variable' }
  const out: Line = { commands: [], joins: [] }
  let words: Word[] = []
  let text = ''
  let isWord = false
  let isQuoted = false
  let isPlain = true
  let isGlob = false
  let dropsNext = false
  const endWord = (): string | null => {
    if (!isWord) return null
    if (isGlob && !/^[\w./]/.test(text)) return 'it expands names that could be anything'
    if (dropsNext) dropsNext = false
    else words.push({ text, isPlain: isPlain && !isGlob, isQuoted })
    text = ''
    isWord = isQuoted = isGlob = false
    isPlain = true
    return null
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1)
      if (end < 0) return { why: 'a quote in it is not closed' }
      const inner = line.slice(i + 1, end)
      if (ch === '"') {
        if (/[\\^]/.test(inner)) return { why: 'it uses a shell escape' }
        if (/[$`]/.test(inner)) return { why: 'it expands a variable or a command' }
      } else {
        // To cmd a single quote is a letter like any other.
        if (/[&|<>()^"]/.test(inner)) return { why: 'cmd reads its quotes otherwise' }
        isPlain = false
      }
      text += inner
      isWord = isQuoted = true
      i = end
      continue
    }
    if (ch === ' ') {
      const why = endWord()
      if (why) return { why }
    } else if (ch === '\\' || ch === '^') return { why: 'it uses a shell escape' }
    else if (ch === '$' || ch === '`') return { why: 'it expands a variable or a command' }
    else if (ch === '(' || ch === ')') return { why: 'it groups commands' }
    else if (ch === '<') return { why: 'it feeds a command its input' }
    else if (ch === '>') {
      // A bare number before it names a pipe.
      if (isWord && !isQuoted && /^\d$/.test(text)) {
        text = ''
        isWord = false
      }
      const why = endWord()
      if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
      if (line[i + 1] === '>') i += 1
      const pipe = /^&\d/.exec(line.slice(i + 1))
      if (pipe) i += pipe[0].length
      else dropsNext = true
    } else if (ch === '&' || ch === '|' || ch === ';') {
      const why = endWord()
      if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
      const isDouble = ch !== ';' && line[i + 1] === ch
      if (isDouble) i += 1
      if (words.length === 0) return { why: 'a command in it is empty' }
      out.commands.push(words)
      out.joins.push(isDouble ? ch + ch : ch)
      words = []
    } else {
      // A comment to sh, and to cmd a command like the rest.
      if (ch === '#' && !isWord) return { why: 'it holds a comment, which cmd runs' }
      if (ch === '~' && (!isWord || /[=:]$/.test(text))) return { why: 'it expands a home folder' }
      if ('*?[]{}'.includes(ch)) isGlob = true
      text += ch
      isWord = true
    }
  }
  const why = endWord()
  if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
  if (words.length === 0 && out.commands.length > 0) return { why: 'a command in it is empty' }
  if (words.length > 0) out.commands.push(words)
  return out
}
