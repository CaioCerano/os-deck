/** A name Windows opens as something other than the file so named. */
export const isWindowsOddName = (name: string) =>
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.|$)/i.test(name) || /[. ]$/.test(name) || name.includes(':')

/** Case folded as NTFS folds what is written here: ASCII alone. Unicode's folding makes one name of two files. */
export const foldCase = (text: string) => text.replace(/[A-Z]+/g, s => s.toLowerCase())
