import { describe, expect, it } from 'vitest'
import { buildFrontmatter, escapeCell, tableRow, tableSeparator } from './markdownBuild'
import {
  isCurrentFormat,
  parseErnaehrungLog,
  parseFrontmatter,
  parseGewicht,
  parseLebensmittel,
  parseLebensmittelNeu,
  parseMealPhases,
  parseSupplementDatenbank,
  parseSupplemente,
  parseTraining,
  parseTrainingsplaene,
  parseUebungen,
  rebuildLebensmittelNeu,
  splitTableRow,
} from './markdownParse'

/**
 * Der Vault-Sync schreibt Markdown und liest es wieder - jeder Test hier prüft genau diese
 * Runde: Der Eingabetext ist so aufgebaut, wie die `*Export.ts`-Module ihn erzeugen.
 */

describe('buildFrontmatter', () => {
  it('lässt leere Felder weg und setzt die Formatversion', () => {
    expect(buildFrontmatter({ typ: 'training', datum: '2026-07-28', plan: undefined, dauer_min: 0 })).toEqual([
      '---',
      'typ: training',
      'datum: 2026-07-28',
      'dauer_min: 0',
      'format: 2',
      '---',
      '',
    ])
  })
})

describe('parseFrontmatter', () => {
  const content = ['---', 'typ: athlet', 'name: "Max Mustermann"', 'ziel: Diät / Fettabbau', 'format: 2', '---', '', '# Max'].join('\n')

  it('liest flache Schlüssel-Wert-Paare und entfernt Anführungszeichen', () => {
    expect(parseFrontmatter(content)).toEqual({
      typ: 'athlet',
      name: 'Max Mustermann',
      ziel: 'Diät / Fettabbau',
      format: '2',
    })
  })

  it('erkennt die Formatversion', () => {
    expect(isCurrentFormat(content)).toBe(true)
    expect(isCurrentFormat('---\ntyp: athlet\n---\n')).toBe(false)
    expect(isCurrentFormat('# Ohne Frontmatter')).toBe(false)
  })
})

describe('splitTableRow', () => {
  it('behandelt maskierte Pipes als Inhalt und stellt Zeilenumbrüche wieder her', () => {
    expect(splitTableRow('| A \\| B | zwei<br>Zeilen | |')).toEqual(['A | B', 'zwei\nZeilen', ''])
  })

  it('ist das Gegenstück zu escapeCell', () => {
    const value = 'Notiz mit | Pipe\nund Umbruch'
    expect(splitTableRow(`| ${escapeCell(value)} |`)).toEqual([value])
  })
})

