import { makeBackup } from '../domain/backup';
import { download } from '../store/actions';
import { useStore } from '../store/store';
import { VERSION_LABEL } from '../version';

export function exportBackup(kind: 'full' | 'rules' = 'full') {
  const { data, markExported } = useStore.getState();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  download(`finstate-${kind === 'full' ? 'backup' : 'regler'}-${stamp}.json`, JSON.stringify(makeBackup(data, kind, VERSION_LABEL), null, 1));
  if (kind === 'full') markExported();
}
