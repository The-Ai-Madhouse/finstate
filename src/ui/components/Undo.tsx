import { useEffect, useState } from 'react';
import { useStore, type UndoEntry } from '../../store/store';

/** Ctrl/Cmd+Z på en Mac eller pc. */
export const UNDO_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';

/** Før markøren tilbage til den transaktion, ændringen handlede om (hvis den er på siden). */
function focusRow(id?: string) {
  if (!id) return;
  setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`[data-txrow="${CSS.escape(id)}"], [data-ledgerrow="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (row.querySelector<HTMLElement>('.combo-input, input[aria-label="Person"]') ?? row).focus({ preventScroll: true });
  }, 80);
}

export function undo(): UndoEntry | undefined {
  const e = useStore.getState().undo();
  if (e) { focusRow(e.focusTx); showUndoToast('Fortrudt', true); }
  return e;
}
export function redo(): UndoEntry | undefined {
  const e = useStore.getState().redo();
  if (e) { focusRow(e.focusTx); showUndoToast('Gentaget', false); }
  return e;
}

let showToast: (t: { text: string; canRedo: boolean }) => void = () => {};
const showUndoToast = (text: string, canRedo: boolean) => showToast({ text, canRedo });

/**
 * Fortryd i hele appen: Ctrl/Cmd+Z fortryder den seneste ændring, Ctrl/Cmd+Shift+Z (eller Ctrl+Y) gentager den.
 * Står markøren i et tekstfelt med tekst, fortryder browseren som normalt i feltet.
 */
export function UndoLayer() {
  const [toast, setToast] = useState<{ text: string; canRedo: boolean; n: number }>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    showToast = (t) => {
      setToast((p) => ({ ...t, n: (p?.n ?? 0) + 1 }));
      clearTimeout(timer);
      timer = setTimeout(() => setToast(undefined), 3500);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      const isUndo = k === 'z' && !ev.shiftKey;
      const isRedo = (k === 'z' && ev.shiftKey) || (k === 'y' && ev.ctrlKey && !ev.metaKey);
      if (!isUndo && !isRedo) return;
      const el = ev.target as HTMLElement | null;
      const textField = !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'date'].includes((el as HTMLInputElement).type)));
      if (textField && (el as HTMLInputElement).value) return; // fortryd i feltet
      const s = useStore.getState();
      if (isUndo ? !s.undoStack.length : !s.redoStack.length) {
        if (isUndo) showToast({ text: 'Intet at fortryde', canRedo: false });
        return;
      }
      ev.preventDefault();
      if (isUndo) undo(); else redo();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); showToast = () => {}; };
  }, []);
  if (!toast) return null;
  return (
    <div key={toast.n} className="undo-toast" role="status" aria-live="polite">
      <span>↶ {toast.text}</span>
      {toast.canRedo && <button className="linkish" onClick={() => redo()}>Gentag</button>}
    </div>
  );
}
