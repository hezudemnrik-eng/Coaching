import { db } from '../../db/db'
import type { Exercise } from '../../models/types'
import { byName, nameKey, record, requireSettings } from './importLog'
import type { ImportResult } from './importLog'
import { buildFrontmatter, fmtBool, fmtNum, fmtTrackedNum, tableRow, tableSeparator } from './markdownBuild'
import { parseUebungen } from './markdownParse'
import { syncFile } from './githubApi'
import type { VaultTree } from './githubApi'
import { withVaultImport } from './syncState'

/**
 * Übungs-Datenbank als Tabelle in `20-Fitness/Uebungen.md`.
 *
 * Die Namen stehen dort zeichengleich so wie in den Trainings-Tagesdateien - daran hängt die
 * Zuordnung beim Zurücklesen. Übungsbilder bleiben absichtlich außen vor: sie gehören nicht in
 * eine Markdowntabelle und würden den Vault unnötig aufblähen.
 */

export const UEBUNGEN_PATH = '20-Fitness/Uebungen.md'

const HEADER = [
  'Übung',
  'Muskelgruppe',
  'Favorit',
  'Hauptmuskel',
  'Nebenmuskeln',
  'Gewichtsschritt (kg)',
  'Sitz',
  'Polster',
  'Kabelturmhöhe',
  'Rückenlehne',
  'Notiz',
]

async function buildUebungen(): Promise<string> {
  const exercises = await db.exercises.toArray()
  const sorted = [...exercises].sort((a, b) => a.name.localeCompare(b.name, 'de'))

  return [
    ...buildFrontmatter({ typ: 'uebungen', quelle: 'fitness-app' }),
    '# Übungs-Datenbank',
    '',
    'Neue Zeilen werden beim nächsten Sync als Übung angelegt, geänderte Spalten übernommen.',
    'Hier gelöschte Zeilen löschen keine Übung - sie hängen an Plänen und Trainingslogs.',
    'Übungsbilder bleiben nur in der App. Sitz/Polster/Kabelturmhöhe/Rückenlehne: Zahl = Wert,',
    '"ja" = erfasst aber noch ohne Wert, leer = nicht erfasst.',
    '',
    tableRow(HEADER),
    tableSeparator(HEADER.length),
    ...sorted.map((e) =>
      tableRow([
        e.name,
        e.muscleGroup,
        fmtBool(e.favorite),
        e.primaryMuscle,
        e.secondaryMuscles?.length ? e.secondaryMuscles.join(', ') : undefined,
        fmtNum(e.weightStepKg),
        fmtTrackedNum(e.trackSeat, e.seat),
        fmtTrackedNum(e.trackPad, e.pad),
        fmtTrackedNum(e.trackCableHeight, e.cableHeight),
        fmtTrackedNum(e.trackBackrest, e.backrest),
        e.notes,
      ]),
    ),
    '',
  ].join('\n')
}

/**
 * Übernimmt die Übungs-Datenbank aus dem Vault: bekannte Namen werden aktualisiert, unbekannte
 * angelegt. Es wird nichts gelöscht - Übungen sind aus Trainingsplänen und Logs referenziert.
 * Eine unbekannte Muskelgruppe wird ignoriert (die App kennt nur die vorgesehenen Gruppen).
 */
export async function importUebungen(content: string): Promise<ImportResult> {
  const rows = parseUebungen(content)
  if (rows.length === 0) return record({ label: 'Übungen', changed: 0, skipped: [] })

  let changed = 0
  await withVaultImport(async () => {
    await db.transaction('rw', db.exercises, async () => {
      const existing = byName(await db.exercises.toArray())
      for (const row of rows) {
        const exercise = existing.get(nameKey(row.name))
        if (!exercise) {
          const created: Exercise = {
            id: crypto.randomUUID(),
            name: row.name,
            muscleGroup: row.muscleGroup ?? 'Sonstiges',
            ...(row.favorite ? { favorite: true } : {}),
            ...(row.primaryMuscle ? { primaryMuscle: row.primaryMuscle } : {}),
            ...(row.secondaryMuscles ? { secondaryMuscles: row.secondaryMuscles } : {}),
            ...(row.weightStepKg !== undefined ? { weightStepKg: row.weightStepKg } : {}),
            ...(row.seat.tracked ? { trackSeat: true, ...(row.seat.value !== undefined ? { seat: row.seat.value } : {}) } : {}),
            ...(row.pad.tracked ? { trackPad: true, ...(row.pad.value !== undefined ? { pad: row.pad.value } : {}) } : {}),
            ...(row.cableHeight.tracked
              ? { trackCableHeight: true, ...(row.cableHeight.value !== undefined ? { cableHeight: row.cableHeight.value } : {}) }
              : {}),
            ...(row.backrest.tracked
              ? { trackBackrest: true, ...(row.backrest.value !== undefined ? { backrest: row.backrest.value } : {}) }
              : {}),
            ...(row.notes ? { notes: row.notes } : {}),
          }
          await db.exercises.add(created)
          existing.set(nameKey(row.name), created)
          changed++
          continue
        }

        const patch: Partial<Exercise> = {}
        if (row.muscleGroup && row.muscleGroup !== exercise.muscleGroup) patch.muscleGroup = row.muscleGroup
        if (row.favorite !== !!exercise.favorite) patch.favorite = row.favorite
        if (row.primaryMuscle && row.primaryMuscle !== exercise.primaryMuscle) patch.primaryMuscle = row.primaryMuscle
        if (row.secondaryMuscles && row.secondaryMuscles.join(',') !== (exercise.secondaryMuscles ?? []).join(','))
          patch.secondaryMuscles = row.secondaryMuscles
        if (row.weightStepKg !== undefined && row.weightStepKg !== exercise.weightStepKg) patch.weightStepKg = row.weightStepKg
        if (row.seat.tracked !== !!exercise.trackSeat) patch.trackSeat = row.seat.tracked
        if (row.seat.tracked && row.seat.value !== undefined && row.seat.value !== exercise.seat) patch.seat = row.seat.value
        if (row.pad.tracked !== !!exercise.trackPad) patch.trackPad = row.pad.tracked
        if (row.pad.tracked && row.pad.value !== undefined && row.pad.value !== exercise.pad) patch.pad = row.pad.value
        if (row.cableHeight.tracked !== !!exercise.trackCableHeight) patch.trackCableHeight = row.cableHeight.tracked
        if (row.cableHeight.tracked && row.cableHeight.value !== undefined && row.cableHeight.value !== exercise.cableHeight)
          patch.cableHeight = row.cableHeight.value
        if (row.backrest.tracked !== !!exercise.trackBackrest) patch.trackBackrest = row.backrest.tracked
        if (row.backrest.tracked && row.backrest.value !== undefined && row.backrest.value !== exercise.backrest)
          patch.backrest = row.backrest.value
        if (row.notes && row.notes !== exercise.notes) patch.notes = row.notes
        if (Object.keys(patch).length === 0) continue
        await db.exercises.update(exercise.id, patch)
        changed++
      }
    })
  })

  return record({ label: 'Übungen', changed, skipped: [] })
}

/** Gleicht die Übungs-Datenbank in beide Richtungen ab. */
export async function syncUebungen(tree?: VaultTree | null): Promise<void> {
  requireSettings()
  await syncFile({
    path: UEBUNGEN_PATH,
    build: buildUebungen,
    commitMessage: 'Sync: Übungs-Datenbank',
    importRemote: async (content) => {
      await importUebungen(content)
    },
    tree,
  })
}
