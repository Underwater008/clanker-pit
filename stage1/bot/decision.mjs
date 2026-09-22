// Overlapped decision scheduling for the survival controller.
//
// The controller used to gate decisions behind a fixed interval: one action,
// then several seconds of standing still waiting for the next decision cycle.
// Here the next decision is requested while the current action runs, so the
// choice is usually ready the moment the action finishes. Safety reflexes
// still preempt: an emergency during the wait discards the in-flight
// decision and returns the reflex action immediately.

export function createDecisionMaker({
  jevChoose,
  identity,
  getPlan,
  skills,
  log,
  sleep,
  waitCapMs = 4000,
}) {
  let pending = null

  function fire() {
    const observation = skills.observation()
    const options = skills.candidates(observation)
    if (!Object.keys(options).length) return null
    const startedAt = Date.now()
    const p = Promise.resolve()
      .then(() =>
        jevChoose({
          identity,
          stance: getPlan(),
          observation,
          questionId: 'survival_action',
          options,
        }),
      )
      .then((r) => ({ r, startedAt }))
      .catch((e) => ({ r: { error: String(e) }, startedAt }))
    return { p, startedAt }
  }

  // Returns { choice, source } for the next action, or { urgent } when a
  // safety reflex must run first. Callers should treat 'fallback' choices as
  // scripted policy, not model decisions.
  async function next() {
    if (skills.emergency()) {
      pending = null
      return { urgent: skills.emergency() }
    }
    if (!pending) pending = fire()
    let settled = null
    if (pending) {
      const deadline = Date.now() + waitCapMs
      while (Date.now() < deadline) {
        let done = false
        await Promise.race([
          pending.p.then((v) => {
            settled = v
            done = true
          }),
          sleep(200),
        ])
        if (done) break
        if (skills.emergency()) {
          pending = null
          return { urgent: skills.emergency() }
        }
      }
      pending = null
    }
    // Validate the model's choice against fresh candidates: the world may
    // have moved on since the request was made.
    const options = skills.candidates(skills.observation())
    const compact = (opts) =>
      Object.fromEntries(
        Object.entries(opts).map(([key, description]) => [
          key,
          {
            desc: description.slice(0, 120),
            p: null,
          },
        ]),
      )
    let choice, source
    if (settled && !settled.r.error && options[settled.r.choice]) {
      choice = settled.r.choice
      source = 'jev'
      const withProbs = compact(options)
      for (const [key, value] of Object.entries(withProbs))
        value.p =
          typeof settled.r.probabilities?.[key] === 'number'
            ? Math.round(settled.r.probabilities[key] * 1000) / 1000
            : null
      log('jev_decision', {
        choice,
        durationMs: Date.now() - settled.startedAt,
        confidence: settled.r.confidence,
        model: settled.r.model,
        options: withProbs,
      })
    } else {
      if (settled?.r.error) log('jev_fallback', { error: settled.r.error })
      else if (settled) log('jev_stale_choice', { choice: settled.r.choice })
      choice = Object.keys(options)[0]
      source = 'fallback'
      // Labeled policy fallback, never presented as a model decision.
      log('fallback_decision', { choice, options: compact(options) })
    }
    // Overlap the next decision with the action the caller is about to run.
    pending = fire()
    return { choice, source }
  }

  return {
    next,
    cancel() {
      pending = null
    },
  }
}
