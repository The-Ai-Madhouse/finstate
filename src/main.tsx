import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

import { useEffect, useState } from 'react';
import { useStore } from './store/store';

/** Vis først appen, når data er indlæst fra datafilen (eller browseren) – så intet tomt kan blive gemt oven i. */
function Boot() {
  const [ready, setReady] = useState(() => useStore.persist.hasHydrated());
  useEffect(() => (ready ? undefined : useStore.persist.onFinishHydration(() => setReady(true))), [ready]);
  return ready ? <App /> : <div className="boot">Indlæser dine data …</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
