// Alerts: a native notification when a permission ask has waited on the person a while, and when a
// long turn ends, so a session left in the background still gets their attention. Sent through the
// person's own notification channel (`$.ui.notify`: iTerm2, kitty, Ghostty, the terminal bell or the
// desktop app); a toast in the pane where none is set up.
import type { EngineInterface } from 'claude-code'

/** How long an ask waits before it is announced, and how long a turn runs before its end is. */
export const ASK_ALERT_MS = 30_000
export const LONG_TURN_MS = 120_000

export type AlertConfig = { isOn: boolean; askAfterMs: number; longTurnMs: number }

/** The words of an ask's alert: what waits, and for how long. */
export const askAlertText = (tool: string, detail: string, waitedMs: number) =>
  `${tool} waits for your ok (${Math.round(waitedMs / 1000)} s)${detail ? `: ${detail}` : ''}`

/** The words of a finished turn's alert: how it ended and how long it took. */
export const turnAlertText = (reason: string, durationMs: number, edits: number, errors: number) => {
  const mins = Math.max(1, Math.round(durationMs / 60_000))
  const how = reason === 'answer' ? 'finished' : reason === 'aborted' ? 'was stopped' : `ended (${reason})`
  const what = [edits > 0 ? `${edits} edit${edits === 1 ? '' : 's'}` : '', errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
  return `The turn ${how} after ${mins} min${what ? ` · ${what}` : ''}`
}

/** Whether a finished turn is worth announcing: long enough, and not one the person stopped themselves. */
export const isTurnAlert = (cfg: AlertConfig, reason: string, durationMs: number) => cfg.isOn && reason !== 'aborted' && durationMs >= cfg.longTurnMs

/** Sends one alert, a toast where no notification channel takes it. Never throws. */
export async function sendAlert($: EngineInterface, text: string, key: string): Promise<boolean> {
  try {
    const sent = await $.ui.notify(text, { title: 'OS-Deck', key })
    if (sent.isSent) return true
  } catch {
    // A refusing hook or a failed write: the toast below still says it.
  }
  try {
    $.ui.toast(text, { timeoutMs: 8000 })
  } catch {
    // No surface to toast on either.
  }
  return false
}

const pending = new Map<string, { cancel: () => void }>()

/**
 * Announces an ask once it has waited `askAfterMs`, unless `isStillWaiting` says it settled first.
 * One timer per call; `settleAskAlert` drops it early when the call settles.
 */
export function scheduleAskAlert($: EngineInterface, cfg: AlertConfig, id: string, tool: string, detail: string, isStillWaiting: () => Promise<boolean>) {
  if (!cfg.isOn || pending.has(id)) return
  const timer = $.clock.after(cfg.askAfterMs, () => {
    pending.delete(id)
    void isStillWaiting()
      .then(still => (still ? sendAlert($, askAlertText(tool, detail, cfg.askAfterMs), `ask-${id}`) : false))
      .catch(() => undefined)
  })
  pending.set(id, timer)
}

export function settleAskAlert(id: string) {
  pending.get(id)?.cancel()
  pending.delete(id)
}

/** Drops every waiting timer: the session is ending. */
export function stopAlerts() {
  for (const t of pending.values()) t.cancel()
  pending.clear()
}
