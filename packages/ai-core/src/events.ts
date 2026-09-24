import type { AiEvent } from "./types.js";

export class EventLog {
  private readonly events: AiEvent[] = [];

  append(event: AiEvent): void { this.events.push(Object.freeze({ ...event })); }
  list(): AiEvent[] { return this.events.map(e => ({ ...e, payload: { ...e.payload } })); }
}
