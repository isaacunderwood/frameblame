/**
 * The seam between the page being measured and the tab doing the reporting.
 *
 * The UI deliberately lives in a separate tab: a panel rendered into the host
 * app contaminates the very frames it reports on, and a React panel pollutes
 * the commit stream used for attribution — worst during slow frames, when it
 * has the most to redraw. So records have to leave the page, and this is the
 * interface they leave through.
 *
 * `BroadcastChannel` is the v0.1 implementation because it is same-origin, zero
 * setup and already structured-clone based. It is behind an interface because
 * the two deferred consumers need different wires: a CDP-driven CLI reads
 * records out over the protocol, and a CI reporter writes them to disk. Neither
 * should require touching the collector.
 *
 * The transport deliberately does not know what a record means. It does no
 * batching policy, no sampling and no retry — the collector decides what to
 * send and when, because only the collector knows what is cheap to do during a
 * frame.
 */

/**
 * A one-way channel for signal records, page to consumer.
 *
 * `send` must be safe to call from inside a `PerformanceObserver` callback,
 * which runs on the main thread during the very frames being measured. An
 * implementation that blocks there is measuring itself.
 */
export interface Transport<TRecord> {
  send(record: TRecord): void;
  close(): void;
}

/**
 * The channel name both halves agree on.
 *
 * Versioned in the name rather than in a handshake: a stale viewer tab left
 * open from a previous install should hear nothing at all, rather than receive
 * records it will misread.
 */
export const DEFAULT_CHANNEL_NAME = 'frameblame.v0';

/**
 * Creates a transport that posts records onto a `BroadcastChannel`.
 *
 * Same-origin only, and silent if nobody is listening — which is the normal
 * case, since the page is usually running without a viewer tab open. Records
 * must be structured-cloneable; in particular a raw `PerformanceEntry` is not,
 * so callers convert entries to plain records before sending.
 */
export function createBroadcastChannelTransport<TRecord>(
  channelName: string = DEFAULT_CHANNEL_NAME,
): Transport<TRecord> {
  const channel = new BroadcastChannel(channelName);

  return {
    send(record) {
      channel.postMessage(record);
    },
    close() {
      channel.close();
    },
  };
}
