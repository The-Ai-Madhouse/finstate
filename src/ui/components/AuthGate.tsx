import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

export interface AuthStatus { configured: boolean; loggedIn: boolean; expiresAt?: string; recoveryLeft?: number; sessions?: number }

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const authStatus = async (): Promise<AuthStatus> => {
  const r = await fetch('/api/auth/status', { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
export const logout = (everywhere = false) => post('/api/auth/logout', { everywhere });
export const newRecoveryCodes = () => post<{ recovery: string[] }>('/api/auth/recovery', {});

/** Vis kun børnene (appen), når man er logget ind – ellers opsætning af 2FA eller login. */
export function AuthGate({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState<AuthStatus>();
  const [down, setDown] = useState<string>();
  const load = () => authStatus().then((s) => { setStatus(s); setDown(undefined); if (s.loggedIn) onReady(); }).catch((e: Error) => setDown(e.message));
  useEffect(() => { void load(); }, []);
  if (down) {
    return (
      <Screen title="Finstate svarer ikke">
        <p className="ink2">Serveren kører ikke, eller den kan ikke nås ({down}). Start den med <code>npm start</code> – eller tjek tjenesten på din Raspberry Pi.</p>
        <button className="btn primary" onClick={load}>Prøv igen</button>
      </Screen>
    );
  }
  if (!status) return <div className="boot">Forbinder …</div>;
  if (!status.configured) return <Setup onDone={onReady} />;
  return <Login onDone={onReady} />;
}

export function Screen({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className={`card auth-card ${wide ? 'wide' : ''}`}>
        <div className="auth-brand">◐ Finstate</div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Login: adgangskode + 6-cifret kode fra 2FA-appen (eller en gendannelseskode). */
export function Login({ onDone, again }: { onDone: () => void; again?: boolean }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await post('/api/auth/login', { password, code }); onDone(); } catch (err) { setError((err as Error).message); setCode(''); } finally { setBusy(false); }
  };
  return (
    <Screen title={again ? 'Log ind igen' : 'Log ind'}>
      {again && <p className="small ink2">Dit login er udløbet eller logget ud. Dine ændringer gemmes, så snart du er logget ind.</p>}
      <form className="col" style={{ gap: 12 }} onSubmit={submit}>
        <label className="field">Adgangskode<input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {useRecovery
          ? <label className="field">Gendannelseskode<input autoComplete="off" value={code} placeholder="xxxxx-xxxxx" onChange={(e) => setCode(e.target.value)} /></label>
          : <label className="field">Kode fra din 2FA-app<input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} placeholder="123 456" onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} className="code-input" /></label>}
        {error && <div className="banner error">{error}</div>}
        <button className="btn primary" disabled={busy || !password || !code}>{busy ? 'Logger ind …' : 'Log ind'}</button>
        <button type="button" className="btn ghost sm" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>{useRecovery ? 'Brug koden fra appen' : 'Mistet telefonen? Brug en gendannelseskode'}</button>
        <p className="small muted" style={{ margin: 0 }}>Du forbliver logget ind i 4 uger på denne enhed.</p>
      </form>
    </Screen>
  );
}

/** Første gang: vælg adgangskode → scan QR-kode i en 2FA-app → bekræft → gem gendannelseskoder. */
function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [setup, setSetup] = useState<{ setupTicket: string; secret: string; qr: string }>();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); setError(undefined); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  if (step === 1) {
    const ok = password.length >= 10 && password === repeat;
    return (
      <Screen title="Beskyt dine data">
        <p className="small ink2">Finstate krypterer dine data og kræver login med adgangskode og en kode fra en 2FA-app (fx Google Authenticator, Microsoft Authenticator eller 1Password).</p>
        <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (ok) void run(async () => { setSetup(await post('/api/auth/setup/start', { password })); setStep(2); }); }}>
          <label className="field">Vælg en adgangskode (mindst 10 tegn)<input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label className="field">Gentag adgangskoden<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
          {repeat && password !== repeat && <div className="small neg">Adgangskoderne er ikke ens.</div>}
          <div className="banner warn small">Adgangskoden er nøglen til dine data. Glemmer du den, kan data ikke låses op – heller ikke af en backup. Gem den fx i din adgangskodeapp.</div>
          {error && <div className="banner error">{error}</div>}
          <button className="btn primary" disabled={!ok || busy}>Fortsæt</button>
        </form>
      </Screen>
    );
  }
  if (step === 2 && setup) {
    return (
      <Screen title="Tilføj Finstate i din 2FA-app">
        <div className="row" style={{ alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
          <img src={setup.qr} alt="QR-kode til 2FA-appen" width={180} height={180} className="auth-qr" />
          <div className="col grow" style={{ gap: 8, minWidth: 220 }}>
            <p className="small ink2" style={{ margin: 0 }}>Scan QR-koden med appen. Kan du ikke scanne, så indtast nøglen manuelt:</p>
            <code className="auth-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
            <form className="col" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post<{ recovery: string[] }>('/api/auth/setup/finish', { setupTicket: setup.setupTicket, code }); setRecovery(r.recovery); setStep(3); }); }}>
              <label className="field">Skriv koden, appen viser<input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7} value={code} placeholder="123 456" className="code-input" onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} /></label>
              {error && <div className="banner error">{error}</div>}
              <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Krypterer dine data …' : 'Bekræft og kryptér'}</button>
            </form>
          </div>
        </div>
      </Screen>
    );
  }
  const text = `Finstate – gendannelseskoder (hver kan bruges én gang i stedet for 2FA-koden)\n\n${recovery.join('\n')}\n`;
  return (
    <Screen title="Gem dine gendannelseskoder">
      <p className="small ink2">Mister du telefonen, kan du logge ind med adgangskoden og én af disse koder i stedet for koden fra appen. Hver kode virker én gang. Gem dem et sikkert sted – fx i din adgangskodeapp eller på papir.</p>
      <div className="auth-codes">{recovery.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(text)}>Kopiér</button>
        <button className="btn sm" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'finstate-gendannelseskoder.txt'; a.click(); }}>Download som tekstfil</button>
      </div>
      <label className="row small" style={{ gap: 8, marginTop: 6 }}><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Jeg har gemt koderne</label>
      <button className="btn primary" disabled={!saved} onClick={onDone}>Åbn Finstate</button>
    </Screen>
  );
}
