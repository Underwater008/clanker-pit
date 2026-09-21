// Serverless proxy for bot telemetry: fetches state.json from the pod and
// returns it with CORS headers, so the HUD overlay can poll it from the browser.
export default async function handler(req, res) {
  const POD_STATE = 'https://guobivt35b9pkf-8081.proxy.runpod.net/arena/state.json'
  try {
    const r = await fetch(POD_STATE, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) throw new Error(`pod responded ${r.status}`)
    const data = await r.json()
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json(data)
  } catch (e) {
    res.status(502).json({ error: String(e).slice(0, 200) })
  }
}
