/**
 * `@frameblame/agent` — the code that runs inside the app being measured.
 *
 * Its whole job is to install the observers, convert what they report into
 * plain records, and get those records out of the page as cheaply as possible.
 * It does no attribution: anything that thinks belongs in `@frameblame/core`,
 * which can then be tested without a browser.
 *
 * What is deliberately not here yet: the observers themselves. Registering the
 * Long Animation Frame observer and starting a `Profiler` is a few lines each,
 * but both have field names and lifecycle details that the invariants say must
 * be checked against the current specs rather than written from memory, and the
 * v0.1 spike reads both APIs directly in a bare script so that what lands here
 * is shaped by what the signals actually look like. See `spike/` and
 * `findings.md`.
 */

export { createBroadcastChannelTransport, DEFAULT_CHANNEL_NAME } from './transport.ts';
export type { Transport } from './transport.ts';
