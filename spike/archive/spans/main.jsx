import { createContext, useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';

/*
 * Which components does React 19.3's dev build give a `performance.measure`
 * span to? Four cases, each expensive by the same amount, differing only in
 * *why* they re-rendered.
 */

const Ctx = createContext(0);

function burn(ms) {
  const start = performance.now();
  let acc = 0;
  while (performance.now() - start < ms) {
    for (let i = 0; i < 500; i += 1) acc += Math.sqrt(i);
  }
  return acc;
}

/** Re-renders because its props changed. */
function PropsChanged({ n }) {
  burn(25);
  return <p>props {n}</p>;
}

/** Re-renders because a context it consumes changed. Props never change. */
function ContextConsumer() {
  const value = useContext(Ctx);
  burn(25);
  return <p>context {value}</p>;
}

/** Re-renders because of its own setState. Props never change. */
function StateOwner() {
  const [own, setOwn] = useState(0);
  burn(25);
  return (
    <p>
      own {own} <button data-t="self" onClick={() => setOwn((v) => v + 1)}>self</button>
    </p>
  );
}

/** Expensive on mount only. */
function LateMount() {
  burn(25);
  return <p>mounted</p>;
}

/** Child whose props are a fresh object every render but deep-equal. */
function DeepEqualProps({ config }) {
  burn(25);
  return <p>deep {config.k}</p>;
}

function App() {
  const [n, setN] = useState(0);
  const [show, setShow] = useState(false);
  burn(25); // the state owner's own cost
  return (
    <Ctx.Provider value={n}>
      <button data-t="bump" onClick={() => setN((v) => v + 1)}>bump</button>
      <button data-t="mount" onClick={() => setShow((v) => !v)}>mount</button>
      <PropsChanged n={n} />
      <ContextConsumer />
      <StateOwner />
      <DeepEqualProps config={{ k: 'constant' }} />
      {show ? <LateMount /> : null}
    </Ctx.Provider>
  );
}

createRoot(document.querySelector('#root')).render(<App />);
