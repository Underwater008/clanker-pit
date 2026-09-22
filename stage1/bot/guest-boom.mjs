// One summon attempt per guest turn. A nearby creeper is not proof of an
// explosion; only the server's explosion packet can debit the Server coolant.
export async function confirmGuestExplosion({ client, position, summon, timeoutMs = 8000 }) {
  let timer
  let finish
  const observed = new Promise((resolve) => { finish = resolve })
  const onExplosion = (packet) => {
    const p = packet.center ?? packet
    if ([p.x, p.y, p.z].every(Number.isFinite) &&
        Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z) < 4)
      finish({ x: p.x, y: p.y, z: p.z })
  }
  client.on('explosion', onExplosion)
  timer = setTimeout(() => finish(null), timeoutMs)
  try {
    // A lost acknowledgement is uncertain, never permission to summon again.
    // The observation deadline also bounds a stalled RCON connection/send.
    // The single pending send may finish later, but is never retried.
    void Promise.resolve().then(summon).catch(() => {})
    return await observed
  } finally {
    clearTimeout(timer)
    client.removeListener('explosion', onExplosion)
  }
}
