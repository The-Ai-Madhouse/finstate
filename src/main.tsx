import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { AuthGate, Login } from './ui/components/AuthGate';
import { flushSave, initHistory, useStore } from './store/store';
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';

/**
 * Opstart: (login med 2FA, når Finstate kører på netværket) → indlæs de krypterede data → vis appen.
 * Lokalt er der intet login – serveren svarer straks "logget ind".
 * Udløber login'et undervejs, vises login igen ovenpå – ændringer gemmes, når man er logget ind.
 */
function Boot() {
  const [phase, setPhase] = useState<'auth' | 'loading' | 'ready' | 'error'>('auth');
  const [error, setError] = useState<string>();
  const authLost = useStore((s) => s.authLost);
  const load = async () => {
    setPhase('loading');
    try {
      await useStore.persist.rehydrate();
      if (useStore.getState().authLost) { setPhase('auth'); useStore.setState({ authLost: false }); return; }
      // Adresselinjen (#/side) bestemmer siden – og browserens frem/tilbage virker herfra.
      if (useStore.persist.hasHydrated()) initHistory();
      setPhase(useStore.persist.hasHydrated() ? 'ready' : 'error');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  };
  useEffect(() => { if (phase === 'error' && !error) setError('Data kunne ikke indlæses.'); }, [phase, error]);

  if (phase === 'auth') return <AuthGate onReady={load} />;
  if (phase === 'loading') return <div className="boot">Låser dine data op …</div>;
  if (phase === 'error') return <div className="boot">Kunne ikke indlæse dine data: {error} <button className="btn sm" onClick={load}>Prøv igen</button></div>;
  return (
    <>
      <App />
      {authLost && (
        <div className="auth-overlay">
          <Login again onDone={() => { useStore.setState({ authLost: false }); flushSave(); }} />
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
