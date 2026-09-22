// Public renderer status only. A previous turn's connected display must not
// make a newly spawned guest appear ready while its official client boots.
export function guestCameraStatus({ active, attachedAt, mirror, now = Date.now() }) {
  if (!active) return { status: 'idle', ready: false }
  const fresh = Number.isFinite(mirror?.updated) &&
    now - mirror.updated >= -1000 && now - mirror.updated < 8000
  const current = Number.isFinite(attachedAt) && attachedAt > 0 &&
    Number.isFinite(mirror?.generation) && mirror.generation >= attachedAt
  const ready = Boolean(fresh && current && mirror.ready === true && mirror.viewer === true)
  return { status: ready ? 'connected' : 'starting', ready }
}
