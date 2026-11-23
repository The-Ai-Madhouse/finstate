import { useEffect, useState } from 'react';
import {
  browserBackend, folderBackend, folderPermission, folderSupported, loadChoice, saveChoice, setClientBackend, type ClientChoice,
} from '../../store/clientStore';
import { Screen } from './AuthGate';

/**
 * Finstate hentes fra en anden maskine (fx en Raspberry Pi), men data ligger på DENNE computer:
 * vælg en mappe (fx Dokumenter/Finstate) – eller brug browserens eget lager, hvis browseren ikke kan skrive i en mappe.
 * Valget huskes; browseren spørger evt. igen om lov til mappen, når siden åbnes.
 */
export function ClientGate({ onReady }: { onReady: () => void }) {
  const [choice, setChoice] = useState<ClientChoice | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const useFolder = async (dir: FileSystemDirectoryHandle, ask: boolean) => {
    setBusy(true); setError(undefined);
    try {
      if (!(await folderPermission(dir, ask))) { setChoice({ kind: 'folder', dir }); return; }
      setClientBackend(await folderBackend(dir));
      await saveChoice({ kind: 'folder', dir });
      onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  const useBrowser = async () => {
    setClientBackend(browserBackend());
    await saveChoice({ kind: 'browser' });
    onReady();
  };
  const pick = async () => {
    try {
      const dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: 'finstate', mode: 'readwrite', startIn: 'documents' });
      await useFolder(dir, true);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    }
  };

  // Sidste valg: åbn det direkte, hvis browseren stadig har lov – ellers spørg med ét klik.
  useEffect(() => {
    loadChoice().then(async (c) => {
      if (c?.kind === 'browser') return void useBrowser();
      if (c?.kind === 'folder' && c.dir && folderSupported()) {
        if (await folderPermission(c.dir, false)) return void useFolder(c.dir, false);
        return setChoice(c);
      }
      setChoice(null);
    }).catch(() => setChoice(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (choice === undefined) return <div className="boot">Finder dine data …</div>;

  if (choice?.kind === 'folder' && choice.dir) {
    return (
      <Screen title="Åbn dine data">
        <p className="ink2">Dine data ligger i mappen <b>{choice.dir.name}</b> på denne computer. Giv browseren lov til at bruge den igen.</p>
        {error && <div className="banner error">{error}</div>}
        <button className="btn primary" disabled={busy} onClick={() => useFolder(choice.dir!, true)}>Fortsæt med {choice.dir.name}</button>
        <button className="btn ghost sm" onClick={pick}>Vælg en anden mappe …</button>
      </Screen>
    );
  }

  return (
    <Screen title="Hvor skal dine data ligge?" wide>
      <p className="ink2">
        Finstate hentes fra din server, men <b>dine data bliver på denne computer</b> – serveren gemmer intet.
      </p>
      {error && <div className="banner error">{error}</div>}
      {folderSupported() ? (
        <div className="col" style={{ gap: 6 }}>
          <button className="btn primary" disabled={busy} onClick={pick}>Vælg mappe på computeren …</button>
          <span className="small ink2">
            Fx <b>Dokumenter/Finstate</b> – samme mappe, som Finstate bruger, når det kører direkte på computeren (<code>npm start</code>).
            Data krypteres (AES-256), og nøglen ligger i <code>local.key</code> i mappen. Er mappen tom, starter du forfra.
          </span>
        </div>
      ) : (
        <div className="banner warn small">
          Denne browser kan ikke gemme i en mappe på computeren. Brug Chrome, Edge eller Brave på en computer for det – eller gem i browseren herunder.
        </div>
      )}
      <div className="col" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={useBrowser}>Gem i denne browser</button>
        <span className="small ink2">
          Data ligger i browserens eget lager på denne computer (ikke krypteret, og kun i denne browser). Tag jævnligt en backup under Indstillinger.
        </span>
      </div>
    </Screen>
  );
}
