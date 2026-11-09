import { MEAL_TYPES, MUSCLE_GROUPS, SUPPLEMENT_TIMINGS } from '../../models/types'
import type { MealType, MuscleGroup, SupplementTiming } from '../../models/types'
import { MUSCLES } from '../../lib/muscles'
import type { Muscle } from '../../lib/muscles'
import { VAULT_FORMAT } from './markdownBuild'

/**
 * Parser für die Markdown-Dateien, die der Sync selbst schreibt (siehe die `*Export.ts`-Module)
 * sowie für Lebensmittel-Neu.md, das in Obsidian entsteht. Sie sind bewusst nachsichtig:
 * Zeilen, die nicht ins Muster passen (eigene Notizen, Überschriften, Absätze aus Obsidian),
 * werden übersprungen statt zu einem Fehler zu führen - so zerschießt eine handschriftliche
 * Ergänzung im Vault nicht den Import.
 */

/** "84,5" und "84.5" akzeptieren, alles andere verwerfen. */
export function parseNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw.trim().replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

/** "ja"/"x"/"true" → true, leer oder "nein"/"-" → false. */
export function parseBool(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  return value === 'ja' || value === 'x' || value === 'true' || value === 'yes'
}

/** Leere Zellen und Platzhalter kommen als `undefined` zurück, nicht als leerer String. */
function parseText(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return !value || value === '-' ? undefined : value
}

function lines(content: string): string[] {
  return content.split(/\r?\n/)
}

// -------------------------------------------------------------- Frontmatter

/** Zeilen innerhalb des Frontmatter-Blocks (ohne die "---"-Zeilen). */
function frontmatterLines(content: string): string[] {
  const all = lines(content)
  if (all[0]?.trim() !== '---') return []
  const end = all.findIndex((line, i) => i > 0 && line.trim() === '---')
  return end === -1 ? [] : all.slice(1, end)
}

/** Entfernt den YAML-Frontmatter-Block am Dateianfang. */
function stripFrontmatter(content: string): string[] {
  const all = lines(content)
  if (all[0]?.trim() !== '---') return all
  const end = all.findIndex((line, i) => i > 0 && line.trim() === '---')
  return end === -1 ? all : all.slice(end + 1)
}

/**
 * Liest den Frontmatter-Block als flache Schlüssel-Wert-Paare. Kein YAML-Parser: `buildFrontmatter`
 * schreibt nur "schluessel: wert"-Zeilen. Umschließende Anführungszeichen werden entfernt, damit
 * auch in Obsidian gesetzte Quotes gelesen werden.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of frontmatterLines(content)) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    fields[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return fields
}

/**
 * Wurde die Datei von dieser App-Version geschrieben (`format:` im Frontmatter)?
 *
 * Nur dann darf der Import löschende Semantik anwenden. Fehlt der Marker, stammt die Datei aus
 * einer älteren Version und war nie vollständig - eine dort fehlende Plan-Phase ist also nicht
 * gelöscht, sondern wurde nie geschrieben.
 */
export function isCurrentFormat(content: string): boolean {
  const version = Number(parseFrontmatter(content).format)
  return Number.isFinite(version) && version >= VAULT_FORMAT
}

// ------------------------------------------------------------ Markdowntabellen

/**
 * Zerlegt eine Tabellenzeile in ihre Zellen. `\|` gehört zum Zellinhalt (so schreibt der
 * Export Namen mit Pipe-Zeichen) und trennt deshalb nicht - lookbehind-Regex wird bewusst
 * vermieden, das ältere iOS-Safari-Versionen nicht kennen. `<br>` wird zum Zeilenumbruch
 * zurückgewandelt (so schreibt `escapeCell` mehrzeilige Notizen).
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '\\' && line[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)

  // Die äußeren Pipes erzeugen je eine leere Randzelle - die gehört nicht zur Tabelle.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim().replace(/<br\s*\/?>/gi, '\n'))
}

/** Trennzeile einer Markdowntabelle ("|---|---|" bzw. "| :--- | ---: |"). */
export function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell))
}

export function isTableRow(line: string): boolean {
  return line.trim().startsWith('|')
}

/**
 * Alle Datenzeilen einer Tabelle als Zellen-Arrays - Trennzeilen und die Kopfzeile
 * (erkannt am erwarteten Titel der ersten Spalte) werden übersprungen.
 */
