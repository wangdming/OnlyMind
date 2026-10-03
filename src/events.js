import { EventEmitter } from 'node:events';

// Central bus for live task updates, consumed by the SSE endpoint.
// Events (per task id):
//   chunk:<id>  -> (text)   incremental output delta
//   status:<id> -> (task)   status transition (running/done/failed/canceled)
export const taskBus = new EventEmitter();
taskBus.setMaxListeners(0); // many concurrent SSE subscribers are fine

export function emitChunk(id, text) {
  taskBus.emit(`chunk:${id}`, text);
}
export function emitStatus(id, task) {
  taskBus.emit(`status:${id}`, task);
}
