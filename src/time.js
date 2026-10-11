/**
 * Tijdhulpjes in Nederlandse tijd (Europe/Amsterdam), zonder extra pakketten.
 * Alle tijdstippen worden intern als UTC-milliseconden of ISO-UTC bewaard;
 * alleen voor weergave en "welke dag is het" rekenen we om.
 */
export const TIME_ZONE = "Europe/Amsterdam";

const ymdFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFormat = new Intl.DateTimeFormat("nl-NL", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hourFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" });
const dayNameFormat = new Intl.DateTimeFormat("nl-NL", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" });

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/** "2026-10-12" (Nederlandse kalenderdag van een tijdstip). */
export function amsterdamYmd(t) {
  return ymdFormat.format(toDate(t));
}

/** "14:05" in Nederlandse tijd. */
export function hhmm(t) {
  if (t === null || t === undefined) return "?";
  const d = toDate(t);
  return isNaN(d.getTime()) ? "?" : hmFormat.format(d);
}

/** Uur (0-23) in Nederlandse tijd. */
export function amsterdamHour(t) {
  return Number(hourFormat.format(toDate(t))) % 24;
}

/** "maandag 12 oktober". */
export function dayLabel(ymd) {
  return dayNameFormat.format(new Date(`${ymd}T12:00:00Z`));
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Begin (incl.) en einde (excl.) van een Nederlandse kalenderdag, in UTC-ms. */
export function dayBoundsMs(ymd) {
  // Zoek het eerste UTC-uur waarop de Nederlandse datum `ymd` is (werkt ook rond de zomertijdwissel).
  const base = Date.parse(`${ymd}T00:00:00Z`);
  let start = null;
  for (let h = -3; h <= 3; h++) {
    const t = base + h * 3600000;
    if (amsterdamYmd(t) === ymd && amsterdamHour(t) === 0) {
      start = t;
      break;
    }
  }
  if (start === null) start = base - 3600000;
  const nextYmd = addDays(ymd, 1);
  const nextBase = Date.parse(`${nextYmd}T00:00:00Z`);
  let end = null;
  for (let h = -3; h <= 3; h++) {
    const t = nextBase + h * 3600000;
    if (amsterdamYmd(t) === nextYmd && amsterdamHour(t) === 0) {
      end = t;
      break;
    }
  }
  if (end === null) end = nextBase - 3600000;
  return { startMs: start, endMs: end };
}

/** Verschil in hele minuten (b - a). */
export function minutesBetween(a, b) {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60000);
}
