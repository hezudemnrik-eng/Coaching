import { db } from './db'
import { nameKey } from '../lib/names'
import type { Exercise, FoodItem, Supplement } from '../models/types'

/**
 * Führt Lebensmittel, Übungen und Supplemente zusammen, die denselben Namen tragen.
 *
 * Dubletten sind entstanden, weil bis hierher fast jeder Anlegepfad ungeprüft eingefügt hat und
 * die drei Seeds beim Start nicht abgewartet wurden - Seed und Vault-Import konnten denselben
 * Eintrag gleichzeitig erzeugen. Die Ursachen sind behoben; dieser Lauf räumt auf, was bereits
 * in den Datenbeständen liegt, und heilt künftige Fälle (Backup-Rückspielung auf ein Gerät, das
 * schon geseedet war) von selbst.
 *
 * Gelöscht wird nur, was vorher umgehängt wurde: Pläne und Logs verweisen über die ID auf diese
 * Tabellen, ein blindes Löschen würde Einträge in Tageslogs zu "?" machen.
 */

export interface DedupeSummary {
  foodItems: number
  exercises: number
  supplements: number
}

/** Gruppiert nach Namensschlüssel, liefert nur Gruppen mit mehr als einem Eintrag. */
function duplicateGroups<T extends { name: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = nameKey(row.name)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * Bestimmt den Eintrag, der die Gruppe überlebt. `rank` ist die fachliche Vorliebe (größer ist
 * besser), bei Gleichstand entscheidet die Zahl der Verweise und zuletzt die ID - damit zwei
 * Geräte unabhängig voneinander zum selben Ergebnis kommen.
 */
function pickKeeper<T extends { id: string }>(group: T[], rank: (row: T) => number, refCount: (row: T) => number): T {
  return [...group].sort(
    (a, b) => rank(b) - rank(a) || refCount(b) - refCount(a) || a.id.localeCompare(b.id),
  )[0]
}

export async function dedupeNamedDatabases(): Promise<DedupeSummary> {
  const summary: DedupeSummary = { foodItems: 0, exercises: 0, supplements: 0 }

  await db.transaction(
    'rw',
    [
      db.foodItems,
      db.planMeals,
      db.nutritionLogItems,
      db.exercises,
      db.trainingPlanExercises,
      db.workoutLogExercises,
      db.supplements,
      db.supplementPlanItems,
    ],
    async () => {
      summary.foodItems = await dedupeFoods()
      summary.exercises = await dedupeExercises()
      summary.supplements = await dedupeSupplements()
    },
  )

  if (summary.foodItems || summary.exercises || summary.supplements) {
    // Hier verschwinden Zeilen aus dem Datenbestand des Nutzers - das soll in der Konsole
    // nachvollziehbar sein, statt lautlos zu passieren.
    console.info('Namensdubletten zusammengeführt:', summary)
  }
  return summary
}

async function dedupeFoods(): Promise<number> {
  const groups = duplicateGroups(await db.foodItems.toArray())
  if (groups.length === 0) return 0

  const planMeals = await db.planMeals.toArray()
  const logItems = await db.nutritionLogItems.toArray()
  const uses = new Map<string, number>()
  for (const row of planMeals) uses.set(row.foodItemId, (uses.get(row.foodItemId) ?? 0) + 1)
  for (const row of logItems) uses.set(row.foodItemId, (uses.get(row.foodItemId) ?? 0) + 1)

  let removed = 0
  for (const group of groups) {
    // Bestätigte Nährwerte schlagen Schätzungen ("Unbestätigt") - sonst überlebte womöglich der
    // aus Lebensmittel-Neu.md geratene Wert und die gemessenen Werte gingen verloren.
    const keeper = pickKeeper<FoodItem>(group, (f) => (f.unconfirmed ? 0 : 1), (f) => uses.get(f.id) ?? 0)
    const losers = group.filter((f) => f.id !== keeper.id)

    // Ein Stern an irgendeiner der Dubletten war eine bewusste Entscheidung und bleibt erhalten.
    // Das "Unbestätigt" muss hier nicht abgeräumt werden: Der Rang oben wählt bereits einen
    // bestätigten Eintrag, sobald es einen gibt.
    if (!keeper.favorite && group.some((f) => f.favorite)) {
      await db.foodItems.update(keeper.id, { favorite: true })
    }

    for (const loser of losers) {
      for (const row of planMeals.filter((m) => m.foodItemId === loser.id)) {
        await db.planMeals.update(row.id, { foodItemId: keeper.id })
      }
      for (const row of logItems.filter((i) => i.foodItemId === loser.id)) {
        await db.nutritionLogItems.update(row.id, { foodItemId: keeper.id })
      }
      await db.foodItems.delete(loser.id)
      removed++
    }
  }
  return removed
}

async function dedupeExercises(): Promise<number> {
  const groups = duplicateGroups(await db.exercises.toArray())
  if (groups.length === 0) return 0

  const planRows = await db.trainingPlanExercises.toArray()
  const logRows = await db.workoutLogExercises.toArray()
  const uses = new Map<string, number>()
  for (const row of planRows) uses.set(row.exerciseId, (uses.get(row.exerciseId) ?? 0) + 1)
  for (const row of logRows) uses.set(row.exerciseId, (uses.get(row.exerciseId) ?? 0) + 1)

  let removed = 0
  for (const group of groups) {
    // Bild und Muskelgruppe sind Handarbeit; automatisch angelegte Übungen aus dem Vault-Import
    // starten auf "Sonstiges" und ohne Bild. Beides kann an *verschiedenen* Dubletten hängen,
    // deshalb entscheidet der Rang nur, welche Zeile bleibt - übernommen wird aus der ganzen
    // Gruppe, sonst ginge die gepflegte Muskelgruppe der verworfenen Zeile verloren.
    const curated = (e: Exercise) => e.muscleGroup && e.muscleGroup !== 'Sonstiges'
    const keeper = pickKeeper<Exercise>(
      group,
      (e) => (e.imageDataUrl ? 2 : 0) + (curated(e) ? 1 : 0),
      (e) => uses.get(e.id) ?? 0,
    )
    const losers = group.filter((e) => e.id !== keeper.id)

    const patch: Partial<Exercise> = {}
    if (!keeper.imageDataUrl) {
      const withImage = group.find((e) => e.imageDataUrl)
      if (withImage) patch.imageDataUrl = withImage.imageDataUrl
    }
    if (!curated(keeper)) {
      const withGroup = group.find(curated)
      if (withGroup) patch.muscleGroup = withGroup.muscleGroup
    }
    if (!keeper.favorite && group.some((e) => e.favorite)) patch.favorite = true
    if (!keeper.trackSeat && group.some((e) => e.trackSeat)) patch.trackSeat = true
    if (!keeper.trackPad && group.some((e) => e.trackPad)) patch.trackPad = true
    if (!keeper.notes?.trim()) {
      const withNotes = group.find((e) => e.notes?.trim())
      if (withNotes) patch.notes = withNotes.notes
    }
    if (Object.keys(patch).length > 0) await db.exercises.update(keeper.id, patch)

    for (const loser of losers) {
      for (const row of planRows.filter((r) => r.exerciseId === loser.id)) {
        await db.trainingPlanExercises.update(row.id, { exerciseId: keeper.id })
      }
      for (const row of logRows.filter((r) => r.exerciseId === loser.id)) {
        await db.workoutLogExercises.update(row.id, { exerciseId: keeper.id })
      }
      await db.exercises.delete(loser.id)
      removed++
    }
  }
  return removed
}

async function dedupeSupplements(): Promise<number> {
  const groups = duplicateGroups(await db.supplements.toArray())
  if (groups.length === 0) return 0

  const planItems = await db.supplementPlanItems.toArray()
  const uses = new Map<string, number>()
  for (const row of planItems) uses.set(row.supplementId, (uses.get(row.supplementId) ?? 0) + 1)

  let removed = 0
  for (const group of groups) {
    // Eine gepflegte Standarddosis unterscheidet den selbst angelegten Eintrag von dem, den ein
    // Vault-Import ohne Dosis nachgezogen hat. Dosis und Notiz können an verschiedenen Dubletten
    // hängen - der Rang bestimmt nur die bleibende Zeile, gefüllt wird aus der ganzen Gruppe.
    const keeper = pickKeeper<Supplement>(
      group,
      (s) => (s.defaultDose?.trim() ? 1 : 0) + (s.notes?.trim() ? 1 : 0),
      (s) => uses.get(s.id) ?? 0,
    )
    const losers = group.filter((s) => s.id !== keeper.id)

    const patch: Partial<Supplement> = {}
    if (!keeper.defaultDose?.trim()) {
      const withDose = group.find((s) => s.defaultDose?.trim())
      if (withDose) patch.defaultDose = withDose.defaultDose
    }
    if (!keeper.notes?.trim()) {
      const withNotes = group.find((s) => s.notes?.trim())
      if (withNotes) patch.notes = withNotes.notes
    }
    if (Object.keys(patch).length > 0) await db.supplements.update(keeper.id, patch)

    for (const loser of losers) {
      for (const row of planItems.filter((r) => r.supplementId === loser.id)) {
        await db.supplementPlanItems.update(row.id, { supplementId: keeper.id })
      }
      await db.supplements.delete(loser.id)
      removed++
    }
  }
  return removed
}

/**
 * Aufräumen im Anschluss an einen Import. Der Import selbst ist zu diesem Zeitpunkt bereits
 * durch - ein Fehlschlag hier darf ihn deshalb weder rückgängig machen noch als gescheitert
 * melden. Bleiben Dubletten liegen, räumt sie der nächste App-Start ab.
 */
export async function dedupeAfterImport(): Promise<void> {
  try {
    await dedupeNamedDatabases()
  } catch (error) {
    console.error('Zusammenführen nach dem Import fehlgeschlagen:', error)
  }
}
