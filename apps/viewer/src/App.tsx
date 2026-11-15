import { useEffect, useState } from 'react';

import { DEFAULT_CHANNEL_NAME } from '@frameblame/agent';

/**
 * The viewer's first screen.
 *
 * It reports the one thing it can honestly report before the engine exists:
 * whether anything is arriving on the transport channel. No sample frames and
 * no placeholder cards — a UI that shows invented attributions is worse than an
 * empty one, because the whole claim of this tool is that its numbers are real.
 *
 * Records are counted as `unknown` rather than parsed: their shape is settled
 * by the v0.1 spike, not by this file.
 */
export function App() {
  const [recordCount, setRecordCount] = useState(0);

  useEffect(() => {
    const channel = new BroadcastChannel(DEFAULT_CHANNEL_NAME);
    channel.onmessage = () => {
      setRecordCount((count) => count + 1);
    };

    return () => {
      channel.close();
    };
  }, []);

  return (
    <main
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: 1.6,
        margin: '0 auto',
        maxWidth: '44rem',
        padding: '3rem 1.5rem',
      }}
    >
      <h1 style={{ fontSize: '1.25rem' }}>frameblame</h1>
      <p>
        Which component caused that janky frame, and on what line. This tab is the
        reporting UI; it runs outside the app being measured so that its own rendering
        cannot show up in the frames it reports on.
      </p>
      <p>
        Listening on <code>{DEFAULT_CHANNEL_NAME}</code> — {recordCount}{' '}
        {recordCount === 1 ? 'record' : 'records'} received.
      </p>
      <p style={{ opacity: 0.7 }}>
        No collector is shipping records yet. The v0.1 spike is establishing whether the
        three signals correlate cleanly enough to attribute a frame at all; until it has,
        this screen deliberately shows nothing but the channel.
      </p>
    </main>
  );
}