describe('parseGewicht', () => {
  it('liest alle Tracking-Spalten', () => {
    const content = [
      ...buildFrontmatter({ typ: 'gewicht' }),
      tableRow(['Datum', 'Gewicht (kg)', 'KFA (%)', 'kcal', 'Protein (g)', 'KH (g)', 'Fett (g)', 'Bauch (cm)', 'Arm (cm)', 'Brust (cm)', 'Bein (cm)', 'Notiz']),
      tableSeparator(12),
      tableRow(['2026-07-29', '84.5', '12.3', 2500, 180, 250, 70, 80, 38, 105, 60, 'Guter Tag']),
      tableRow(['2026-07-28', '84,1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]),
    ].join('\n')

    expect(parseGewicht(content)).toEqual([
      {
        date: '2026-07-29',
        weightKg: 84.5,
        bodyFatPct: 12.3,
        calories: 2500,
        protein: 180,
        carbs: 250,
        fat: 70,
        waist: 80,
        arm: 38,
        chest: 105,
        leg: 60,
        notes: 'Guter Tag',
      },
      {
        date: '2026-07-28',
        weightKg: 84.1, // Komma als Dezimaltrenner
        bodyFatPct: undefined,
        calories: undefined,
        protein: undefined,
        carbs: undefined,
        fat: undefined,
        waist: undefined,
        arm: undefined,
        chest: undefined,
        leg: undefined,
        notes: undefined,
      },
    ])
  })

  it('liest die zweispaltige Tabelle älterer App-Versionen weiter', () => {
    const content = ['---', 'typ: gewicht', '---', '', '| Datum | Gewicht (kg) |', '| --- | --- |', '| 2026-07-28 | 84.5 |'].join('\n')
    const rows = parseGewicht(content)
    expect(rows).toHaveLength(1)
    expect(rows[0].weightKg).toBe(84.5)
    expect(rows[0].notes).toBeUndefined()
  })

  it('nimmt je Datum die erste Zeile und überspringt Unlesbares', () => {
    const content = ['| 2026-07-28 | 84.5 |', '| 2026-07-28 | 99 |', '| kein Datum | 70 |'].join('\n')
    expect(parseGewicht(content)).toEqual([{ ...emptyRow('2026-07-28'), weightKg: 84.5 }])
  })
})

function emptyRow(date: string) {
  return {
    date,
    weightKg: undefined,
    bodyFatPct: undefined,
    calories: undefined,
    protein: undefined,
    carbs: undefined,
    fat: undefined,
    waist: undefined,
    arm: undefined,
    chest: undefined,
    leg: undefined,
    notes: undefined,
  }
}

describe('parseTraining', () => {
  const content = [
    ...buildFrontmatter({
      typ: 'training',
      datum: '2026-07-28',
      plan: 'Push A',
      start: '2026-07-28T17:00:00.000Z',
      ende: '2026-07-28T18:30:00.000Z',
      dauer_min: 90,
    }),
    '### Bankdrücken',
    '_Notiz: langsam ablassen_',
    '- [x] Satz 1 · 8 Wdh. · 100 kg · RPE 8',
    '- [ ] Satz 2 · 6 Wdh. · 105 kg',
    '',
    '### Butterfly',
    '_Keine Sätze erfasst._',
    '',
    '## Trainingsnotiz',
    '',
    'Gute Session.',
    '',
    '## Notizen',
    '### Das ist keine Übung',
    '- [x] Satz 1 · 5 Wdh.',
    '',
  ].join('\n')

  it('liest Kopfdaten, Übungsnotiz und Sätze', () => {
    const day = parseTraining(content)
    expect(day.planName).toBe('Push A')
    expect(day.startedAt).toBe('2026-07-28T17:00:00.000Z')
    expect(day.completedAt).toBe('2026-07-28T18:30:00.000Z')
    expect(day.notes).toBe('Gute Session.')
    expect(day.exercises[0]).toEqual({
      name: 'Bankdrücken',
      notes: 'langsam ablassen',
      sets: [
        { setNumber: 1, reps: 8, weightKg: 100, rpe: 8, done: true },
        { setNumber: 2, reps: 6, weightKg: 105, done: false },
      ],
    })
  })

  it('behält eine Übung ohne Sätze', () => {
    expect(parseTraining(content).exercises.map((e) => e.name)).toEqual(['Bankdrücken', 'Butterfly'])
  })

  it('liest keine Übung aus dem eigenen Notizen-Block', () => {
    expect(parseTraining(content).exercises).toHaveLength(2)
  })

  it('verwirft unlesbare Zeitstempel', () => {
    const day = parseTraining(['---', 'typ: training', 'start: irgendwann', '---', '', '### Kniebeuge', '- [x] Satz 1 · 5 Wdh.'].join('\n'))
    expect(day.startedAt).toBeUndefined()
    expect(day.exercises).toHaveLength(1)
  })
})

describe('parseSupplemente', () => {
  it('liest alle Plan-Phasen', () => {
    const content = [
      ...buildFrontmatter({ typ: 'supplemente' }),
      '## Plan: Aufbau',
      '',
      '- **Kreatin** – 5 g, Morgens (mit Wasser)',
      '- **Omega 3** – 2,5 g, Abends',
      '',
      '## Plan: Diät',
      '',
      '- **Koffein** – 200 mg, Vor dem Training',
      '',
      '## Notizen',
      '- **Nicht im Plan** – 1 Kapsel, Morgens',
    ].join('\n')

    expect(parseSupplemente(content)).toEqual([
      {
        phaseName: 'Aufbau',
        items: [
          { name: 'Kreatin', dose: '5 g', timing: 'Morgens', notes: 'mit Wasser' },
          { name: 'Omega 3', dose: '2,5 g', timing: 'Abends', notes: undefined },
        ],
      },
      { phaseName: 'Diät', items: [{ name: 'Koffein', dose: '200 mg', timing: 'Vor dem Training', notes: undefined }] },
    ])
  })

  it('versteht die alte Überschrift "Aktueller Plan"', () => {
    const content = ['## Aktueller Plan: Erhaltung', '', '- **Kreatin** – 5 g, Morgens'].join('\n')
    expect(parseSupplemente(content)[0].phaseName).toBe('Erhaltung')
  })
})

describe('parseMealPhases', () => {
  it('gruppiert Mahlzeiten nach Phase und Mahlzeitentyp', () => {
    const content = [
      ...buildFrontmatter({ typ: 'ernaehrungsplan' }),
      '## Plan: Phase 1',
      '',
      '### Frühstück',
      '- Haferflocken – 80g (300 kcal)',
      '',
      '### Mittagessen',
      '- Reis (roh) – 100g (349 kcal)',
      '',
      '**Gesamt:** 649 kcal · 20 g Protein · 100 g Kohlenhydrate · 10 g Fett',
      '',
      '## Plan: Phase 2',
      '',
      '### Frühstück',
      '- Haferflocken – 100g (375 kcal)',
      '',
      '## Notizen',
      '### Frühstück',
      '- Erfundenes – 50g',
    ].join('\n')

    const phases = parseMealPhases(content)
    expect(phases).toHaveLength(2)
    expect(phases[0]).toEqual({
      phaseName: 'Phase 1',
      items: [
        { mealType: 'Frühstück', name: 'Haferflocken', grams: 80, done: false },
        { mealType: 'Mittagessen', name: 'Reis (roh)', grams: 100, done: false },
      ],
    })
    expect(phases[1].items).toHaveLength(1)
  })

  it('liest "## Rezept:" als Rezept samt Ausbeute', () => {
    const content = [
      ...buildFrontmatter({ typ: 'ernaehrungsplan' }),
      '## Plan: Phase 1',
      '',
      '### Frühstück',
      '- Haferflocken – 80g (300 kcal)',
      '',
      '## Rezept: Protein-Eis Schoko',
      '',
      '**Ergibt:** 2 Portionen',
      '**Fertiggewicht:** 1200 g',
      '',
      '### Snack 1',
      '- Joghurt (natur, 3,5%) – 150g (96 kcal)',
      '- Whey Protein (Pulver) – 60g (236 kcal)',
      '',
      '**Gesamt:** 332 kcal · 27 g Protein · 9 g Kohlenhydrate · 7 g Fett',
      '**Je Portion:** 166 kcal · 13 g Protein · 5 g Kohlenhydrate · 4 g Fett',
      '',
    ].join('\n')

    const phases = parseMealPhases(content)
    expect(phases).toHaveLength(2)
    expect(phases[0].isRecipe).toBeUndefined()
    expect(phases[1]).toEqual({
      phaseName: 'Protein-Eis Schoko',
      isRecipe: true,
      servings: 2,
      cookedWeightG: 1200,
      items: [
        { mealType: 'Snack 1', name: 'Joghurt (natur, 3,5%)', grams: 150, done: false },
        { mealType: 'Snack 1', name: 'Whey Protein (Pulver)', grams: 60, done: false },
      ],
    })
  })

  it('nimmt ein Rezept ohne "**Ergibt:**"-Zeile hin', () => {
    const content = [
      ...buildFrontmatter({ typ: 'ernaehrungsplan' }),
      '## Rezept: Handgeschrieben',
      '',
      '### Snack 1',
      '- Haferflocken – 80g',
      '',
    ].join('\n')

    const [phase] = parseMealPhases(content)
    expect(phase.isRecipe).toBe(true)
    expect(phase.servings).toBeUndefined()
  })

  it('überliest den Vorgabe-Block unter den Mahlzeiten', () => {
    const content = [
      ...buildFrontmatter({ typ: 'ernaehrungsplan', ziel_kalorien: 2500, ziel_protein_g: 180 }),
      '## Plan: Phase 1',
      '',
      '### Frühstück',
      '- Haferflocken – 80g (300 kcal)',
      '',
      '**Vorgabe:** 2500 kcal · 180 g Protein · 250 g Kohlenhydrate · 70 g Fett',
      '**Gesamt:** 300 kcal · 10 g Protein · 50 g Kohlenhydrate · 5 g Fett',
      '**Differenz:** -2200 kcal · -170 g Protein · -200 g Kohlenhydrate · -65 g Fett',
      '',
    ].join('\n')

    expect(parseMealPhases(content)).toEqual([
      { phaseName: 'Phase 1', items: [{ mealType: 'Frühstück', name: 'Haferflocken', grams: 80, done: false }] },
    ])
  })
})

describe('parseErnaehrungLog', () => {
  it('liest Mahlzeiten, Plan, Abschluss und Tagesnotiz', () => {
    const content = [
      ...buildFrontmatter({
        typ: 'ernaehrung',
        datum: '2026-07-29',
        plan: 'Phase 1',
        abgeschlossen: '2026-07-29T20:00:00.000Z',
        kalorien: 300,
      }),
      '### Frühstück',
      '- [x] Haferflocken – 80g (300 kcal)',
      '- [ ] Banane – 120g (108 kcal)',
      '',
      '## Tagesnotiz',
      '',
      'Viel Hunger.',
      '',
    ].join('\n')

    const day = parseErnaehrungLog(content)
    expect(day.planName).toBe('Phase 1')
    expect(day.completedAt).toBe('2026-07-29T20:00:00.000Z')
    expect(day.notes).toBe('Viel Hunger.')
    expect(day.items).toEqual([
      { mealType: 'Frühstück', name: 'Haferflocken', grams: 80, done: true },
      { mealType: 'Frühstück', name: 'Banane', grams: 120, done: false },
    ])
  })

  // Vorgabe und Bilanz sind reine Ausgabe: Sie stehen zwischen Mahlzeiten und Tagesnotiz und
  // dürfen weder als Mahlzeit gelesen werden noch die Tagesnotiz verschlucken.
  it('überliest Vorgabe und Bilanz zwischen Mahlzeiten und Tagesnotiz', () => {
    const content = [
      ...buildFrontmatter({
        typ: 'ernaehrung',
        datum: '2026-07-29',
        kalorien: 300,
        ziel_kalorien: 2500,
        ziel_protein_g: 180,
        ziel_kohlenhydrate_g: 250,
        ziel_fett_g: 70,
      }),
      '### Frühstück',
      '- [x] Haferflocken – 80g (300 kcal)',
      '',
      '**Vorgabe:** 2500 kcal · 180 g Protein · 250 g Kohlenhydrate · 70 g Fett',
      '**Gegessen:** 300 kcal · 10 g Protein · 50 g Kohlenhydrate · 5 g Fett',
      '**Differenz:** -2200 kcal · -170 g Protein · -200 g Kohlenhydrate · -65 g Fett',
      '',
      '## Tagesnotiz',
      '',
      'Viel Hunger.',
      '',
    ].join('\n')

    const day = parseErnaehrungLog(content)
    expect(day.items).toEqual([{ mealType: 'Frühstück', name: 'Haferflocken', grams: 80, done: true }])
    expect(day.notes).toBe('Viel Hunger.')
  })
})

describe('parseTrainingsplaene', () => {
  it('liest Phasen mit ihren Übungstabellen', () => {
    const content = [
      ...buildFrontmatter({ typ: 'trainingsplaene' }),
      '## Plan: Push A',
      '',
      tableRow(['Übung', 'Sätze', 'Wdh.', 'Zielgewicht (kg)', 'Notiz']),
      tableSeparator(5),
      tableRow(['Bankdrücken', 4, '8-12', '100', 'langsam ablassen']),
      tableRow(['Schulterdrücken', 3, '10', undefined, undefined]),
      '',
      '## Plan: Pull A',
      '',
      tableRow(['Übung', 'Sätze', 'Wdh.', 'Zielgewicht (kg)', 'Notiz']),
      tableSeparator(5),
      tableRow(['Klimmzüge', 4, 'max', undefined, undefined]),
    ].join('\n')

    expect(parseTrainingsplaene(content)).toEqual([
      {
        phaseName: 'Push A',
        items: [
          { name: 'Bankdrücken', sets: 4, reps: '8-12', targetWeightKg: 100, notes: 'langsam ablassen' },
          { name: 'Schulterdrücken', sets: 3, reps: '10', targetWeightKg: undefined, notes: undefined },
        ],
      },
      { phaseName: 'Pull A', items: [{ name: 'Klimmzüge', sets: 4, reps: 'max', targetWeightKg: undefined, notes: undefined }] },
    ])
  })
})

describe('parseUebungen', () => {
  const empty = { tracked: false }

  it('liest Muskelgruppe und Favorit, ignoriert unbekannte Gruppen', () => {
    const content = [
      ...buildFrontmatter({ typ: 'uebungen' }),
      tableRow(['Übung', 'Muskelgruppe', 'Favorit']),
      tableSeparator(3),
      tableRow(['Bankdrücken', 'Brust', 'ja']),
      tableRow(['Hackenschmidt', 'Quadrizeps', undefined]),
    ].join('\n')

    expect(parseUebungen(content)).toEqual([
      {
        name: 'Bankdrücken',
        muscleGroup: 'Brust',
        favorite: true,
        primaryMuscle: undefined,
        secondaryMuscles: undefined,
        weightStepKg: undefined,
        seat: empty,
        pad: empty,
        cableHeight: empty,
        backrest: empty,
        notes: undefined,
      },
      {
        name: 'Hackenschmidt',
        muscleGroup: undefined,
        favorite: false,
        primaryMuscle: undefined,
        secondaryMuscles: undefined,
        weightStepKg: undefined,
        seat: empty,
        pad: empty,
        cableHeight: empty,
        backrest: empty,
        notes: undefined,
      },
    ])
  })

  it('liest Hauptmuskel, Nebenmuskeln, Gewichtsschritt, Geräte-Einstellungen und Notiz', () => {
    const content = [
      ...buildFrontmatter({ typ: 'uebungen' }),
      tableRow(['Übung', 'Muskelgruppe', 'Favorit', 'Hauptmuskel', 'Nebenmuskeln', 'Gewichtsschritt (kg)', 'Sitz', 'Polster', 'Kabelturmhöhe', 'Rückenlehne', 'Notiz']),
      tableSeparator(11),
      tableRow(['Beinpresse', 'Beine', undefined, 'Quadrizeps', 'Po, Beinbeuger', '5', '4', 'ja', undefined, undefined, 'Sitz Stufe 4']),
    ].join('\n')

    expect(parseUebungen(content)).toEqual([
      {
        name: 'Beinpresse',
        muscleGroup: 'Beine',
        favorite: false,
        primaryMuscle: 'Quadrizeps',
        secondaryMuscles: ['Po', 'Beinbeuger'],
        weightStepKg: 5,
        seat: { tracked: true, value: 4 },
        pad: { tracked: true, value: undefined },
        cableHeight: empty,
        backrest: empty,
        notes: 'Sitz Stufe 4',
      },
    ])
  })
})

describe('parseSupplementDatenbank', () => {
  it('liest Stammdaten und prüft das Timing', () => {
    const content = [
      tableRow(['Supplement', 'Standarddosis', 'Timing', 'Notiz']),
      tableSeparator(4),
      tableRow(['Kreatin', '5 g', 'Morgens', 'mit Wasser']),
      tableRow(['Magnesium', '400 mg', 'Nachts', undefined]),
    ].join('\n')

    expect(parseSupplementDatenbank(content)).toEqual([
      { name: 'Kreatin', defaultDose: '5 g', defaultTiming: 'Morgens', notes: 'mit Wasser' },
      { name: 'Magnesium', defaultDose: '400 mg', defaultTiming: undefined, notes: undefined },
    ])
  })
})

describe('parseLebensmittel', () => {
  it('liest Nährwerte samt Favorit und Unbestätigt', () => {
    const content = [
      ...buildFrontmatter({ typ: 'lebensmittel' }),
      '# Lebensmittel-Datenbank',
      '',
      'Erklärender Text, keine Tabellenzeile.',
      '',
      tableRow(['Name', 'kcal', 'Protein', 'KH', 'Fett', 'Favorit', 'Unbestätigt']),
      tableSeparator(7),
      tableRow(['Reis (roh)', 349, '7.0', '78.0', '0.6', 'ja', undefined]),
      tableRow(['Popcorn', 450, '5.5', '72.0', '12.5', undefined, 'ja']),
    ].join('\n')

    expect(parseLebensmittel(content)).toEqual([
      { name: 'Reis (roh)', kcal: 349, protein: 7, carbs: 78, fat: 0.6, favorite: true, unconfirmed: false },
      { name: 'Popcorn', kcal: 450, protein: 5.5, carbs: 72, fat: 12.5, favorite: false, unconfirmed: true },
    ])
  })
})

describe('parseLebensmittelNeu', () => {
  const content = [
    '| Name | kcal | Protein | KH | Fett | Herkunft |',
    '|---|---|---|---|---|---|',
    '| Popcorn (Kino, süß) | 450 | 5.5 | 72.0 | 12.5 | Claude, geschätzt |',
    '| Kaputte Zeile | keine Zahl | 1 | 2 | 3 |',
  ].join('\n')

  it('trennt lesbare von fehlerhaften Zeilen', () => {
    const rows = parseLebensmittelNeu(content)
    expect(rows).toHaveLength(2)
    expect(rows[0].food).toEqual({
      name: 'Popcorn (Kino, süß)',
      kcal: 450,
      protein: 5.5,
      carbs: 72,
      fat: 12.5,
      origin: 'Claude, geschätzt',
    })
    expect(rows[1].food).toBeNull()
  })

  it('lässt beim Leeren nur die fehlerhaften Zeilen stehen', () => {
    const rows = parseLebensmittelNeu(content)
    const kept = rows.filter((r) => !r.food).map((r) => r.line)
    expect(rebuildLebensmittelNeu(content, kept)).toBe(
      [
        '| Name | kcal | Protein | KH | Fett | Herkunft |',
        '|---|---|---|---|---|---|',
        '| Kaputte Zeile | keine Zahl | 1 | 2 | 3 |',
      ].join('\n'),
    )
  })
})
