import type { Muscle } from '../lib/muscles'
export type Gender = 'Männlich' | 'Weiblich'

export interface Athlete {
  id: string
  name: string
  accentColor: string
  order: number
  gender: Gender
  age: number
  heightCm: number
  weightKg: number
  activityLevel: string
  goal: string
  proteinPerKg: number
  fatPerKg: number
  calorieAdjustmentKcal?: number // manuelles Kalorien-Defizit (negativ) / -überschuss (positiv), überschreibt die Ziel-Voreinstellung
  startDate: string // ISO date
  targetWeightKg?: number
  targetDate?: string // ISO date
  ffmi?: number // Fettfreie-Masse-Index (kg/m²), manuell erfasst - dient zur Rückrechnung des KFA
  waterGoalMl?: number // eigenes Trinkziel; ohne gilt 35 ml je kg Körpergewicht
  muscleTargets?: Partial<Record<Muscle, number>> // eigene Wochen-Richtwerte (Sätze) je Muskel
  birthDate?: string // ISO date - wenn gesetzt, wird `age` daraus aktuell gehalten
  trainingDays?: number[] // geplante Trainingstage, 0 = Montag … 6 = Sonntag
  /**
   * Wochenplan: feste Tage mit Einheit je Tag (Index = Plan-Reihenfolge, passend zu den
   * sortierten `trainingDays`) oder ein rotierender Rhythmus ab einem Startdatum.
   */
  schedule?: { mode: 'fixed'; dayPlans?: number[] } | { mode: 'rotation'; on: number; off: number; start: string }
  startAnswers?: unknown // Antworten aus „Dein Start“ (lib/startPlan StartAnswers)
}

export interface BackgroundPhoto {
  id: string
  photo: Blob
}

export interface DailyEntry {
  id: string
  athleteId: string
  date: string // ISO date, one entry per athlete per day
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
  hip?: number // weitere Maße (einschaltbar in den Einstellungen)
  glute?: number
  calf?: number
  neck?: number
  sleepH?: number // Schlaf der letzten Nacht in Stunden
  steps?: number
  notes?: string
  waterMl?: number // getrunkenes Wasser des Tages
}

export interface FoodItem {
  id: string
  name: string
  kcal: number
  protein: number
  carbs: number
  fat: number
  favorite?: boolean
  // Aus dem Vault übernommener Schätzwert (Lebensmittel-Neu.md), nicht aus einer
  // Nährwertquelle. Bleibt gesetzt, bis die Werte in der App bestätigt wurden.
  unconfirmed?: boolean
  // Aus Open Food Facts übernommen - Barcode und Marke helfen, dasselbe Produkt bei einer
  // weiteren Übernahme wiederzufinden.
  source?: 'off'
  barcode?: string
  brand?: string
  // Eigene Mengen-Schnellauswahl in Gramm (z. B. Ei: 60, 120, 180) - ohne gilt die Automatik
  // aus gelernten Mengen und den Standard-Mengen.
  portions?: number[]
  // Schnell-Eintrag ("Restaurant ca. 900 kcal"): Werte gelten für die ganze Portion (als 100 g
  // gespeichert). Taucht nicht in Suche und Datenbank auf, nur im Log.
  quick?: boolean
}

export interface NutritionPlan {
  id: string
  athleteId: string
  phaseName: string
  order: number
  /**
   * Rezept statt Tagesplan: Die Zeilen sind die Zutaten eines Gerichts, das portionsweise ins
   * Tageslog eingefügt wird - nicht ein Tagesablauf, den man als Ganzes übernimmt. Rezepte
   * tauchen deshalb weder in der Planauswahl des Logs noch in der Phasenleiste der Tagesplaene
   * auf, sondern in einer eigenen Liste.
   */
  isRecipe?: boolean
  /**
   * Wie viele Portionen das **komplette** Rezept ergibt. Die Zutatenmengen beschreiben immer
   * den ganzen Ansatz; wer eine von zwei Portionen isst, bekommt sie halbiert ins Log.
   * Fehlt der Wert (Altbestand) oder ist er unbrauchbar, gilt eine Portion - dann ist die
   * eingegebene Portionszahl direkt der Faktor.
   */
  servings?: number
  /**
   * Gewicht des fertigen Gerichts in Gramm (z.B. nach dem Kochen). Grundlage, wenn im Log eine
   * Menge in Gramm statt in Portionen eingefügt wird. Fehlt der Wert, zählt die Summe der
   * Zutaten-Grammzahlen.
   */
  cookedWeightG?: number
}

// Die ersten sieben Plätze sind Standard; der achte lässt sich in den Einstellungen einschalten.
// Gespeichert wird der Platz-Schlüssel, der Anzeigename kommt aus den Einstellungen (mealLabel).
export const MEAL_TYPES = [
  'Frühstück',
  'Snack 1',
  'Mittagessen',
  'Snack 2',
  'Pre-Workout',
  'Post-Workout',
  'Abendessen',
  'Mahlzeit 8',
] as const

