import { createContext } from 'react';

/**
 * The context `ContextConsumer` subscribes to and `App` provides.
 *
 * It lives in its own module only because `App` provides it while a component
 * in `causes.tsx` consumes it; declaring it in either of those would make the
 * two import each other.
 *
 * It deliberately carries nothing but a number. The payload is irrelevant — the
 * fixture is about the *shape* of a re-render cause, and a context update is
 * the one cause that reaches a component without its props changing at all,
 * which is precisely the case React's span gate cannot see.
 */
export const BumpCountContext = createContext(0);