function tableCells(contentLines: string[], firstColumnHeader: string): string[][] {
  const rows: string[][] = []
  for (const line of contentLines) {
    if (!isTableRow(line) || isTableSeparator(line)) continue
    const cells = splitTableRow(line)
    if (cells[0]?.toLowerCase() === firstColumnHeader.toLowerCase()) continue
    rows.push(cells)
  }
  return rows
}

// ---------------------------------------------------------------- Überschriften

/** "## Plan: Push A" bzw. das alte "## Aktueller Plan: …" - Trenner zwischen Plan-Phasen. */
function planHeading(line: string): string | null {
  const match = line.match(/^##\s+(?:Aktueller\s+)?(?:Plan|Rezept):\s*(.+?)\s*$/i)
  return match ? match[1] : null
}

/** "## Rezept: Protein-Eis Schoko" - ein Gericht statt einer Tagesplan-Phase. */
function isRecipeHeading(line: string): boolean {
  return /^##\s+Rezept:/i.test(line.trim())
}

/** "**Ergibt:** 2 Portionen" - die Ausbeute des kompletten Rezepts. */
function servingsLine(line: string): number | undefined {
  const match = line.match(/^\*\*Ergibt:\*\*\s*([\d.,]+)\s*Portion/i)
  return match ? parseNumber(match[1]) : undefined
}

/** "**Fertiggewicht:** 1200 g" - Gewicht des fertigen Gerichts. */
function cookedWeightLine(line: string): number | undefined {
  const match = line.match(/^\*\*Fertiggewicht:\*\*\s*([\d.,]+)\s*g/i)
  return match ? parseNumber(match[1]) : undefined
}

/** Eine "## …"-Überschrift (nicht "### …"). */
function isSectionHeading(line: string): boolean {
  return /^##(?!#)/.test(line.trim())
}

/** "### Bankdrücken" bzw. "### Frühstück". */
function subHeading(line: string): string | null {
  const match = line.match(/^###\s+(.+?)\s*$/)
  return match ? match[1] : null
}

/**
 * Fließtext unterhalb einer "## <Titel>"-Überschrift bis zur nächsten Überschrift - für die
 * Notizfelder, die mehrzeilig sein dürfen (Trainings- und Tagesnotiz).
 */
export function parseSection(content: string, title: string): string | undefined {
  const all = stripFrontmatter(content)
  const wanted = `## ${title}`.toLowerCase()
  const start = all.findIndex((line) => line.trim().toLowerCase() === wanted)
  if (start === -1) return undefined

  const body: string[] = []
  for (let i = start + 1; i < all.length; i++) {
    if (isSectionHeading(all[i]) || subHeading(all[i]) !== null) break
    body.push(all[i])
  }
  return body.join('\n').trim() || undefined
}

// ---------------------------------------------------------------- Athlet.md

/**
 * Stammdaten aus dem Frontmatter von Athlet.md. Reine Textwerte - welche davon übernommen
 * werden dürfen, entscheidet der Import (`importAthlet`), weil dafür die erlaubten
 * Auswahlwerte aus dem Kalorienrechner nötig sind.
 */
export function parseAthlet(content: string): Record<string, string> {
  return parseFrontmatter(content)
}

// ---------------------------------------------------------------- Gewicht.md

export interface ParsedTrackingRow {
  date: string
  weightKg?: number
  bodyFatPct?: number
  calories?: number
  protein?: number
  carbs?: number
  fat?: number
  waist?: number
  arm?: number
  chest?: number
  leg?: number
  notes?: string
}

/** Positive Zahl oder `undefined` - 0 und Negativwerte sind in dieser Tabelle immer Unsinn. */
function positive(raw: string | undefined): number | undefined {
  const value = parseNumber(raw)
  return value !== undefined && value > 0 ? value : undefined
}

/**
 * Liest die Tracking-Tabelle aus Gewicht.md. Datum und Gewicht stehen (auch in älteren
 * Dateien) in Spalte 1 und 2, alle weiteren Spalten sind optional - eine Datei aus einer
 * früheren App-Version wird deshalb unverändert weiter gelesen.
 */
export function parseGewicht(content: string): ParsedTrackingRow[] {
  const result: ParsedTrackingRow[] = []
  const seen = new Set<string>()

  for (const line of stripFrontmatter(content)) {
    if (!isTableRow(line) || isTableSeparator(line)) continue
    const cells = splitTableRow(line)
    const date = cells[0]?.match(/^\d{4}-\d{2}-\d{2}$/) ? cells[0] : null
    if (!date) continue
    if (seen.has(date)) continue // erste (= neueste) Zeile pro Datum gewinnt
    seen.add(date)

    result.push({
      date,
      weightKg: positive(cells[1]),
      bodyFatPct: positive(cells[2]),
      calories: parseNumber(cells[3]),
      protein: parseNumber(cells[4]),
      carbs: parseNumber(cells[5]),
      fat: parseNumber(cells[6]),
      waist: positive(cells[7]),
      arm: positive(cells[8]),
      chest: positive(cells[9]),
      leg: positive(cells[10]),
      notes: parseText(cells[11]),
    })
  }

  return result
}

// -------------------------------------------------------------- Uebungen.md

export interface ParsedExerciseRow {
  name: string
  muscleGroup?: MuscleGroup
  favorite: boolean
  primaryMuscle?: Muscle
  secondaryMuscles?: Muscle[]
  weightStepKg?: number
  seat: { tracked: boolean; value?: number }
  pad: { tracked: boolean; value?: number }
  cableHeight: { tracked: boolean; value?: number }
  backrest: { tracked: boolean; value?: number }
  notes?: string
}

function toMuscleGroup(raw: string | undefined): MuscleGroup | undefined {
  const value = raw?.trim().toLowerCase()
  return MUSCLE_GROUPS.find((group) => group.toLowerCase() === value)
}

function toMuscle(raw: string | undefined): Muscle | undefined {
  const value = raw?.trim().toLowerCase()
  return MUSCLES.find((muscle) => muscle.toLowerCase() === value)
}

/** "Bizeps, Schultern" → bekannte Muskeln, unbekannte Namen werden stillschweigend verworfen. */
function toMuscleList(raw: string | undefined): Muscle[] | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const muscles = text
    .split(',')
    .map((part) => toMuscle(part))
    .filter((m): m is Muscle => m !== undefined)
  return muscles.length > 0 ? muscles : undefined
}

/**
 * Eine Geräte-Einstellung (Sitz/Polster/Kabelturmhöhe/Rückenlehne): eine Zahl heißt erfasst
 * mit diesem Wert, "ja" heißt erfasst ohne Wert, eine leere Zelle heißt nicht erfasst.
 */
function toTrackedNum(raw: string | undefined): { tracked: boolean; value?: number } {
  const text = raw?.trim()
  if (!text || text === '-') return { tracked: false }
  return { tracked: true, value: parseNumber(text) }
}

/** Liest "| Bankdrücken | Brust | ja | ... |" aus Uebungen.md. */
export function parseUebungen(content: string): ParsedExerciseRow[] {
  const rows: ParsedExerciseRow[] = []
  for (const cells of tableCells(stripFrontmatter(content), 'Übung')) {
    const name = parseText(cells[0])
    if (!name) continue
    rows.push({
      name,
      muscleGroup: toMuscleGroup(cells[1]),
      favorite: parseBool(cells[2]),
      primaryMuscle: toMuscle(cells[3]),
      secondaryMuscles: toMuscleList(cells[4]),
      weightStepKg: parseNumber(cells[5]),
      seat: toTrackedNum(cells[6]),
      pad: toTrackedNum(cells[7]),
      cableHeight: toTrackedNum(cells[8]),
      backrest: toTrackedNum(cells[9]),
      notes: parseText(cells[10]),
    })
  }
  return rows
}

// -------------------------------------------------- Supplement-Datenbank.md

export interface ParsedSupplementRow {
  name: string
  defaultDose?: string
  defaultTiming?: SupplementTiming
  notes?: string
}

function toTiming(raw: string | undefined): SupplementTiming | undefined {
  const value = raw?.trim().toLowerCase()
  return SUPPLEMENT_TIMINGS.find((timing) => timing.toLowerCase() === value)
}

/** Liest "| Kreatin | 5 g | Morgens | mit Wasser |" aus Supplement-Datenbank.md. */
export function parseSupplementDatenbank(content: string): ParsedSupplementRow[] {
  const rows: ParsedSupplementRow[] = []
  for (const cells of tableCells(stripFrontmatter(content), 'Supplement')) {
    const name = parseText(cells[0])
    if (!name) continue
    rows.push({
      name,
      defaultDose: parseText(cells[1]),
      defaultTiming: toTiming(cells[2]),
      notes: parseText(cells[3]),
    })
  }
  return rows
}

// -------------------------------------------------------- Trainingsplaene.md

export interface ParsedPlanExercise {
  name: string
  sets: number
  reps: string
  targetWeightKg?: number
  notes?: string
}

export interface ParsedTrainingPhase {
  phaseName: string
  items: ParsedPlanExercise[]
}

/**
 * Liest die Trainingsplan-Phasen: je "## Plan: <Name>" eine Tabelle
 * "| Übung | Sätze | Wdh. | Zielgewicht (kg) | Notiz |".
 */
export function parseTrainingsplaene(content: string): ParsedTrainingPhase[] {
  const phases: ParsedTrainingPhase[] = []
  let current: ParsedTrainingPhase | null = null

  for (const line of stripFrontmatter(content)) {
    const heading = planHeading(line)
    if (heading) {
      current = { phaseName: heading, items: [] }
      phases.push(current)
      continue
    }
    if (!current) continue
    if (isSectionHeading(line)) {
      current = null // andere Überschrift (z.B. "## Notizen") beendet die Phase
      continue
    }
    if (!isTableRow(line) || isTableSeparator(line)) continue

    const cells = splitTableRow(line)
    const name = parseText(cells[0])
    if (!name || name.toLowerCase() === 'übung') continue
    current.items.push({
      name,
      sets: Math.max(1, Math.round(parseNumber(cells[1]) ?? 1)),
      reps: parseText(cells[2]) ?? '',
      targetWeightKg: positive(cells[3]),
      notes: parseText(cells[4]),
    })
  }

  return phases
}

// ------------------------------------------------------- Training/<datum>.md

export interface ParsedSet {
  setNumber: number
  reps?: number
  weightKg?: number
  rpe?: number
  done: boolean
}

export interface ParsedExercise {
  name: string
  notes?: string
  sets: ParsedSet[]
}

export interface ParsedTrainingDay {
  /** Phasenname aus dem Frontmatter (`plan:`), zum Wiederfinden des Trainingsplans. */
  planName?: string
  startedAt?: string
  completedAt?: string
  notes?: string
  exercises: ParsedExercise[]
}

/** ISO-Zeitstempel aus dem Frontmatter - unlesbare Werte werden verworfen. */
function parseTimestamp(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const value = new Date(raw)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}

/**
 * Liest eine Trainings-Tagesdatei: Übungen ("### Bankdrücken"), Übungsnotizen
 * ("_Notiz: langsam ablassen_") und Sätze ("- [x] Satz 1 · 8 Wdh. · 100 kg · RPE 8"),
 * dazu Plan, Start/Ende aus dem Frontmatter und die Trainingsnotiz aus "## Trainingsnotiz".
 */
export function parseTraining(content: string): ParsedTrainingDay {
  const frontmatter = parseFrontmatter(content)
  const exercises: ParsedExercise[] = []
  let current: ParsedExercise | null = null
  // Ab der ersten "## …"-Überschrift ist der Übungsteil zu Ende (Trainingsnotiz, Notizen).
  // Danach kommt nichts mehr dazu - sonst würde eine "### …"-Zeile in eigenen Notizen als
  // Übung gelesen und beim Import in die App geschrieben.
  let inExercises = true

  for (const line of stripFrontmatter(content)) {
    if (isSectionHeading(line)) {
      current = null
      inExercises = false
      continue
    }
    if (!inExercises) continue

    const heading = subHeading(line)
    if (heading) {
      current = { name: heading, sets: [] }
      exercises.push(current)
      continue
    }
    if (!current) continue

    const note = line.match(/^\s*_Notiz:\s*(.+?)_\s*$/)
    if (note) {
      current.notes = note[1].trim()
      continue
    }

    const setLine = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/)
    if (!setLine) continue

    const done = setLine[1].toLowerCase() === 'x'
    const parts = setLine[2].split('·').map((p) => p.trim())
    const set: ParsedSet = { setNumber: current.sets.length + 1, done }
    for (const part of parts) {
      const setNumber = part.match(/^Satz\s+(\d+)$/i)
      if (setNumber) {
        set.setNumber = Number(setNumber[1])
        continue
      }
      const reps = part.match(/^([\d.,]+)\s*Wdh\.?$/i)
      if (reps) {
        set.reps = parseNumber(reps[1])
        continue
      }
      const weight = part.match(/^([\d.,]+)\s*kg$/i)
      if (weight) {
        set.weightKg = parseNumber(weight[1])
        continue
      }
      const rpe = part.match(/^RPE\s*([\d.,]+)$/i)
      if (rpe) set.rpe = parseNumber(rpe[1])
    }
    current.sets.push(set)
  }

  return {
    planName: parseText(frontmatter.plan),
    startedAt: parseTimestamp(frontmatter.start),
    completedAt: parseTimestamp(frontmatter.ende),
    notes: parseSection(content, 'Trainingsnotiz'),
    // Auch eine Übung ohne Sätze bleibt erhalten ("_Keine Sätze erfasst._") - sie ist in der App
    // angelegt, nur noch nicht ausgefüllt.
    exercises: exercises.filter((e) => e.name.trim().length > 0),
  }
}

