import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

/*
 * Deliberately no `StrictMode`. In development it invokes render bodies twice,
 * which would double the fixture's expensive derive and put two renders inside
 * every measured frame. The ground truth says "one derive per keystroke"; the
 * fixture has to be the app that statement describes.
 */

const container = document.querySelector('#root');
if (!container) throw new Error('index.html is missing #root');

createRoot(container).render(<App />);
