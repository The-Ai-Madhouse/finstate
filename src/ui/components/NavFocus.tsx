import { useEffect, useRef, useState } from 'react';
import type { View } from '../../domain/nav-target';
import { useStore, type Focus } from '../../store/store';

/**
 * Fælles fremhævning: når man kommer et sted hen via "Gå til", "Vis →" osv., findes elementet med
 * data-focus="<nøgle>", der rulles hen til det, det markeres tydeligt (indtil man klikker et andet sted),
 * og markøren sættes i feltet, der skal udfyldes. Modtagersiden folder selv ud / sætter filtre (useFocusIntent).
 */

const MARK = 'data-nav-target';

function clearMarks() {
  document.querySelectorAll(`[${MARK}]`).forEach((el) => el.removeAttribute(MARK));
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function findTargets(f: Focus): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-focus~="${CSS.escape(f.key!)}"]`)];
  return f.first ? all.slice(0, 1) : all;
}

/** Feltet, markøren skal stå i: elementet selv, et markeret felt – eller (på en felt-indpakning) det første felt. */
function focusField(el: HTMLElement) {
  // data-focus-field="<selector>" vælger feltet; tom = første felt.
  const sel = el.getAttribute('data-focus-field');
  const field = el.matches('input, textarea, select, button') ? el
    : el.querySelector<HTMLElement>('[data-focus-input]')
      ?? (sel !== null ? el.querySelector<HTMLElement>(sel || 'input:not([type=hidden]), .combo-input, textarea, select') : null);
  if (field) field.focus({ preventScroll: true });
  else if (el.tabIndex >= 0) el.focus({ preventScroll: true });
}

function mark(els: HTMLElement[], scroll: boolean) {
  clearMarks();
  for (const el of els) el.setAttribute(MARK, '');
  if (scroll) {
    els[0].scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    focusField(els[0]);
  }
}

/** Monteres én gang (i App). */
export function useNavFocus() {
  const focus = useStore((s) => s.focus);
  useEffect(() => {
    clearMarks();
    const f = focus;
    if (!f?.key || f.quiet) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const t0 = Date.now();
    let found = false;
    const tick = () => {
      if (stop) return;
      const els = findTargets(f);
      const marked = document.querySelector(`[${MARK}]`);
      if (els.length && !found) {
        found = true;
        mark(els, true);
      } else if (found && !marked && els.length && Date.now() - t0 < 4000) {
        // Siden blev tegnet om (fx en liste, der genmonteres) – markér igen uden at rulle.
        mark(els, false);
      }
      if (!found && Date.now() - t0 > 2500) {
        // Kun når man kom for at løse noget bestemt (fx en kontrol) – ellers er det bare en side uden det, der kunne fremhæves.
        if (f.reason && !useStore.getState().navNotice) {
          useStore.getState().setNavNotice({ text: `Kunne ikke finde det, der skulle vises${f.reason ? ` ("${f.reason}")` : ''} – måske er det allerede løst, eller det ligger i et andet financial statement.` });
        }
        return;
      }
      if (Date.now() - t0 < 4000) timer = setTimeout(tick, found ? 250 : 60);
    };
    timer = setTimeout(tick, 30);
    // Markeringen bliver stående, indtil man klikker et andet sted.
    const onDown = (ev: PointerEvent) => {
      const marked = [...document.querySelectorAll(`[${MARK}]`)];
      if (marked.length && !marked.some((m) => m.contains(ev.target as Node))) { stop = true; clearMarks(); }
    };
    // Lidt forsinket, så klikket, der startede navigationen, ikke tæller.
    const arm = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 300);
    return () => { stop = true; clearTimeout(timer); clearTimeout(arm); document.removeEventListener('pointerdown', onDown, true); };
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Modtagerside: omsæt målet til lokal tilstand (fold ud, filtre, fane …). Kører ved hver navigation hertil
 * – også ved frem/tilbage (quiet), så konteksten genskabes – og når komponenten monteres.
 */
export function useFocusIntent(view: View, apply: (f: Focus) => void) {
  const focus = useStore((s) => s.focus);
  const ref = useRef(apply);
  ref.current = apply;
  useEffect(() => {
    if (focus && focus.view === view) ref.current(focus);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Lille besked nederst: hvorfor man er her ("Fra Overblik: …") – eller hvorfor målet ikke kan vises. */
export function NavCallout() {
  const focus = useStore((s) => s.focus);
  const notice = useStore((s) => s.navNotice);
  const [hidden, setHidden] = useState<number>();
  const reason = focus && !focus.quiet && focus.reason && hidden !== focus.nonce ? focus.reason : undefined;
  if (!reason && !notice) return null;
  const again = () => {
    if (!focus?.key) return;
    const els = findTargets(focus);
    if (els.length) mark(els, true);
  };
  return (
    <div className="nav-callout no-print" role="status" aria-live="polite">
      {notice ? (
        <>
          <span className="nav-callout-ico warn" aria-hidden>!</span>
          <span className="grow">{notice.text}</span>
          {notice.action && <button className="btn sm primary" onClick={() => { notice.action!.run(); useStore.getState().setNavNotice(undefined); }}>{notice.action.label}</button>}
          <button className="btn sm ghost" aria-label="Luk" onClick={() => useStore.getState().setNavNotice(undefined)}>✕</button>
        </>
      ) : (
        <>
          <span className="nav-callout-ico" aria-hidden>➜</span>
          <span className="grow"><span className="muted">Du kom hertil for at løse:</span> <b>{reason}</b></span>
          {focus?.key && <button className="btn sm" onClick={again}>Vis igen</button>}
          <button className="btn sm ghost" aria-label="Luk" onClick={() => setHidden(focus!.nonce)}>✕</button>
        </>
      )}
    </div>
  );
}
