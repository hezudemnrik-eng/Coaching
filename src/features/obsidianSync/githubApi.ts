import { getSyncSettings } from './settings'
import { base64ToUtf8, utf8ToBase64 } from './base64'

export class ObsidianSyncError extends Error {}

/** Die Datei wurde zwischen Lesen und Schreiben von woanders geändert. */
export class ObsidianSyncConflictError extends ObsidianSyncError {}

function apiBase(settings: { username: string; repo: string }): string {
  return `https://api.github.com/repos/${settings.username}/${settings.repo}`
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  }
}

/** Pfadsegmente einzeln kodieren - "/" muss als Trenner erhalten bleiben. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

/** Prüft, ob Repo mit den gespeicherten Zugangsdaten erreichbar ist. */
export async function testConnection(): Promise<ConnectionTestResult> {
  const settings = getSyncSettings()
  if (!settings) {
    return { ok: false, message: 'Bitte Athlet, Benutzername, Repo-Name und Token ausfüllen.' }
  }
  try {
    const res = await fetch(apiBase(settings), { headers: authHeaders(settings.token) })
    if (res.status === 404) {
      return { ok: false, message: 'Repo nicht gefunden. Benutzername und Repo-Name prüfen.' }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Token ungültig oder ohne Schreibrechte für dieses Repo.' }
    }
    if (!res.ok) {
      return { ok: false, message: `Unerwarteter Fehler von GitHub (${res.status}).` }
    }
    // Ein öffentliches Repo ist mit jedem gültigen Token lesbar - ob das Token auch schreiben
    // darf, verrät erst das Feld `permissions`.
    const data = (await res.json().catch(() => ({}))) as { full_name?: string; permissions?: { push?: boolean } }
    if (data.permissions?.push !== true) {
      return {
        ok: false,
        message:
          `Repo ${data.full_name ?? ''} gefunden, aber das Token hat keinen Schreibzugriff darauf. ` +
          'Beim Token das Repo freigeben und "Contents: Read and write" setzen.',
      }
    }
    return { ok: true, message: `Verbindung erfolgreich – ${data.full_name ?? 'Repo'} erreichbar, Schreibzugriff ok.` }
  } catch {
    return { ok: false, message: 'Keine Verbindung möglich (kein Internet oder Repo nicht erreichbar).' }
  }
}

/**
 * Merkt sich pro Datei zwei Dinge vom letzten Sync:
 *
 * - `sha`: der SHA im Repo. Weicht der aktuelle davon ab, wurde die Datei anderswo geändert
 *   (Obsidian, zweites Gerät) - dann werden die Änderungen erst in die App übernommen, bevor
 *   wir sie überschreiben.
 * - `hash`: der Inhalt, den die App zuletzt für diese Datei gebaut hat. Stimmt er mit dem
 *   aktuellen Bau überein, hat sich in der App nichts geändert. Zusammen mit dem SHA aus dem
 *   Vault-Baum lässt sich eine unveränderte Datei dann ganz ohne GitHub-Anfrage überspringen -
 *   das macht den Abgleich der kompletten Historie erst bezahlbar.
 */
const FILE_CACHE_KEY = 'obsidian-sync-file-cache'

interface CacheEntry {
  sha: string | null
  hash: string | null
}

const EMPTY_ENTRY: CacheEntry = { sha: null, hash: null }

function fileCacheKey(settings: { username: string; repo: string }, path: string): string {
  return `${settings.username}/${settings.repo}:${path}`
}

