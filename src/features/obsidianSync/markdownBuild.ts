/**
 * Bausteine für die Markdown-Dateien, die der Sync in den Vault schreibt. Gegenstück zu
 * `markdownParse.ts` - was hier geschrieben wird, muss dort wieder lesbar sein.
 */

/**
 * Formatversion der geschriebenen Dateien. Steht als `format:` im Frontmatter und entscheidet
 * beim Import, ob löschende Semantik erlaubt ist: Nur in Dateien dieser Version ist eine
 * fehlende Zeile bzw. Phase wirklich "gelöscht". Alles ohne Marker stammt aus einer älteren
 * App-Version, war also von Anfang an unvollständig - dort wird nur zusammengeführt.
 */
export const VAULT_FORMAT = 2

/**
 * Baut den YAML-Frontmatter-Block inklusive der Leerzeile danach.
 *
 * Felder ohne Wert werden weggelassen, damit keine leeren `schluessel:`-Zeilen entstehen.
 * Bewusst handgebaut (keine YAML-Bibliothek) - die Dateien enthalten nur flache Paare.
 */
export function buildFrontmatter(fields: Record<string, string | number | undefined>): string[] {
  const out = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue
    out.push(`${key}: ${value}`)
  }
  out.push(`format: ${VAULT_FORMAT}`, '---', '')
  return out
}

/**
 * Macht einen Text für eine Tabellenzelle sicher: Pipe-Zeichen würden die Spalten sprengen,
 * Zeilenumbrüche (möglich in Notizen) die Zeile.
 */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** Baut eine Tabellenzeile. Texte werden maskiert, `undefined` wird zur leeren Zelle. */
export function tableRow(cells: (string | number | undefined)[]): string {
  const rendered = cells.map((cell) => {
    if (cell === undefined) return ''
    return typeof cell === 'number' ? String(cell) : escapeCell(cell)
  })
  return `| ${rendered.join(' | ')} |`
}

/** Trennzeile passend zu einer Tabelle mit `columns` Spalten. */
export function tableSeparator(columns: number): string {
  return `|${'---|'.repeat(columns)}`
}

/** Zahl für eine Zelle bzw. ein Frontmatter-Feld - `undefined` bleibt leer. */
export function fmtNum(n: number | undefined, digits?: number): string | undefined {
  if (n === undefined) return undefined
  return digits === undefined ? String(n) : n.toFixed(digits)
}

/** Ja/Nein-Zelle. `undefined` und `false` sind dasselbe: leer. */
export function fmtBool(value: boolean | undefined): string | undefined {
  return value ? 'ja' : undefined
}

/**
 * Zelle für eine ein-/ausschaltbare Geräte-Einstellung (z.B. Sitz): der aktuelle Wert, "ja"
 * wenn erfasst aber noch ohne Wert, sonst leer (nicht erfasst).
 */
export function fmtTrackedNum(tracked: boolean | undefined, value: number | undefined): string | undefined {
  if (!tracked) return undefined
  return value !== undefined ? String(value) : 'ja'
}
