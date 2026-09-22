// Overlap one bounded Jev request with gameplay. A slow request is retained
// while scripted actions continue; the wait cap is not a provider deadline.
// Safety reflexes abort the request, and every response is checked against
// current candidates before it can become an action.
export function createDecisionMaker({
  jevChoose,
  identity,
  getPlan,
  skills,
  log,
  sleep,
  waitCapMs = 4000,
  minRequestIntervalMs = 2500,
  maxChoiceAgeMs = 15000,
}) {
  let pending = null
  let nextRequestAt = 0
  let closed = false
  const compact = (options) => Object.fromEntries(
    Object.entries(options).map(([key, description]) => [
      key, { desc: String(description).slice(0, 120), p: null },
    ]),
  )

  function cancel(reason = 'cancelled') {
    if (!pending || pending.invalidated) return
    pending.invalidated = reason
    pending.controller.abort()
    log('jev_status', { status: 'cancelled', reason })
    // Retain the slot until the transport acknowledges cancellation. Even a
    // provider/client that ignores abort cannot create overlapping requests.
  }

  function fire() {
    if (closed || pending || Date.now() < nextRequestAt) return
    const observation = skills.observation()
    const options = skills.candidates(observation)
    if (!Object.keys(options).length) return
    const request = {
      startedAt: Date.now(),
      controller: new AbortController(),
      invalidated: null,
      settled: false,
      result: null,
    }
    pending = request
    nextRequestAt = request.startedAt + minRequestIntervalMs
    log('jev_status', {
      status: 'pending', requestedAt: new Date(request.startedAt).toISOString(),
    })
    request.p = Promise.resolve()
      .then(() => jevChoose({
        identity, stance: getPlan(), observation,
        questionId: 'survival_action', options,
        signal: request.controller.signal,
      }))
      .catch((error) => ({ error: String(error) }))
      .then((result) => {
        request.settled = true
        request.result = result
        if (!request.invalidated) log('jev_status', {
          status: result.error ? 'error' : 'ready',
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - request.startedAt,
          error: result.error ?? null,
        })
      })
  }

  async function next() {
    const urgent = skills.emergency()
    if (urgent) {
      cancel('safety_reflex')
      return { urgent }
    }
    if (pending?.settled && pending.invalidated) pending = null
    fire()
    const request = pending
    if (request && !request.settled && !request.invalidated) {
      const deadline = Date.now() + waitCapMs
      while (!request.settled && !request.invalidated && Date.now() < deadline) {
        await Promise.race([request.p, sleep(Math.min(200, Math.max(1, deadline - Date.now())))])
        const emergency = skills.emergency()
        if (emergency) {
          cancel('safety_reflex')
          return { urgent: emergency }
        }
      }
    }
    const options = skills.candidates(skills.observation())
    const result = request?.settled && !request.invalidated ? request.result : null
    const age = request ? Date.now() - request.startedAt : null
    let choice, source, reason
    if (result && !result.error && age <= maxChoiceAgeMs && Object.hasOwn(options, result.choice)) {
      choice = result.choice
      source = 'jev'
      const withProbs = compact(options)
      for (const [key, value] of Object.entries(withProbs)) {
        const probability = result.probabilities?.[key]
        value.p = typeof probability === 'number' && Number.isFinite(probability)
          ? Math.round(probability * 1000) / 1000 : null
      }
      log('jev_decision', {
        choice, durationMs: age, confidence: result.confidence,
        model: result.model, options: withProbs,
      })
    } else {
      reason = request?.invalidated ?? (result?.error ? 'provider_error'
        : result && age > maxChoiceAgeMs ? 'expired_observation'
        : result ? 'stale_choice'
        : request ? 'request_pending' : 'request_interval')
      choice = Object.keys(options)[0]
      source = 'fallback'
      log('fallback_decision', {
        choice, reason, error: result?.error ?? null,
        requestPending: Boolean(request && !request.settled),
        durationMs: age, options: compact(options),
      })
    }
    // An unresolved call continues during the fallback action. Never drop it
    // and start another just because the controller's wait cap elapsed.
    if (request?.settled && pending === request) pending = null
    fire()
    return { choice, source, reason }
  }

  return {
    next,
    cancel,
    close() {
      closed = true
      cancel('controller_stopped')
    },
  }
}