function readFileCache(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(FILE_CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readCachedEntry(key: string): CacheEntry {
  const entry = readFileCache()[key]
  // Ältere App-Versionen haben hier nur den SHA als String abgelegt.
  if (typeof entry === 'string') return { sha: entry, hash: null }
  if (entry && typeof entry === 'object') {
    const { sha, hash } = entry as { sha?: unknown; hash?: unknown }
    return {
      sha: typeof sha === 'string' ? sha : null,
      hash: typeof hash === 'string' ? hash : null,
    }
  }
  return EMPTY_ENTRY
}

/**
 * Merkt SHA und Inhalts-Hash. `null` heißt "unbekannt" - dann liest der nächste Sync die Datei
 * wieder und gleicht sie regulär ab, statt einen veralteten Stand für aktuell zu halten.
 */
function writeCachedEntry(key: string, sha: string | null, hash: string | null): void {
  try {
    const cache = readFileCache()
    cache[key] = { sha, hash }
    localStorage.setItem(FILE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Ohne Cache wird nur öfter gelesen/geschrieben - kein Grund, den Sync scheitern zu lassen.
  }
}

/**
 * Kurzer Inhalts-Hash (djb2) zur Änderungserkennung - bewusst nicht `crypto.subtle`, das ist
 * asynchron und hier geht es nicht um Sicherheit, sondern nur um "gleich oder nicht".
 */
export function hashContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0
  }
  return `${(hash >>> 0).toString(36)}-${content.length.toString(36)}`
}

/**
 * Hat sich die Datei im Vault seit dem letzten Sync geändert? Für Dateien, die nicht über
 * `syncFile` laufen (Lebensmittel-Neu.md wird nach dem Import geleert und lässt sich deshalb
 * nicht aus der App heraus bauen). Ohne Dateibaum lässt sich das nicht sagen - dann `true`,
 * also lieber lesen.
 */
export function hasRemoteChanged(path: string, tree: VaultTree | null | undefined): boolean {
  const settings = getSyncSettings()
  if (!settings || !tree) return true
  const treeSha = tree.get(path)
  if (treeSha === undefined) return false // im Vault nicht vorhanden
  return treeSha !== readCachedEntry(fileCacheKey(settings, path)).sha
}

/** Merkt den gesehenen Stand einer Datei, die gelesen aber nicht neu geschrieben wurde. */
export function rememberRemoteSha(path: string, sha: string): void {
  const settings = getSyncSettings()
  if (!settings) return
  writeCachedEntry(fileCacheKey(settings, path), sha, null)
}

export interface RemoteFile {
  path: string
  sha: string
  content: string
}

async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch {
    throw new ObsidianSyncError('Keine Verbindung zu GitHub möglich (kein Internet?).')
  }
}

function assertReadable(res: Response, path: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new ObsidianSyncError('Token ungültig oder ohne Zugriff auf dieses Repo.')
  }
  if (!res.ok) {
    throw new ObsidianSyncError(`Fehler beim Lesen von "${path}" (${res.status}).`)
  }
}

/** Liest eine Datei aus dem Vault-Repo. `null`, wenn es sie dort (noch) nicht gibt. */
export async function readFile(path: string): Promise<RemoteFile | null> {
  const settings = getSyncSettings()
  if (!settings) {
    throw new ObsidianSyncError('Obsidian-Sync ist noch nicht eingerichtet. Bitte in den Einstellungen ausfüllen.')
  }

  const res = await githubFetch(`${apiBase(settings)}/contents/${encodePath(path)}`, {
    headers: authHeaders(settings.token),
  })
  if (res.status === 404) return null
  assertReadable(res, path)

  const data = (await res.json()) as { sha: string; content?: string; encoding?: string }
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    // z.B. Dateien > 1 MB liefert GitHub ohne Inhalt - die stammen nicht von uns.
    return { path, sha: data.sha, content: '' }
  }
  return { path, sha: data.sha, content: base64ToUtf8(data.content.replace(/\s/g, '')) }
}

/** Pfad → Blob-SHA für den kompletten Vault. */
export type VaultTree = Map<string, string>

/**
 * Liest den gesamten Dateibaum des Repos in einem einzigen Aufruf (Git-Trees-API, `HEAD` löst
 * den Standardbranch auf). Damit weiß der Sync für jede Datei, ob sie sich im Vault geändert
 * hat, ohne sie einzeln abzufragen.
 *
 * `null`, wenn der Baum nicht nutzbar ist (leeres Repo, kein Zugriff, oder von GitHub gekürzt,
 * weil der Vault sehr groß ist) - dann fällt der Sync auf das Lesen pro Datei zurück.
 */
export async function listVaultTree(): Promise<VaultTree | null> {
  const settings = getSyncSettings()
  if (!settings) return null

  const res = await githubFetch(`${apiBase(settings)}/git/trees/HEAD?recursive=1`, {
    headers: authHeaders(settings.token),
  })
  if (res.status === 404 || res.status === 409) return null // leeres Repo bzw. kein Commit
  assertReadable(res, 'Vault-Verzeichnis')

  try {
    const data = (await res.json()) as {
      tree?: { path?: string; type?: string; sha?: string }[]
      truncated?: boolean
    }
    if (data.truncated || !Array.isArray(data.tree)) return null
    const tree: VaultTree = new Map()
    for (const entry of data.tree) {
      if (entry.type === 'blob' && entry.path && entry.sha) tree.set(entry.path, entry.sha)
    }
    return tree
  } catch {
    return null
  }
}