// ------------------------------------------------------------ Supplemente.md

export interface ParsedSupplement {
  name: string
  dose: string
  timing: SupplementTiming
  notes?: string
}

export interface ParsedSupplementPhase {
  /** `undefined`, wenn die Datei keine "## Plan:"-Überschrift hat (handgeschrieben). */
  phaseName?: string
  items: ParsedSupplement[]
}

/** Liest die Supplementplan-Phasen mit ihren Einträgen "- **Kreatin** – 5 g, Morgens (mit Wasser)". */
export function parseSupplemente(content: string): ParsedSupplementPhase[] {
  const phases: ParsedSupplementPhase[] = []
  let current: ParsedSupplementPhase | null = null
  // Nach einer anderen "## …"-Überschrift (z.B. "## Notizen") werden keine Einträge mehr
  // gesammelt, bis die nächste Plan-Überschrift kommt - eigene Notizen sind kein Plan.
  let blocked = false

  for (const line of stripFrontmatter(content)) {
    const heading = planHeading(line)
    if (heading) {
      current = { phaseName: heading, items: [] }
      phases.push(current)
      blocked = false
      continue
    }
    if (isSectionHeading(line)) {
      current = null
      blocked = true
      continue
    }
    if (blocked) continue

    const item = line.match(/^\s*-\s*\*\*(.+?)\*\*\s*[–-]\s*(.+?)\s*$/)
    if (!item) continue

    let rest = item[2]
    let notes: string | undefined
    const withNotes = rest.match(/^(.*?)\s*\(([^()]*)\)$/)
    if (withNotes) {
      rest = withNotes[1]
      notes = withNotes[2].trim() || undefined
    }

    // Die Dosis darf selbst Kommas enthalten ("2,5 g"), deshalb wird das Timing hinten
    // anhand der bekannten Werte abgeschnitten statt am letzten Komma zu trennen.
    let timing: SupplementTiming = 'Morgens'
    const match = SUPPLEMENT_TIMINGS.find((t) => rest.toLowerCase().endsWith(t.toLowerCase()))
    if (match) {
      timing = match
      rest = rest.slice(0, rest.length - match.length).replace(/[,\s]+$/, '')
    }

    if (!current) {
      // Einträge vor der ersten Überschrift gehören zu einer namenlosen Phase.
      current = { items: [] }
      phases.push(current)
    }
    current.items.push({ name: item[1].trim(), dose: rest.trim(), timing, notes })
  }

  return phases.filter((phase) => phase.items.length > 0)
}

