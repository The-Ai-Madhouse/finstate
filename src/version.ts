interface BuildInfo {
  version: string;
  commit: string;
  commitDate: string;
  buildNo: number;
  dirty: boolean;
  builtAt: string;
}

declare const __BUILD_INFO__: BuildInfo;

export const BUILD: BuildInfo & { mode: 'dev' | 'build' } = {
  ...__BUILD_INFO__,
  mode: import.meta.env.DEV ? 'dev' : 'build',
};

/** Kort label, fx "v0.1.0 · build 41 · 98f2986" (+ "*" ved ikke-committede ændringer, "dev" under udvikling). */
export const VERSION_LABEL =
  `v${BUILD.version} · build ${BUILD.buildNo} · ${BUILD.commit}${BUILD.dirty ? '*' : ''}${BUILD.mode === 'dev' ? ' · dev' : ''}`;

const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' }) : 'ukendt');

export const VERSION_DETAILS = [
  `Commit ${BUILD.commit} fra ${fmt(BUILD.commitDate)}`,
  BUILD.dirty ? 'Indeholder ændringer, der ikke er committet (*)' : 'Svarer præcis til committet',
  BUILD.mode === 'dev' ? 'Kører på udviklingsserveren (npm start)' : `Bygget ${fmt(BUILD.builtAt)}`,
].join('\n');
