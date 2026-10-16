import { COL, SPLIT_WIDE_RIGHT } from '../lib/desktop'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, Check, CircleCheck, ChevronDown, ChevronRight, Dumbbell, Minus, Plus, Trash2, X } from 'lucide-react'
import { smartWeightStep, WEIGHT_STEPS } from '../lib/weightStep'
import { usePrefs, type TrainingCard } from '../lib/prefs'
import { useUnits } from '../lib/units'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { getLastExercisePerformance, getOrCreateWorkoutLog, todayIso } from '../db/queries'
import type { Athlete, TrainingPlanExercise, WorkoutLog, WorkoutSet } from '../models/types'
import { Button, Card, DecimalInput, Field, Input, PageSkeleton, Select, StatBadge } from '../components/ui'
import CollapsibleCard from '../components/CollapsibleCard'
import { SortableItem } from '../components/Sortable'
import { useDragSensors, verticalOnly } from '../lib/dragSensors'
import ExercisePickerSheet from '../components/ExercisePickerSheet'
import RestTimer from '../components/RestTimer'
import { autoStartRestTimer } from '../lib/restTimer'
import { celebrateOnce, haptic } from '../lib/feedback'
import StrengthChart from '../components/StrengthChart'
import MuscleHeatmap from '../components/MuscleHeatmap'
import { useMuscleRecords } from '../lib/useMuscleRecords'
import { todaysFocus } from '../lib/muscles'
import WorkoutTimer from '../components/WorkoutTimer'
import LogDayHeader, { type LogDayStatus } from '../components/LogDayHeader'
import LogHistoryList from '../components/LogHistoryList'
import type { DayMarker } from '../components/DayStrip'
import { formatDuration, nextOrder } from '../lib/calculator'
import { useSimpleMode } from '../lib/detailLevel'
import { nextTrainingPlan } from '../lib/nextStep'
import { plannedUnitFor } from '../lib/schedule'
import { triggerAutoSync } from '../features/obsidianSync/autoSync'

type Ctx = { athlete: Athlete }

