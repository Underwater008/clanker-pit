// Bounded, persisted evidence about attempts in a particular local situation.
// Model prose never writes this ledger. A changed place/terrain/inventory gets
// a new context; yesterday's blocked route must not blacklist today's repair.
export function createProgressMemory(state, { now = Date.now } = {}) {
  const data = state.progressMemory ??= { attempts: [], places: [], lastProgressAt: now() }
  data.attempts ??= []
  data.places ??= []
  data.accessFailures ??= []
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  function failures(context, action) {
    return data.attempts.filter((a) => a.context === context && (!action || a.action === action) &&
      !a.progress && now() - a.at < 180000)
  }
  return {
    record({ context, accessContext = context, action, before, after, changed, ok, error, source = null }) {
      const moved = distance(before, after)
      const progress = moved >= 0.75 || Boolean(changed)
      const entry = { context, action, at: now(), position: { ...before },
        moved: Math.round(moved * 100) / 100, progress, ok, source,
        error: error ? String(error).slice(0, 180) : null }
      if (moved < 0.75 && /path|navigation|goalchanged|deadline/i.test(entry.error ?? '')) {
        data.accessFailures.push({ context: accessContext, action, at: now(), error: entry.error })
        data.accessFailures = data.accessFailures.slice(-24)
      }
      data.attempts.push(entry)
      data.attempts = data.attempts.slice(-48)
      if (progress) {
        data.lastProgressAt = now()
        if (!data.places.some((p) => distance(p.position, after) < 2))
          data.places.push({ position: { ...after }, at: now(), via: action })
        data.places = data.places.slice(-16)
      }
      return entry
    },
    accessBlocked: (context) => data.accessFailures.filter((f) => f.context === context).length >= 2,
    blocked: (context, action) => failures(context, action).length >= 2,
    stalled: (context) => failures(context).length >= 2 &&
      !data.attempts.slice(-2).some((a) => a.progress),
    summary(context) {
      const failed = failures(context)
      return { stalled: failed.length >= 2 && !data.attempts.slice(-2).some((a) => a.progress),
        seconds_since_progress: Math.max(0, Math.round((now() - data.lastProgressAt) / 1000)),
        failed_here: failed.slice(-8).map(({ action, error, moved, at }) => ({ action, error, moved, at })),
        reached_places: data.places.slice(-6) }
    },
  }
}

// Consume a planner's explicit next action once. Textual steps never become
// code, coordinates, or executable actions. Revalidate against current choices.
export function consumePlanAction(plan, options, lastConsumed, now = Date.now()) {
  if (!plan?.nextAction || !plan.issuedAt || plan.issuedAt === lastConsumed)
    return null
  const reason = !Number.isFinite(plan.expiresAt) || now > plan.expiresAt ? 'expired'
    : !Object.hasOwn(options, plan.nextAction) ? 'no_longer_feasible' : null
  return { choice: reason ? null : plan.nextAction, reason, consumed: plan.issuedAt }
}