// ----------------------------------------- Ernaehrungsplan.md / Log/<datum>.md

export interface ParsedMealItem {
  mealType: MealType
  name: string
  grams: number
  done: boolean
}

export interface ParsedMealPhase {
  /** `undefined`, wenn die Datei keine "## Plan:"-Überschrift hat (z.B. ein Tageslog). */
  phaseName?: string
  /** Aus "## Rezept: …" statt "## Plan: …" - ein Gericht, kein Tagesablauf. */
  isRecipe?: boolean
  /** Aus "**Ergibt:** 2 Portionen" - nur bei Rezepten gesetzt. */
  servings?: number
  /** Aus "**Fertiggewicht:** 1200 g" - nur bei Rezepten gesetzt. */
  cookedWeightG?: number
  items: ParsedMealItem[]
}

export interface ParsedNutritionDay {
  /** Phasenname aus dem Frontmatter (`plan:`), zum Wiederfinden des Ernährungsplans. */
  planName?: string
  completedAt?: string
  notes?: string
  items: ParsedMealItem[]
}

function toMealType(raw: string): MealType | undefined {
  return MEAL_TYPES.find((m) => m.toLowerCase() === raw.trim().toLowerCase())
}

/**
 * Liest Mahlzeiten unter "### Frühstück":
 * "- Haferflocken – 80g (300 kcal)" - ältere Logs tragen noch ein Häkchen ("- [x] …"),
 * gruppiert nach Plan-Phase ("## Plan: …"). Die Kalorienangabe in Klammern wird ignoriert -
 * sie wird aus den Makros neu berechnet.
 */