/** Legt eine Datei im Vault-Repo an oder aktualisiert sie. */
async function putFile(path: string, content: string, commitMessage: string, sha: string | null): Promise<string | null> {
  const settings = getSyncSettings()
  if (!settings) {
    throw new ObsidianSyncError('Obsidian-Sync ist noch nicht eingerichtet. Bitte in den Einstellungen ausfüllen.')
  }

  const res = await githubFetch(`${apiBase(settings)}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: { ...authHeaders(settings.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: commitMessage,
      content: utf8ToBase64(content),
      ...(sha ? { sha } : {}),
    }),
  })

  if (res.status === 401 || res.status === 403) {
    throw new ObsidianSyncError('Token ungültig oder ohne Schreibrechte.')
  }
  if (res.status === 409 || res.status === 422) {
    throw new ObsidianSyncConflictError(
      'Konflikt: Datei wurde zwischenzeitlich geändert. Beim nächsten Sync wird es erneut versucht.',
    )
  }
  if (res.status === 404) {
    // GitHub antwortet mit 404 statt 403, wenn das Token das Repo nicht schreiben darf.
    throw new ObsidianSyncError(
      `"${path}" konnte nicht gespeichert werden: Das Token hat keinen Schreibzugriff auf ` +
        `${settings.username}/${settings.repo} (404). Bitte "Verbindung testen".`,
    )
  }
  if (!res.ok) {
    throw new ObsidianSyncError(`GitHub-Fehler beim Speichern von "${path}" (${res.status}).`)
  }

  try {
    const data = (await res.json()) as { content?: { sha?: string } }
    return data.content?.sha ?? null
  } catch {
    return null
  }
}

/**
 * Schreibt eine Datei ins Vault-Repo und merkt sich den neuen SHA - für Dateien, deren Inhalt
 * nicht allein aus der App-Datenbank entsteht (z.B. Lebensmittel-Neu.md, die nach dem Import
 * geleert wird und deren fehlerhafte Zeilen stehen bleiben) und die deshalb nicht über
 * `syncFile` laufen können.
 */
export async function writeFile(path: string, content: string, commitMessage: string, sha: string | null): Promise<void> {
  const settings = getSyncSettings()
  if (!settings) {
    throw new ObsidianSyncError('Obsidian-Sync ist noch nicht eingerichtet. Bitte in den Einstellungen ausfüllen.')
  }
  const newSha = await putFile(path, content, commitMessage, sha)
  if (newSha) writeCachedEntry(fileCacheKey(settings, path), newSha, hashContent(content))
}

export interface SyncFileOptions {
  path: string
  /**
   * Baut den Dateiinhalt aus dem aktuellen Stand der App-Datenbank. `null` bedeutet "die App
   * hat für diese Datei nichts" (z.B. kein Training heute) - dann wird nichts geschrieben,
   * eine vorhandene Datei im Vault aber trotzdem eingelesen.
   */
  build: () => Promise<string | null>
  commitMessage: string
  /** Übernimmt eine im Vault geänderte Datei in die App. Ohne diese Funktion wird nur geschrieben. */
  importRemote?: (content: string) => Promise<void>
  /**
   * Einen "## Notizen"-Block aus dem Vault beim Zurückschreiben erhalten (Standard: ja).
   * Für reine Datenbank-Abzüge (Lebensmittel.md) aus, sie werden komplett überschrieben.
   */
  preserveNotes?: boolean
  /**
   * Dateibaum des Vaults aus `listVaultTree()`. Ist er da, wird eine Datei, die sich weder im
   * Vault noch in der App geändert hat, ohne jede GitHub-Anfrage übersprungen.
   */
  tree?: VaultTree | null
}

/**
 * Alles ab einer Überschrift "## Notizen" gehört dem Nutzer, nicht dem Export: Der Block
 * wird beim Zurückschreiben unverändert wieder angehängt, damit in Obsidian ergänzte
 * Gedanken nicht beim nächsten Sync verschwinden.
 */
export const NOTES_HEADING = '## Notizen'

function extractNotes(content: string): string | null {
  const match = content.match(/^##\s+Notizen\s*$/m)
  if (!match || match.index === undefined) return null
  return content.slice(match.index).trimEnd()
}

export interface SyncFileResult {
  /** Der Vault-Stand wurde in die App übernommen. */
  imported: boolean
  /** Die Datei wurde (neu) ins Repo geschrieben. */
  written: boolean
}

/**
 * Gleicht eine Datei in beide Richtungen ab:
 *
 * 1. Hat sich weder im Vault noch in der App etwas geändert, ist nichts zu tun - erkennbar am
 *    Dateibaum und am Inhalts-Hash, also ohne die Datei überhaupt zu lesen.
 * 2. Sonst die Datei aus dem Repo lesen. Stimmt sie mit dem überein, was die App schreiben
 *    würde, ist auch nichts zu tun.
 * 3. Wurde sie seit dem letzten Sync anderswo geändert (anderer SHA), zuerst in die App
 *    übernehmen - der Vault gewinnt also bei gleichzeitiger Änderung derselben Datei.
 * 4. Anschließend den (ggf. zusammengeführten) Stand der App zurückschreiben.
 *
 * Kollidiert der Schreibvorgang mit einer Änderung, die zwischen Lesen und Schreiben passiert
 * ist, läuft der Abgleich einmal frisch (ohne Baum) durch, statt den ganzen Sync abzubrechen.
 */
export async function syncFile(options: SyncFileOptions): Promise<SyncFileResult> {
  try {
    return await syncFileAttempt(options, options.tree)
  } catch (err) {
    if (!(err instanceof ObsidianSyncConflictError)) throw err
    return await syncFileAttempt(options, undefined)
  }
}

async function syncFileAttempt(options: SyncFileOptions, tree: VaultTree | null | undefined): Promise<SyncFileResult> {
  const settings = getSyncSettings()
  if (!settings) {
    throw new ObsidianSyncError('Obsidian-Sync ist noch nicht eingerichtet. Bitte in den Einstellungen ausfüllen.')
  }

  const cacheKey = fileCacheKey(settings, options.path)
  const cached = readCachedEntry(cacheKey)

  const built = await options.build()
  const builtHash = built === null ? null : hashContent(built)

  let remote: RemoteFile | null
  if (tree) {
    const treeSha = tree.get(options.path) ?? null
    // Im Vault unverändert und in der App unverändert: fertig, ohne eine einzige Anfrage.
    if (treeSha !== null && treeSha === cached.sha && builtHash === cached.hash) {
      return { imported: false, written: false }
    }
    // Weder im Vault vorhanden noch in der App etwas dafür (z.B. ein Tag ohne Training).
    if (treeSha === null && built === null) return { imported: false, written: false }
    // Laut Baum gibt es die Datei nicht - das Lesen würde nur eine 404 kosten.
    remote = treeSha === null ? null : await readFile(options.path)
  } else {
    remote = await readFile(options.path)
  }

  const notes = remote && options.preserveNotes !== false ? extractNotes(remote.content) : null
  const withNotes = (source: string | null): string | null =>
    source === null || notes === null ? source : `${source.trimEnd()}\n\n${notes}\n`

  let content = withNotes(built)

  if (remote && remote.content === content) {
    writeCachedEntry(cacheKey, remote.sha, builtHash) // unverändert - kein Upload nötig
    return { imported: false, written: false }
  }

  let imported = false
  const changedElsewhere = remote !== null && remote.sha !== cached.sha
  if (remote && changedElsewhere && options.importRemote && settings.importFromVault) {
    await options.importRemote(remote.content)
    imported = true
    // Nach dem Import neu aufbauen - der Vault-Stand steht jetzt in der App.
    const rebuilt = await options.build()
    const rebuiltHash = rebuilt === null ? null : hashContent(rebuilt)
    content = withNotes(rebuilt)
    if (content === null || remote.content === content) {
      writeCachedEntry(cacheKey, remote.sha, rebuiltHash)
      return { imported, written: false }
    }
    const newSha = await putFile(options.path, content, options.commitMessage, remote.sha)
    writeCachedEntry(cacheKey, newSha, rebuiltHash)
    return { imported, written: true }
  }

  if (content === null) return { imported, written: false }

  const newSha = await putFile(options.path, content, options.commitMessage, remote?.sha ?? null)
  writeCachedEntry(cacheKey, newSha, builtHash)
  return { imported, written: true }
}
