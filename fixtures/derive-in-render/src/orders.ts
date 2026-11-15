/**
 * The fixture's data, generated deterministically.
 *
 * Deterministic because the fixture is ground truth for an accuracy suite: the
 * same seed must produce the same row count, the same name distribution and so
 * the same amount of comparison work on every run, or a regression in
 * attribution is indistinguishable from a slower dataset.
 *
 * The names carry diacritics on purpose. They are the reason a developer
 * reaches for `localeCompare` instead of `<`, which is the mistake the fixture
 * is built around — the correct-looking choice that happens to be two orders of
 * magnitude slower.
 */

export interface Order {
  readonly id: number;
  readonly customer: string;
  readonly reference: string;
  readonly total: number;
  readonly status: 'pending' | 'shipped' | 'refunded';
}

/* A 32-bit xorshift, inlined rather than imported: the fixture must have no
 * dependencies beyond React, so that nothing in `node_modules` can appear in a
 * profiler stack and muddy the attribution being tested. */
function createRandom(seed: number): () => number {
  let state = seed | 0 || 1;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/* Typed as non-empty so that `pick` can fall back to the first element
 * instead of asserting that a scaled random index is in range. */
type NonEmpty<T> = readonly [T, ...T[]];

const GIVEN_NAMES: NonEmpty<string> = [
  'Zoë',
  'Ólafur',
  'Mikkel',
  'Åsa',
  'Émile',
  'Sofía',
  'Łukasz',
  'Ingrid',
  'Jürgen',
  'Chloé',
  'Søren',
  'Agnès',
];

const FAMILY_NAMES: NonEmpty<string> = [
  'Ångström',
  'Özdemir',
  'Lindqvist',
  'Dvořák',
  'Núñez',
  'Széchenyi',
  'Þórisdóttir',
  'Mäkinen',
  'Fernández',
  'Çelik',
  'Jørgensen',
  'Esposito',
];

const STATUSES: NonEmpty<Order['status']> = ['pending', 'shipped', 'refunded'];

/** Picks one element uniformly, given a generator in [0, 1). */
function pick<T>(items: NonEmpty<T>, random: () => number): T {
  // The `??` branch is unreachable for a generator in range, and is here so
  // the function needs no non-null assertion to say so.
  return items[Math.floor(random() * items.length)] ?? items[0];
}

/** How many rows the fixture holds. Sized in `App.tsx`'s comment block. */
export const ORDER_COUNT = 10_000;

/**
 * Builds the fixture's order list.
 *
 * Pure apart from the fixed seed, and called once at module scope so that
 * generation cost never lands inside a measured frame — the fixture must jank
 * for exactly one reason.
 */
export function createOrders(count: number = ORDER_COUNT): readonly Order[] {
  const random = createRandom(0x5eed);
  const orders: Order[] = [];

  for (let id = 0; id < count; id += 1) {
    const given = pick(GIVEN_NAMES, random);
    const family = pick(FAMILY_NAMES, random);
    const status = pick(STATUSES, random);

    orders.push({
      id,
      customer: `${given} ${family}`,
      reference: `ORD-${String(100_000 + id)}`,
      total: Math.round(random() * 50_000) / 100,
      status,
    });
  }

  return orders;
}