export function parseMealPhases(content: string): ParsedMealPhase[] {
  const phases: ParsedMealPhase[] = []
  let current: ParsedMealPhase | null = null
  let mealType: MealType | undefined
  let blocked = false

  for (const line of stripFrontmatter(content)) {
    const heading = planHeading(line)
    if (heading) {
      current = { phaseName: heading, items: [], ...(isRecipeHeading(line) ? { isRecipe: true } : {}) }
      phases.push(current)
      mealType = undefined
      blocked = false
      continue
    }
    if (isSectionHeading(line)) {
      // Andere "## …"-Überschrift (Tagesnotiz, Notizen): kein Mahlzeitenblock mehr, sonst
      // würden Listenzeilen aus eigenen Notizen als Mahlzeit gelesen.
      current = null
      mealType = undefined
      blocked = true
      continue
    }
    if (blocked) continue

    const servings = servingsLine(line)
    if (servings !== undefined && current) {
      current.servings = servings
      continue
    }

    const cookedWeight = cookedWeightLine(line)
    if (cookedWeight !== undefined && current) {
      current.cookedWeightG = cookedWeight
      continue
    }

    const meal = subHeading(line)
    if (meal) {
      mealType = toMealType(meal)
      continue
    }

    const item = line.match(/^\s*-\s*(?:\[([ xX])\]\s*)?(.+?)\s*[–-]\s*([\d.,]+)\s*g\b/)
    if (!item || !mealType) continue
    const grams = parseNumber(item[3])
    if (grams === undefined || grams <= 0) continue

    if (!current) {
      current = { items: [] }
      phases.push(current)
    }
    current.items.push({
      mealType,
      name: item[2].trim(),
      grams,
      // Nur noch für ältere Logs mit Häkchen relevant - die App wertet `done` nicht mehr aus.
      done: item[1] !== undefined && item[1].toLowerCase() === 'x',
    })
  }

  return phases.filter((phase) => phase.items.length > 0)
}