function durationSeconds(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined
  return Math.max(0, Math.floor((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000))
}

async function createSetsFromPlanExercise(
  logExerciseId: string,
  pe: TrainingPlanExercise,
  lastSets: WorkoutSet[] | undefined,
): Promise<void> {
  const repsNum = Number.parseInt(pe.reps, 10)
  const planReps = Number.isFinite(repsNum) ? repsNum : undefined
  const setsToCreate = Math.max(1, pe.sets)
  // Aufwärmsätze aus dem Plan zuerst - sie zählen nicht ins Volumen.
  const warmups = Math.max(0, pe.warmupSets ?? 0)
  for (let i = 0; i < warmups; i++) {
    await db.workoutSets.add({ id: crypto.randomUUID(), workoutLogExerciseId: logExerciseId, setNumber: i + 1, reps: planReps, warmup: true })
  }
  const working = (lastSets ?? []).filter((x) => !x.warmup)
  for (let i = 0; i < setsToCreate; i++) {
    const lastSet = working[i]
    await db.workoutSets.add({
      id: crypto.randomUUID(),
      workoutLogExerciseId: logExerciseId,
      setNumber: warmups + i + 1,
      reps: lastSet?.reps ?? planReps,
      weightKg: lastSet?.weightKg ?? pe.targetWeightKg,
    })
  }
}

/**
 * Startet den Trainingstimer, sobald zum ersten Mal etwas ins Log kommt (Plan zugeordnet oder
 * Übung hinzugefügt) - einen eigenen Startknopf gibt es nicht mehr.
 */
async function ensureStarted(log: WorkoutLog): Promise<void> {
  if (log.startedAt || log.completedAt) return
  await db.workoutLogs.update(log.id, { startedAt: new Date().toISOString() })
}

export default function WorkoutLogPage() {
  const { athlete } = useOutletContext<Ctx>()
  const simple = useSimpleMode()
  // Karten im Log (Einstellungen → Training).
  const prefs = usePrefs()
  const showCard = (card: TrainingCard) => !prefs.trainingHidden.includes(card)
  const units = useUnits()
  const logs = useLiveQuery(() => db.workoutLogs.where('athleteId').equals(athlete.id).reverse().sortBy('date'), [athlete.id])
  const trainingPlans = useLiveQuery(() => db.trainingPlans.where('athleteId').equals(athlete.id).sortBy('order'), [athlete.id])
  const exercises = useLiveQuery(() => db.exercises.orderBy('name').toArray(), [])

  const [selectedDate, setSelectedDate] = useState(todayIso())
  // Übungsauswahl: ohne swapRowId wird eine neue Zeile angelegt, sonst die Übung getauscht.
  const [picker, setPicker] = useState<{ swapRowId?: string; currentId?: string } | null>(null)
  const currentLog = logs?.find((l) => l.date === selectedDate)

  const rows = useLiveQuery(
    () => (currentLog ? db.workoutLogExercises.where('workoutLogId').equals(currentLog.id).toArray() : []),
    [currentLog?.id],
  )

  const planExercises = useLiveQuery(
    () =>
      currentLog?.trainingPlanId
        ? db.trainingPlanExercises.where('planId').equals(currentLog.trainingPlanId).sortBy('order')
        : [],
    [currentLog?.trainingPlanId],
  )

  // Alle Sätze des Tages in einem Rutsch - Grundlage für die Fortschrittszeile über der Liste.
  const rowIds = (rows ?? []).map((r) => r.id)
  const daySets = useLiveQuery(
    () => (rowIds.length ? db.workoutSets.where('workoutLogExerciseId').anyOf(rowIds).toArray() : []),
    [rowIds.join(',')],
  )

  const exerciseMap = new Map((exercises ?? []).map((e) => [e.id, e]))
  const planMap = new Map((trainingPlans ?? []).map((p) => [p.id, p]))
  const planExerciseByExerciseId = new Map((planExercises ?? []).map((pe) => [pe.exerciseId, pe]))

  // Reihenfolge nach `order`: Beim Übernehmen eines Trainingstags in Plan-Reihenfolge vergeben,
  // manuell ergänzte Übungen hinten angehängt - und per Griff frei umsortierbar.
  const sortedRows = [...(rows ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const sensors = useDragSensors()

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sortedRows.findIndex((r) => r.id === active.id)
    const newIndex = sortedRows.findIndex((r) => r.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(sortedRows, oldIndex, newIndex)
    await db.transaction('rw', db.workoutLogExercises, async () => {
      for (let i = 0; i < reordered.length; i++) await db.workoutLogExercises.update(reordered[i].id, { order: i })
    })
  }

  const muscleRecords = useMuscleRecords(athlete.id)
  const focus = muscleRecords ? todaysFocus(muscleRecords, todayIso(), athlete.muscleTargets) : []

  const setsTotal = daySets?.length ?? 0
  const setsDone = (daySets ?? []).filter((s) => s.done).length

  // Alle Sätze des Tages abgehakt: einmal Konfetti je Trainingseinheit.
  useEffect(() => {
    if (currentLog && setsTotal > 0 && setsDone === setsTotal && selectedDate === todayIso()) {
      celebrateOnce(`training-${currentLog.id}`)
    }
  }, [currentLog, setsTotal, setsDone, selectedDate])

  /** Satz abgehakt: kurz vibrieren und - außer nach dem letzten Satz - die Pause starten. */
  function handleSetCompleted(restSeconds?: number) {
    haptic('tap')
    if (setsDone + 1 < setsTotal) autoStartRestTimer(restSeconds)
  }
  // Aufwärmsätze zählen nicht ins Volumen.
  const volumeKg = (daySets ?? []).reduce((sum, s) => sum + (!s.warmup && s.reps !== undefined && s.weightKg !== undefined ? s.reps * s.weightKg : 0), 0)
  const elapsed = durationSeconds(currentLog?.startedAt, currentLog?.completedAt)

  const markers = new Map<string, DayMarker>((logs ?? []).map((l) => [l.date, l.completedAt ? 'done' : 'open']))
  const status: LogDayStatus = !currentLog ? 'none' : currentLog.completedAt ? 'done' : 'open'

  // Die Übung wird im Sheet gewählt, bevor die Zeile entsteht - keine leeren Zeilen mehr.
  async function addExerciseRow(exerciseId: string) {
    const log = await getOrCreateWorkoutLog(athlete.id, selectedDate)
    await ensureStarted(log)
    const existing = await db.workoutLogExercises.where('workoutLogId').equals(log.id).toArray()
    const exercise = exerciseMap.get(exerciseId)
    // Sitz/Polster bleiben meist von Einheit zu Einheit gleich - deshalb mit dem letzten Wert vorbelegt.
    const last = exercise?.trackSeat || exercise?.trackPad ? await getLastExercisePerformance(athlete.id, exerciseId, selectedDate) : undefined
    await db.workoutLogExercises.add({
      id: crypto.randomUUID(),
      workoutLogId: log.id,
      exerciseId,
      order: nextOrder(existing),
      seat: exercise?.trackSeat ? last?.seat : undefined,
      pad: exercise?.trackPad ? last?.pad : undefined,
    })
  }

  async function deleteExerciseRow(rowId: string) {
    await db.workoutSets.where('workoutLogExerciseId').equals(rowId).delete()
    await db.workoutLogExercises.delete(rowId)
  }

  async function setTrainingPlanId(planId: string) {
    const log = await getOrCreateWorkoutLog(athlete.id, selectedDate)
    await applyPlan(log.id, planId, selectedDate)
  }

  async function applyPlan(logId: string, planId: string, date: string) {
    await db.workoutLogs.update(logId, { trainingPlanId: planId || undefined })
    if (!planId) return
    const log = (await db.workoutLogs.get(logId))!
    await ensureStarted(log)

    const planRows = await db.trainingPlanExercises.where('planId').equals(planId).sortBy('order')
    const existingRows = await db.workoutLogExercises.where('workoutLogId').equals(log.id).toArray()
    const loggedExerciseIds = new Set(existingRows.map((r) => r.exerciseId))
    const newPlanRows = planRows.filter((pe) => !loggedExerciseIds.has(pe.exerciseId))
    const lastPerformances = await Promise.all(
      newPlanRows.map((pe) => getLastExercisePerformance(athlete.id, pe.exerciseId, date)),
    )

    await db.transaction('rw', db.workoutLogExercises, db.workoutSets, async () => {
      let order = nextOrder(existingRows)
      for (let i = 0; i < newPlanRows.length; i++) {
        const pe = newPlanRows[i]
        const exercise = exerciseMap.get(pe.exerciseId)
        const logExerciseId = crypto.randomUUID()
        await db.workoutLogExercises.add({
          id: logExerciseId,
          workoutLogId: log.id,
          exerciseId: pe.exerciseId,
          order: order++,
          seat: exercise?.trackSeat ? lastPerformances[i]?.seat : undefined,
          pad: exercise?.trackPad ? lastPerformances[i]?.pad : undefined,
        })
        await createSetsFromPlanExercise(logExerciseId, pe, lastPerformances[i]?.sets)
      }
    })
  }

  // Vom Dashboard „Training starten“ (`?plan=<id>`): heute mit diesem Trainingstag beginnen.
  const [params, setParams] = useSearchParams()
  const startPlan = params.get('plan')
  // Nur einmal je Plan-Start - React ruft Effekte im Entwicklungsmodus doppelt auf.
  const startedPlan = useRef<string | null>(null)
  useEffect(() => {
    if (!startPlan || startedPlan.current === startPlan) return
    startedPlan.current = startPlan
    setParams(
      (p) => {
        p.delete('plan')
        return p
      },
      { replace: true },
    )
    setSelectedDate(todayIso())
    void (async () => {
      const log = await getOrCreateWorkoutLog(athlete.id, todayIso())
      if (!log.trainingPlanId) await applyPlan(log.id, startPlan, todayIso())
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPlan])

  async function setNotes(notes: string) {
    const log = await getOrCreateWorkoutLog(athlete.id, selectedDate)
    await db.workoutLogs.update(log.id, { notes })
  }

  async function completeWorkout() {
    if (!currentLog) return
    await db.workoutLogs.update(currentLog.id, { completedAt: new Date().toISOString() })
    triggerAutoSync()
  }

  async function reopenWorkout() {
    if (!currentLog) return
    await db.workoutLogs.update(currentLog.id, { completedAt: undefined })
  }

  async function deleteLog() {
    if (!currentLog) return
    const logExercises = await db.workoutLogExercises.where('workoutLogId').equals(currentLog.id).toArray()
    for (const ex of logExercises) {
      await db.workoutSets.where('workoutLogExerciseId').equals(ex.id).delete()
    }
    await db.workoutLogExercises.where('workoutLogId').equals(currentLog.id).delete()
    await db.workoutLogs.delete(currentLog.id)
  }

  if (logs === undefined) return <PageSkeleton />

  return (
    // PC: Tag, Timer und Auswahl links (mitlaufend), Übungen rechts - am Handy untereinander.
    <div className={SPLIT_WIDE_RIGHT}>
      <div className={`${COL} lg:sticky lg:top-0`}>
      <LogDayHeader
        title="Trainingseinheit"
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
        markers={markers}
        status={status}
        onDelete={currentLog ? deleteLog : undefined}
        deleteConfirmText="Trainingseinheit dieses Tages mit allen Sätzen löschen?"
      >
        {/* Ohne Einheit an dem Tag gibt es weder Timer noch Pausentimer - dann auch keine leere Zeile. */}
        {currentLog && (
          <div className="flex flex-wrap items-center gap-2">
            <WorkoutTimer startedAt={currentLog.startedAt} completedAt={currentLog.completedAt} />
            {showCard('timer') && <RestTimer />}
          </div>
        )}
      </LogDayHeader>

      {/* Beim Tageswechsel neu eingeblendet - so sieht man, dass sich der Inhalt geändert hat. */}
      <div key={selectedDate} className={`anim-page ${COL}`}>
        {currentLog && setsTotal > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <StatBadge label="Sätze" value={`${setsDone} / ${setsTotal}`} tone={setsDone === setsTotal ? 'ok' : 'default'} />
            <StatBadge label="Volumen" value={units.format(volumeKg, 'weight', 0)} />
            {/* Die laufende Dauer steht schon im Tageskopf - hier zählt, wie viel Programm
                noch vor einem liegt. */}
            <StatBadge label="Übungen" value={`${sortedRows.length}`} />
          </div>
        )}

        {sortedRows.length === 0 && (trainingPlans?.length ?? 0) > 0 ? (
          <PlanPicker athlete={athlete} date={selectedDate} plans={trainingPlans ?? []} logs={logs ?? []} onPick={(id) => void setTrainingPlanId(id)} />
        ) : (
        <Card className="flex flex-col gap-2">
          <Field label="Trainingstag">
            <Select value={currentLog?.trainingPlanId ?? ''} onChange={(e) => setTrainingPlanId(e.target.value)}>
              <option value="">– kein Plan –</option>
              {trainingPlans?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.phaseName}
                </option>
              ))}
            </Select>
          </Field>
          {sortedRows.length === 0 && (
            <p className="text-xs text-muted">
              Wähle einen Trainingstag – die geplanten Übungen werden samt letzter Gewichte übernommen – oder füge einzelne
              Übungen hinzu.
            </p>
          )}
        </Card>
        )}
      </div>
      </div>

      <div className={COL}>
      <div key={selectedDate} className={`anim-page ${COL}`}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={handleDragEnd}>
          <SortableContext items={sortedRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-3">
              {sortedRows.map((row) => (
                <SortableItem key={row.id} id={row.id} rounded="rounded-2xl">
                  {(handle) => (
                    <WorkoutExerciseRow
                      handle={handle}
                      rowId={row.id}
                      exerciseId={row.exerciseId}
                      exerciseName={exerciseMap.get(row.exerciseId)?.name}
                      notes={row.notes}
                      exerciseNotes={exerciseMap.get(row.exerciseId)?.notes}
                      muscleGroup={exerciseMap.get(row.exerciseId)?.muscleGroup}
                      imageDataUrl={exerciseMap.get(row.exerciseId)?.imageDataUrl}
                      weightStepKg={exerciseMap.get(row.exerciseId)?.weightStepKg}
                      trackSeat={exerciseMap.get(row.exerciseId)?.trackSeat}
                      trackPad={exerciseMap.get(row.exerciseId)?.trackPad}
                      seat={row.seat}
                      pad={row.pad}
                      planExercise={planExerciseByExerciseId.get(row.exerciseId)}
                      athleteId={athlete.id}
                      date={selectedDate}
                      onSetCompleted={handleSetCompleted}
                      onSwap={() => setPicker({ swapRowId: row.id, currentId: row.exerciseId })}
                      onDelete={() => deleteExerciseRow(row.id)}
                    />
                  )}
                </SortableItem>
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <Button variant={sortedRows.length === 0 ? 'primary' : 'secondary'} className="py-3" onClick={() => setPicker({})}>
          + Übung hinzufügen
        </Button>

        <Card className="flex flex-col gap-3">
          {showCard('notizen') && <Field label="Notizen zum Training">
            <textarea
              value={currentLog?.notes ?? ''}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Wie lief die Einheit?"
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </Field>}

          {currentLog?.completedAt ? (
            <div className="flex flex-col items-center gap-1">
              <p className="text-center text-sm text-ok">
                <CircleCheck size={14} className="mr-1 inline -translate-y-px" /> Abgeschlossen am {new Date(currentLog.completedAt).toLocaleString('de-DE')}
                {elapsed !== undefined ? ` · Dauer: ${formatDuration(elapsed)}` : ''}
              </p>
              <Button variant="ghost" onClick={reopenWorkout}>
                Wieder öffnen
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={completeWorkout} disabled={!currentLog}>
              Training beenden
            </Button>
          )}
        </Card>
      </div>

      <ExercisePickerSheet
        open={picker !== null}
        title={picker?.swapRowId ? 'Übung tauschen' : 'Übung hinzufügen'}
        exercises={exercises ?? []}
        selectedId={picker?.currentId}
        onPick={(id) => {
          if (picker?.swapRowId) void db.workoutLogExercises.update(picker.swapRowId, { exerciseId: id })
          else void addExerciseRow(id)
        }}
        onClose={() => setPicker(null)}
      />

      {showCard('verlauf') && <LogHistoryList
        entries={(logs ?? []).map((log) => {
          const seconds = durationSeconds(log.startedAt, log.completedAt)
          return {
            date: log.date,
            done: !!log.completedAt,
            summary: [log.trainingPlanId ? planMap.get(log.trainingPlanId)?.phaseName : undefined, seconds !== undefined ? formatDuration(seconds) : undefined]
              .filter(Boolean)
              .join(' · '),
          }
        })}
        selectedDate={selectedDate}
        onSelect={setSelectedDate}
        emptyText="Noch keine Trainingseinheiten aufgezeichnet."
      />}

      {prefs.showHeatmap && muscleRecords && (
        <CollapsibleCard
          title="Muskel-Heatmap"
          storageKey="heatmap-log"
          summary={focus.length ? `Heute dran: ${focus.join(' · ')}` : '7 Tage'}
        >
          <MuscleHeatmap athlete={athlete} records={muscleRecords} focus={focus} />
        </CollapsibleCard>
      )}

      {!simple && showCard('kraft') && (
        <CollapsibleCard title="Kraft-Verlauf" defaultExpanded={false}>
          <StrengthChart athleteId={athlete.id} />
        </CollapsibleCard>
      )}
      </div>
    </div>
  )
}

function WorkoutExerciseRow({
  handle,
  onSetCompleted,
  rowId,
  exerciseId,
  exerciseName,
  notes,
  exerciseNotes,
  muscleGroup,
  imageDataUrl,
  weightStepKg,
  trackSeat,
  trackPad,
  seat,
  pad,
  planExercise,
  athleteId,
  date,
  onSwap,
  onDelete,
}: {
  handle: ReactNode
  /** Mit der Pause aus dem Plan (falls die Übung dort eine hat). */
  onSetCompleted: (restSeconds?: number) => void
  rowId: string
  exerciseId: string
  exerciseName?: string
  notes?: string
  /** Feste Notiz der Übung selbst (Übungsdatenbank) - bleibt über alle Einheiten gleich. */
  exerciseNotes?: string
  muscleGroup?: string
  imageDataUrl?: string
  weightStepKg?: number
  trackSeat?: boolean
  trackPad?: boolean
  seat?: number
  pad?: number
  planExercise?: TrainingPlanExercise
  athleteId: string
  date: string
  onSwap: () => void
  onDelete: () => void
}) {
  const sets = useLiveQuery(() => db.workoutSets.where('workoutLogExerciseId').equals(rowId).sortBy('setNumber'), [rowId]) ?? []
  const lastPerformance = useLiveQuery(
    () => (exerciseId ? getLastExercisePerformance(athleteId, exerciseId, date) : undefined),
    [athleteId, exerciseId, date],
  )

  // Alle bisherigen Gewichte dieser Übung - daraus lernt der ± Knopf die übliche Schrittweite.
  const historyWeights = useLiveQuery(async () => {
    if (!exerciseId) return []
    const logIds = new Set((await db.workoutLogs.where('athleteId').equals(athleteId).toArray()).map((l) => l.id))
    const rows = (await db.workoutLogExercises.filter((e) => e.exerciseId === exerciseId).toArray()).filter((e) => logIds.has(e.workoutLogId))
    const all = await db.workoutSets.where('workoutLogExerciseId').anyOf(rows.map((r) => r.id)).toArray()
    return all.map((x) => x.weightKg ?? 0)
  }, [athleteId, exerciseId])
  const weightStep = smartWeightStep(exerciseName ?? '', historyWeights ?? [], weightStepKg)
  const prefs = usePrefs()
  const units = useUnits()
  const lbs = prefs.weightUnit === 'lbs'
  // In lbs springen die Knöpfe in runden Pfund-Schritten (2 kg → 5 lbs, 1,25 kg → 2,5 lbs).
  const displayStep = lbs ? Math.max(2.5, Math.round((weightStep.step * 2.20462) / 2.5) * 2.5) : weightStep.step
  // Einfach: ohne RPE-Spalte und ohne Schritt-Auswahl - Wiederholungen und Gewicht reichen.
  const simple = useSimpleMode()
  const showRpe = prefs.showRpe && !simple
  const grid = showRpe ? SET_GRID : SET_GRID_NO_RPE
  // Langes Drücken auf den Satz-Kreis markiert einen Aufwärmsatz.
  const pressTimer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)

  const [expanded, setExpanded] = useState(true)
  const [notesOpen, setNotesOpen] = useState(!!notes)

  const doneCount = sets.filter((s) => s.done).length
  const allDone = sets.length > 0 && doneCount === sets.length

  async function addSet() {
    const last = sets[sets.length - 1]
    const lastPerformanceSet = lastPerformance?.sets[sets.length]
    let reps: number | undefined
    let weightKg: number | undefined
    let rpe: number | undefined
    if (last) {
      reps = last.reps
      weightKg = last.weightKg
      rpe = last.rpe
    } else if (lastPerformanceSet) {
      reps = lastPerformanceSet.reps
      weightKg = lastPerformanceSet.weightKg
    } else if (planExercise) {
      const repsNum = Number.parseInt(planExercise.reps, 10)
      reps = Number.isFinite(repsNum) ? repsNum : undefined
      weightKg = planExercise.targetWeightKg
    }
    const set: WorkoutSet = { id: crypto.randomUUID(), workoutLogExerciseId: rowId, setNumber: sets.length + 1, reps, weightKg, rpe }
    await db.workoutSets.add(set)
  }

  async function deleteSet(setId: string) {
    await db.workoutSets.delete(setId)
    const remaining = sets.filter((s) => s.id !== setId)
    await db.transaction('rw', db.workoutSets, async () => {
      for (let i = 0; i < remaining.length; i++) {
        await db.workoutSets.update(remaining[i].id, { setNumber: i + 1 })
      }
    })
  }

  return (
    <div className={`reveal flex flex-col gap-2 rounded-2xl border bg-surface p-3 shadow-lg shadow-black/30 transition-colors duration-300 ${allDone ? 'border-ok/50' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        {handle}
        {imageDataUrl && <img src={imageDataUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-fg">{exerciseName ?? 'Übung wählen …'}</span>
            <span className="block truncate text-xs text-muted">
              {[muscleGroup, sets.length > 0 ? `${doneCount}/${sets.length} Sätze` : 'Noch keine Sätze'].filter(Boolean).join(' · ')}
            </span>
          </span>
          <ChevronDown size={16} className={`shrink-0 text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {expanded && (
        <>

          {(planExercise || lastPerformance) && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {planExercise && (
                <span className="rounded-full bg-surface-2 px-2 py-1 text-muted">
                  Plan: {planExercise.sets}×{planExercise.reps}
                  {planExercise.targetWeightKg !== undefined ? ` @ ${planExercise.targetWeightKg} kg` : ''}
                </span>
              )}
              {lastPerformance && (
                <span className="rounded-full bg-surface-2 px-2 py-1 text-muted">
                  Vorher = {new Date(`${lastPerformance.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
                </span>
              )}
            </div>
          )}

          {exerciseNotes && <p className="text-xs text-muted">{exerciseNotes}</p>}

          {(trackSeat || trackPad) && (
            <div className="grid grid-cols-2 gap-2">
              {trackSeat && (
                <Field label="Sitz">
                  <DecimalInput
                    value={seat}
                    onChange={(n) => db.workoutLogExercises.update(rowId, { seat: n })}
                    aria-label="Sitz-Einstellung"
                    placeholder="–"
                  />
                </Field>
              )}
              {trackPad && (
                <Field label="Polster">
                  <DecimalInput
                    value={pad}
                    onChange={(n) => db.workoutLogExercises.update(rowId, { pad: n })}
                    aria-label="Polster-Einstellung"
                    placeholder="–"
                  />
                </Field>
              )}
            </div>
          )}

          {sets.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {/* Spaltenköpfe: die Platzhalter in den Feldern verschwinden, sobald ein Wert
                  drinsteht - ohne Kopfzeile weiß danach niemand mehr, was welche Zahl ist.
                  Die Satznummer steht im Abhak-Kreis. */}
              <div className={`grid ${grid} items-center gap-1 text-[10px] uppercase tracking-wide text-muted`}>
                <span />
                <span>Vorher</span>
                <span className="text-center">Wdh.</span>
                <span className="text-center">{units.label('weight')}</span>
                {showRpe && <span className="text-center">RPE</span>}
                <span />
              </div>
              {sets.map((set, i) => {
                const before = lastPerformance?.sets[i]
                return (
                  <div key={set.id} className={`grid ${grid} items-center gap-1 transition-opacity ${set.done ? 'opacity-60' : ''}`}>
                    <button
                      type="button"
                      onPointerDown={() => {
                        longPressed.current = false
                        pressTimer.current = window.setTimeout(() => {
                          longPressed.current = true
                          haptic('success')
                          void db.workoutSets.update(set.id, { warmup: !set.warmup })
                        }, 500)
                      }}
                      onPointerUp={() => window.clearTimeout(pressTimer.current)}
                      onPointerLeave={() => window.clearTimeout(pressTimer.current)}
                      onContextMenu={(e) => e.preventDefault()}
                      onClick={() => {
                        if (longPressed.current) return
                        void db.workoutSets.update(set.id, { done: !set.done })
                        if (!set.done) onSetCompleted(planExercise?.restSeconds ? (set.warmup ? 60 : planExercise.restSeconds) : undefined)
                      }}
                      aria-label={`${set.warmup ? 'Aufwärmsatz' : 'Satz'} ${set.setNumber} als ${set.done ? 'offen' : 'erledigt'} markieren (lange drücken: Aufwärmsatz)`}
                      className={`flex h-8 w-8 select-none items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition active:scale-90 ${
                        set.done ? 'border-accent bg-accent text-accent-fg' : set.warmup ? 'border-dashed border-accent text-accent' : 'border-border text-muted'
                      }`}
                    >
                      {set.done ? <Check size={15} strokeWidth={3} /> : set.warmup ? 'W' : set.setNumber}
                    </button>
                    <span className="truncate text-[11px] leading-tight tabular-nums text-muted" title="Letztes Mal">
                      {before ? (
                        <>
                          {before.reps ?? '–'}×<br />
                          {before.weightKg !== undefined ? units.show(before.weightKg, 'weight')!.toLocaleString('de-DE') : '–'}
                        </>
                      ) : (
                        '–'
                      )}
                    </span>
                    <SetStepper
                      value={set.reps}
                      step={1}
                      label={`Wiederholungen Satz ${set.setNumber}`}
                      onChange={(n) => db.workoutSets.update(set.id, { reps: n === undefined ? undefined : Math.round(n) })}
                    />
                    <SetStepper
                      value={units.show(set.weightKg, 'weight', 1)}
                      step={displayStep}
                      label={`Gewicht in ${units.label('weight')}, Satz ${set.setNumber}`}
                      onChange={(n) => db.workoutSets.update(set.id, { weightKg: units.parse(n, 'weight') })}
                    />
                    {showRpe && (
                      <DecimalInput
                        value={set.rpe}
                        onChange={(n) => db.workoutSets.update(set.id, { rpe: n })}
                        aria-label={`RPE Satz ${set.setNumber}`}
                        placeholder="–"
                        className="px-1! text-center"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => deleteSet(set.id)}
                      aria-label={`Satz ${set.setNumber} löschen`}
                      className="grid place-items-center py-2 text-muted hover:text-danger"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )
              })}
              {!simple && (
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
              <span>Lange drücken = Aufwärmsatz (W)</span>
              <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                ± Schritt
                <select
                  value={weightStepKg ?? ''}
                  onChange={(e) => void db.exercises.update(exerciseId, { weightStepKg: e.target.value ? Number(e.target.value) : undefined })}
                  className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg"
                  aria-label="Gewichtsschritt der ± Knöpfe"
                >
                  <option value="">
                    {weightStep.source === 'eigen' ? 'Automatisch' : `Auto (${weightStep.step.toLocaleString('de-DE')} kg${weightStep.source === 'gelernt' ? ', gelernt' : ''})`}
                  </option>
                  {WEIGHT_STEPS.map((st) => (
                    <option key={st} value={st}>
                      {st.toLocaleString('de-DE')} kg
                    </option>
                  ))}
                </select>
              </label>
              </div>
              )}
            </div>
          )}

          <Button variant="ghost" onClick={addSet}>
            + Satz hinzufügen
          </Button>

          {notesOpen && (
            <Input
              value={notes ?? ''}
              onChange={(e) => db.workoutLogExercises.update(rowId, { notes: e.target.value })}
              placeholder="Notiz zur Übung (z.B. Griff, Technik)"
              aria-label="Notiz zur Übung"
            />
          )}

          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex gap-1">
              <Button variant="ghost" onClick={onSwap}>
                <ArrowLeftRight size={14} className="mr-1 inline" /> Übung tauschen
              </Button>
              {!notesOpen && (
                <Button variant="ghost" onClick={() => setNotesOpen(true)}>
                  + Notiz
                </Button>
              )}
            </div>
            <Button variant="ghost" onClick={onDelete} aria-label="Übung aus dem Log entfernen">
              <Trash2 size={15} />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

const SET_GRID = 'grid-cols-[2rem_1.75rem_1fr_1.25fr_2.25rem_1.25rem]'
const SET_GRID_NO_RPE = 'grid-cols-[2rem_2rem_1fr_1.35fr_1.25rem]'

/** Kompaktes Feld mit − und + für eine Satzzeile. */
function SetStepper({ value, step, label, onChange }: { value: number | undefined; step: number; label: string; onChange: (n: number | undefined) => void }) {
  function bump(dir: 1 | -1) {
    const current = value ?? 0
    const snapped = dir === 1 ? Math.floor(current / step + 1e-9) * step + step : Math.ceil(current / step - 1e-9) * step - step
    haptic('tap')
    onChange(Math.max(0, Math.round(snapped * 100) / 100))
  }
  const btn = 'grid h-9 w-6 shrink-0 place-items-center rounded-md bg-surface-2 text-muted transition active:scale-90 active:text-fg'
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button type="button" className={btn} onClick={() => bump(-1)} aria-label={`${label} verringern`}>
        <Minus size={13} />
      </button>
      <DecimalInput value={value} onChange={onChange} aria-label={label} placeholder="–" className="px-0.5! text-center" />
      <button type="button" className={btn} onClick={() => bump(1)} aria-label={`${label} erhöhen`}>
        <Plus size={13} />
      </button>
    </div>
  )
}

/**
 * Noch nichts eingetragen: die Trainingstage als große Knöpfe statt einer Auswahlliste - der
 * für heute geplante (bzw. nächste) Tag steht oben und ist hervorgehoben.
 */
function PlanPicker({
  athlete,
  date,
  plans,
  logs,
  onPick,
}: {
  athlete: Athlete
  date: string
  plans: { id: string; phaseName: string; order: number }[]
  logs: WorkoutLog[]
  onPick: (planId: string) => void
}) {
  const counts = useLiveQuery(async () => {
    const rows = await db.trainingPlanExercises.where('planId').anyOf(plans.map((p) => p.id)).toArray()
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.planId, (m.get(r.planId) ?? 0) + 1)
    return m
  }, [plans])
  if (!counts) return null
  const sorted = [...plans].sort((x, y) => x.order - y.order)
  const withExercises = new Set([...counts.keys()])
  const plannedIndex = plannedUnitFor(athlete, date)
  const planned = plannedIndex !== undefined ? sorted[plannedIndex] : undefined
  const suggested =
    planned && withExercises.has(planned.id)
      ? planned
      : nextTrainingPlan(sorted as Parameters<typeof nextTrainingPlan>[0], withExercises, logs, date)
  const list = suggested ? [suggested, ...sorted.filter((p) => p.id !== suggested.id)] : sorted
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold text-fg">Welches Training machst du?</h2>
        <p className="text-xs text-muted">Antippen übernimmt die Übungen deines Plans – mit den Gewichten vom letzten Mal.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        {list.map((p) => {
          const top = p.id === suggested?.id
          const n = counts.get(p.id) ?? 0
          return (
            <button
              key={p.id}
              type="button"
              disabled={n === 0}
              onClick={() => onPick(p.id)}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.98] disabled:opacity-40 ${top ? 'border-accent bg-accent/15' : 'border-border bg-surface-2'}`}
            >
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${top ? 'bg-accent text-accent-fg' : 'bg-surface text-muted'}`}>
                <Dumbbell size={17} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-fg">{p.phaseName}</span>
                <span className="text-xs text-muted">
                  {n} {n === 1 ? 'Übung' : 'Übungen'}
                  {top ? (planned?.id === p.id ? ' · heute geplant' : ' · als Nächstes dran') : ''}
                </span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted">Oder unten einzelne Übungen hinzufügen.</p>
    </Card>
  )
}
