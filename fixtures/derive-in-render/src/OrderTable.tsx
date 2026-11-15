import type { Order } from './orders.ts';

/**
 * The component this fixture exists to blame.
 *
 * The bug: the filtered-and-sorted view of the orders is derived in the render
 * body, so it is recomputed from scratch on every keystroke, and the comparator
 * is `localeCompare` — correct for names with diacritics and roughly two orders
 * of magnitude slower than a plain comparison. Sorting ten thousand rows takes
 * about 133,000 comparisons, each constructing a collator, and all of it lands
 * inside the frame that is also trying to show the user the character they just
 * typed.
 *
 * It is a realistic bug rather than a contrived one: every part of it is a
 * defensible local decision. Derive in render rather than cache a stale value;
 * sort by name because the table is sorted by name; use `localeCompare` because
 * `<` gets the diacritics wrong. The cost only appears when they combine.
 *
 * Only the first page of rows is rendered. The fixture has to jank for exactly
 * one reason, and committing ten thousand rows would add a second, larger cost
 * that attribution could hide behind.
 */

/** How many of the sorted rows are actually rendered. */
const PAGE_SIZE = 50;

export interface OrderTableProps {
  readonly orders: readonly Order[];
  readonly query: string;
}

export function OrderTable({ orders, query }: OrderTableProps) {
  // @ground-truth: the two lines below are the fixture's known culprit.
  const visible = orders
    .filter((order) => order.customer.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.customer.localeCompare(b.customer));

  return (
    <table data-fixture="order-table">
      <thead>
        <tr>
          <th>Reference</th>
          <th>Customer</th>
          <th>Status</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {visible.slice(0, PAGE_SIZE).map((order) => (
          <tr key={order.id}>
            <td>{order.reference}</td>
            <td>{order.customer}</td>
            <td>{order.status}</td>
            <td>{order.total.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4} data-fixture="match-count">
            {visible.length} of {orders.length} orders
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
