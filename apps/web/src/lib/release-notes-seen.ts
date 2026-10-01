import { LATEST_RELEASE } from './release-notes';

// Qual versão das notas a pessoa já abriu, por navegador. Só serve para o pontinho no ícone do
// menu; sem localStorage (aba anônima, bloqueado), o pontinho simplesmente não aparece.
const KEY = 'docdrop-notas-vistas';

export function hasUnseenReleaseNotes() {
  try { return localStorage.getItem(KEY) !== LATEST_RELEASE; } catch { return false; }
}

export function markReleaseNotesSeen() {
  try { localStorage.setItem(KEY, LATEST_RELEASE); } catch { /* sem armazenamento: segue */ }
}