/** Liest eine Ernährungs-Tagesdatei: Mahlzeiten plus Plan, Abschluss und Tagesnotiz. */
export function parseErnaehrungLog(content: string): ParsedNutritionDay {
  const frontmatter = parseFrontmatter(content)
  return {
    planName: parseText(frontmatter.plan),
    completedAt: parseTimestamp(frontmatter.abgeschlossen),
    notes: parseSection(content, 'Tagesnotiz'),
    items: parseMealPhases(content).flatMap((phase) => phase.items),
  }
}

// ---------------------------------------------------- Lebensmittel(-Neu).md

export interface ParsedNewFood {
  name: string
  kcal: number
  protein: number
  carbs: number
  fat: number
  /** Freitext-Spalte "Herkunft", z.B. "Claude 2026-07-29, geschätzt". Wird nicht gespeichert. */
  origin?: string
}

export interface ParsedNewFoodRow {
  /** Die Zeile im Original - fehlerhafte Zeilen bleiben so unverändert in der Datei stehen. */
  line: string
  /** `null`, wenn die Zeile nicht ins Format passt (falsche Spaltenzahl, unlesbare Zahlen). */
  food: ParsedNewFood | null
}

export interface ParsedFoodRow extends ParsedNewFood {
  favorite: boolean
  unconfirmed: boolean
}

const NEW_FOOD_HEADERS = ['name', 'kcal', 'protein', 'kh', 'fett']

function isNewFoodHeader(cells: string[]): boolean {
  return NEW_FOOD_HEADERS.every((expected, i) => cells[i]?.toLowerCase() === expected)
}

/** Ist die Zeile die Kopfzeile "| Name | kcal | Protein | KH | Fett | Herkunft |"? */
export function isNewFoodHeaderRow(line: string): boolean {
  return isTableRow(line) && !isTableSeparator(line) && isNewFoodHeader(splitTableRow(line))
}

