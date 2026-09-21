// Cinder's memory: append-only event log + derived beliefs/intentions.
// Three kinds of records are kept strictly separate (per docs/PLAN.md):
//   observed events — what actually happened, from the controller's senses
//   beliefs         — model-generated interpretations pointing back to event ids
//   intentions      — current goals/constraints the character has chosen
// Persisted as JSONL so a run can be replayed and audited.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class Memory {
  constructor(path) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.events = []
    this.beliefs = []
    this.intentions = []
    this.seq = 0
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const rec = JSON.parse(line)
        this.seq = Math.max(this.seq, rec.id)
        if (rec.kind === 'event') this.events.push(rec)
        else if (rec.kind === 'belief') this.beliefs.push(rec)
        else if (rec.kind === 'intention') this.intentions.push(rec)
      }
    }
  }

  #write(kind, data) {
    const rec = { id: ++this.seq, kind, t: new Date().toISOString(), ...data }
    appendFileSync(this.path, JSON.stringify(rec) + '\n')
    return rec
  }

  /** What actually happened. Never model-authored. */
  event(type, data) {
    const rec = this.#write('event', { type, data })
    this.events.push(rec)
    return rec
  }

  /** Model-authored interpretation. Must cite the event ids it explains. */
  belief(text, aboutEvents, confidence = null) {
    const rec = this.#write('belief', { text, aboutEvents, confidence })
    this.beliefs.push(rec)
    return rec
  }

  /** Current goal/constraint chosen by the character. */
  intention(text, fromBelief = null) {
    const rec = this.#write('intention', { text, fromBelief })
    this.intentions.push(rec)
    return rec
  }

  /** Compact recent memory for model prompts (bounded size). */
  recentContext(maxEvents = 8, maxBeliefs = 4) {
    return {
      events: this.events.slice(-maxEvents).map((e) => `#${e.id} ${e.type}: ${JSON.stringify(e.data)}`),
      beliefs: this.beliefs.slice(-maxBeliefs).map((b) => `${b.text} (about ${b.aboutEvents.map((i) => '#' + i).join(',')})`),
      intentions: this.intentions.slice(-3).map((i) => i.text),
    }
  }
}