export type MealType = (typeof MEAL_TYPES)[number]

export interface PlanMeal {
  id: string
  planId: string
  mealType: MealType
  foodItemId: string
  grams: number
  order: number
}

export const SUPPLEMENT_TIMINGS = [
  'Morgens',
  'Mittags',
  'Abends',
  'Vor dem Training',
  'Nach dem Training',
  'Vor dem Schlafen',
] as const

export type SupplementTiming = (typeof SUPPLEMENT_TIMINGS)[number]

export interface Supplement {
  id: string
  name: string
  defaultDose: string // z.B. "5 g", "1 Kapsel"
  defaultTiming: SupplementTiming
  notes?: string
}

export interface SupplementPlan {
  id: string
  athleteId: string
  phaseName: string
  order: number
}

export interface SupplementPlanItem {
  id: string
  planId: string
  supplementId: string
  dose: string
  timing: SupplementTiming
  notes?: string
  order: number // Reihenfolge innerhalb des Einnahmezeitpunkts
}

export const MUSCLE_GROUPS = ['Brust', 'Rücken', 'Beine', 'Schultern', 'Arme', 'Bauch', 'Ganzkörper', 'Sonstiges'] as const

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number]

export interface Exercise {
  id: string
  name: string
  muscleGroup: MuscleGroup
  favorite?: boolean
  imageDataUrl?: string // herunterskaliertes Übungsbild als Base64-Data-URL
  primaryMuscle?: Muscle // Hauptmuskel für die Heatmap; ohne wird er aus dem Namen erkannt
  secondaryMuscles?: Muscle[] // mitarbeitende Muskeln (zählen im Wochenvolumen halb)
  weightStepKg?: number // Sprung der ± Knöpfe beim Gewicht; ohne wird er gelernt bzw. geraten
  trackSeat?: boolean // Sitz-Einstellung der Maschine wird je Einheit im Trainingslog erfasst
  trackPad?: boolean // Polster-Einstellung der Maschine wird je Einheit im Trainingslog erfasst
  notes?: string // feste Notiz zur Übung (z.B. Technik, Geräte-Einstellung) - bleibt über alle Einheiten hinweg erhalten
}

export interface TrainingPlan {
  id: string
  athleteId: string
  phaseName: string
  order: number
  timesPerWeek?: number // wie oft pro Woche - ohne: aus Trainingstagen bzw. Rhythmus
}

export interface TrainingPlanExercise {
  id: string
  planId: string
  exerciseId: string
  order: number
  sets: number
  reps: string // z.B. "8-12" oder "10"
  targetWeightKg?: number
  notes?: string
  restSeconds?: number // Pause nach jedem Satz; ohne gilt die Standard-Pause
  warmupSets?: number // Aufwärmsätze vor den Arbeitssätzen
}

export interface WorkoutLog {
  id: string
  athleteId: string
  date: string // ISO date, ein Eintrag pro Tag
  trainingPlanId?: string // welcher geplante Trainingstag absolviert wurde
  notes?: string
  startedAt?: string // ISO-Zeitstempel, automatisch gesetzt beim Zuordnen eines Plans bzw. Hinzufügen einer Übung
  completedAt?: string // ISO-Zeitstempel, gesetzt über den "Training beenden"-Button
}

export interface WorkoutLogExercise {
  id: string
  workoutLogId: string
  exerciseId: string
  order: number
  notes?: string
  seat?: number // Sitz-Einstellung dieser Einheit, falls bei der Übung aktiviert
  pad?: number // Polster-Einstellung dieser Einheit, falls bei der Übung aktiviert
}

export interface WorkoutSet {
  id: string
  workoutLogExerciseId: string
  setNumber: number
  reps?: number
  weightKg?: number
  rpe?: number // gefühlte Anstrengung (RPE), 1-10
  done?: boolean // während des Trainings per Häkchen als erledigt markiert
  warmup?: boolean // Aufwärmsatz - zählt nicht ins Volumen und nicht in Rekorde
}

export interface NutritionLog {
  id: string
  athleteId: string
  date: string // ISO date, ein Eintrag pro Tag
  nutritionPlanId?: string // welche geplante Ernährungsplan-Phase übernommen wurde
  notes?: string
  completedAt?: string // veraltet: früherer "Tag abschließen"-Knopf, wird nicht mehr gesetzt
}

export interface NutritionLogItem {
  id: string
  nutritionLogId: string
  mealType: MealType
  foodItemId: string
  grams: number
  order: number
  done?: boolean // veraltet: früheres "gegessen"-Häkchen, wird nicht mehr ausgewertet
}