function toMacros(cells: string[]): ParsedNewFood | null {
  const name = parseText(cells[0])
  if (!name) return null
  const [kcal, protein, carbs, fat] = cells.slice(1, 5).map(parseNumber)
  if (kcal === undefined || protein === undefined || carbs === undefined || fat === undefined) return null
  if (kcal < 0 || protein < 0 || carbs < 0 || fat < 0) return null
  return { name, kcal, protein, carbs, fat }
}

function toNewFood(cells: string[]): ParsedNewFood | null {
  // Die Herkunft ist reine Notiz - fehlt die Spalte, ist die Zeile trotzdem auswertbar.
  if (cells.length < 5 || cells.length > 6) return null
  const food = toMacros(cells)
  return food ? { ...food, origin: parseText(cells[5]) } : null
}

/**
 * Liest die Tabelle aus Lebensmittel-Neu.md:
 * "| Popcorn (Kino, süß) | 450 | 5.5 | 72.0 | 12.5 | Claude 2026-07-29, geschätzt |".
 *
 * Kopf- und Trennzeile werden übersprungen; jede weitere Tabellenzeile kommt als
 * `ParsedNewFoodRow` zurück - fehlerhafte mit `food: null`, damit der Import sie überspringen
 * und in der Datei stehen lassen kann, statt abzubrechen.
 */
export function parseLebensmittelNeu(content: string): ParsedNewFoodRow[] {
  const rows: ParsedNewFoodRow[] = []
  for (const line of stripFrontmatter(content)) {
    if (!isTableRow(line)) continue
    if (isTableSeparator(line)) continue
    const cells = splitTableRow(line)
    if (isNewFoodHeader(cells)) continue
    rows.push({ line, food: toNewFood(cells) })
  }
  return rows
}

/**
 * Liest die Lebensmittel-Datenbank aus Lebensmittel.md:
 * "| Reis (roh) | 349 | 7.0 | 78.0 | 0.6 | ja | |". Anders als in den Tageslogs stehen hier die
 * Nährwerte dabei - die Tabelle ist deshalb rücklesbar.
 */
export function parseLebensmittel(content: string): ParsedFoodRow[] {
  const rows: ParsedFoodRow[] = []
  for (const line of stripFrontmatter(content)) {
    if (!isTableRow(line) || isTableSeparator(line)) continue
    const cells = splitTableRow(line)
    if (isNewFoodHeader(cells)) continue
    const food = toMacros(cells)
    if (!food) continue
    rows.push({ ...food, favorite: parseBool(cells[5]), unconfirmed: parseBool(cells[6]) })
  }
  return rows
}

const LEBENSMITTEL_NEU_HEADER = '| Name | kcal | Protein | KH | Fett | Herkunft |'
const LEBENSMITTEL_NEU_SEPARATOR = '|---|---|---|---|---|---|'

/**
 * Baut Lebensmittel-Neu.md nach dem Import neu auf: Frontmatter, Überschriften und alles
 * außerhalb der Tabelle bleiben unverändert stehen, in der Tabelle bleiben nur noch
 * `keptLines` - die Zeilen also, die nicht importiert werden konnten. `null`, wenn die Datei
 * keine Tabelle enthält oder sich dadurch nichts ändert.
 */
export function rebuildLebensmittelNeu(content: string, keptLines: string[]): string | null {
  const all = content.split(/\r?\n/)
  const first = all.findIndex(isTableRow)
  if (first === -1) return null

  let last = first
  for (let i = all.length - 1; i > first; i--) {
    if (isTableRow(all[i])) {
      last = i
      break
    }
  }

  // Kopf- und Trennzeile der Datei behalten, sonst die Standardform schreiben. Passt die
  // erste Tabellenzeile nicht zum erwarteten Kopf, ist sie eine (fehlerhafte) Datenzeile und
  // steht bereits in keptLines - dann kommt der Standardkopf davor.
  const header = isNewFoodHeaderRow(all[first]) ? all[first] : LEBENSMITTEL_NEU_HEADER
  const separator = isTableSeparator(all[first + 1] ?? '') ? all[first + 1] : LEBENSMITTEL_NEU_SEPARATOR

  const next = [...all.slice(0, first), header, separator, ...keptLines, ...all.slice(last + 1)].join('\n')
  return next === content ? null : next
}
