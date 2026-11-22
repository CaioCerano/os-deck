/** A name Windows opens as something other than the file so named. */
export const isWindowsOddName = (name: string) =>
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/i.test(name) || /[. ]$/.test(name) || name.includes(':')

/** Case folded as NTFS folds what is written here: ASCII alone. Unicode's folding makes one name of two files. */
export const foldCase = (text: string) => text.replace(/[A-Z]+/g, s => s.toLowerCase())

/**
 * A path as a tool or a person gave it, absolute as this system takes it from `cwd`. Null where that
 * is not certain (`~`, a drive's current folder, a stream, the network): never joined on a guess.
 */
export const placedPath = (given: string, cwd: string): string | null => {
  const path = given.trim()
  if (path === '' || path.startsWith('~') || /^[\\/]{2}/.test(path)) return null
  const base = cwd.replace(/[\\/]+$/, '')
  if (!/^[A-Za-z]:/.test(cwd)) return path.startsWith('/') ? path : `${base}/${path}`
  const rest = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path
  if (rest.includes(':')) return null
  if (rest !== path) return path
  // Windows takes a leading slash to the root of the drive it is on.
  return /^[\\/]/.test(path) ? `${cwd.slice(0, 2)}${path}` : `${base}/${path}`
}
