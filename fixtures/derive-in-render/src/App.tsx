import { useState } from 'react';

import { OrderTable } from './OrderTable.tsx';
import { createOrders } from './orders.ts';

/**
 * The fixture's shell: a controlled filter input and the table that janks.
 *
 * The orders are built once at module scope so that generating them can never
 * land inside a measured frame. Everything this component does per keystroke is
 * cheap; all of the cost is in `OrderTable`, which is the point — attribution
 * has to pick the child out, not the component that owns the state.
 */

const orders = createOrders();

export function App() {
  const [query, setQuery] = useState('');

  return (
    <main
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        margin: '0 auto',
        maxWidth: '60rem',
        padding: '2rem 1.5rem',
      }}
    >
      <h1 style={{ fontSize: '1.125rem' }}>Orders</h1>
      <p style={{ opacity: 0.7 }}>
        Fixture: derive-in-render. Typing here janks on purpose. The cause is recorded in{' '}
        <code>ground-truth.json</code>.
      </p>
      <label>
        Filter by customer{' '}
        <input
          data-fixture="filter-input"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          type="search"
          value={query}
        />
      </label>
      <OrderTable orders={orders} query={query} />
    </main>
  );
}
