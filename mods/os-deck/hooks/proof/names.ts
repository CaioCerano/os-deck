/** A name Windows opens as something other than the file so named. */
export const isWindowsOddName = (name: string) =>
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/i.test(name) || /[. ]$/.test(name) || name.includes(':')

/** Case folded as NTFS folds what is written here: ASCII alone. Unicode's folding makes one name of two files. */
export const foldCase = (text: string) => text.replace(/[A-Z]+/g, s => s.toLowerCase())

/**
 * The one fold of a path compared whole: its drive's letter. The rest is as the disk spells it, for a
 * folder of Windows can be case-sensitive, and there `Repo` and `repo` are two.
 */
export const foldDrive = (path: string) => path.replace(/^[A-Za-z]:/, drive => drive.toLowerCase())

const onWindows = (cwd: string) => /^[A-Za-z]:/.test(cwd)
/** A path trimmed, `/d/x` on Windows drive D's, as the file tools read it. */
const asToolsRead = (given: string, cwd: string) =>
  onWindows(cwd) ? given.trim().replace(/^\/([A-Za-z])\//, (_, drive: string) => `${drive.toUpperCase()}:/`) : given.trim()

/**
 * Where an edit's path is, from the path alone. A relative one is resolved from the caller's folder
 * as the tool ran, which nothing here knows, so it has none, as one with no drive has none.
 */
export const editPath = (named: string, cwd: string): string | null => {
  const path = asToolsRead(named, cwd)
  const isFull = onWindows(cwd) ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/')
  return isFull ? placedPath(path, cwd) : null
}

/**
 * A path as a person gave it, absolute as this system takes it from `cwd`. Null where that is not
 * certain (`~`, a drive's current folder, a stream, the network): never joined on a guess.
 */
export const placedPath = (given: string, cwd: string): string | null => {
  const path = asToolsRead(given, cwd)
  if (path === '' || path.startsWith('~') || /^[\\/]{2}/.test(path)) return null
  const base = slashed(cwd).replace(/\/+$/, '')
  if (!onWindows(cwd)) return path.startsWith('/') ? path : `${base}/${path}`
  const rest = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path
  if (rest.includes(':')) return null
  if (rest !== path) return path
  // Windows takes a leading slash to the root of the drive it is on.
  return /^[\\/]/.test(path) ? `${cwd.slice(0, 2)}${path}` : `${base}/${path}`
}

/** Slashes in place of backslashes in a drive's path, which `system` says it is. Off Windows a backslash is a letter. */
export const slashed = (path: string, system = path) => (onWindows(system) ? path.replace(/\\/g, '/') : path)

/**
 * Why there is no Agent Proof where the session is; null on a drive of Windows. How names resolve on
 * other systems' disks (case, Unicode, links) was never held against a real one, and each rule guessed
 * wrong there was a false Verified: so nothing can be drafted there, and so nothing allowed.
 */
export const unsupportedHere = (cwd: string): string | null =>
  /^[A-Za-z]:[\\/]/.test(cwd)
    ? null
    : 'OS-Deck proof: Agent Proof works on Windows alone, in a folder on a drive. Elsewhere it is untested, so nothing can be allowed. The rest of os-deck works as it does.'
