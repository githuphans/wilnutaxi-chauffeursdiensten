/**
 * Vluchtvolger: pure logica (geen netwerk), zodat het goed te testen is.
 *
 * 1. `classify`     -- wat is de stand van de vlucht (vertrokken, geland, ...)
 * 2. `detectEvents` -- welke meldingen horen bij de verandering sinds de
 *                      vorige keer (elke soort melding maar één keer, behalve
 *                      een nieuwe verwachte tijd bij een flinke verschuiving)
 * 3. `nextCheckAt`  -- wanneer kijken we weer (zuinig met het abonnement:
 *                      veel vaker vlak voor vertrek en landing dan 's nachts)
 */
import { hhmm, minutesBetween, amsterdamHour } from "../time.js";

const MIN = 60000;
const HOUR = 60 * MIN;

export const DEFAULTS = {
  etaDrempelMin: 10, // nieuwe aankomsttijd melden vanaf 10 min verschil met de vorige melding
  vertragingDrempelMin: 15, // vertraagd vertrek melden vanaf 15 min na gepland
  stilVan: 0, // tussen 00:00 en 06:00 niet kijken, tenzij de vlucht dan zelf vliegt
  stilTot: 6,
};

const STATUS_NL = {
  Unknown: "onbekend",
  Expected: "volgens schema",
  CheckIn: "inchecken",
  Boarding: "instappen",
  GateClosed: "gate gesloten",
  Departed: "vertrokken",
  EnRoute: "in de lucht",
  Approaching: "in de landing",
  Arrived: "geland",
  Delayed: "vertraagd",
  Canceled: "geannuleerd",
  CanceledUncertain: "mogelijk geannuleerd",
  Diverted: "omgeleid",
};
export const statusNl = (s) => STATUS_NL[s] ?? String(s ?? "onbekend").toLowerCase();

export function classify(leg, nowMs = Date.now()) {
  const s = leg?.status ?? "Unknown";
  const canceled = s === "Canceled" || s === "CanceledUncertain";
  const diverted = s === "Diverted";
  // Controle op de klok: een "werkelijke" tijd of status die in de toekomst
  // ligt kan niet kloppen en telt niet mee (marge 15 minuten).
  const notFuture = (iso) => Boolean(iso) && Date.parse(iso) <= nowMs + 15 * 60000;
  const arrBestRaw = leg?.arr?.actual ?? leg?.arr?.estimated ?? leg?.arr?.scheduled ?? null;
  const depBestRaw = leg?.dep?.actual ?? leg?.dep?.estimated ?? leg?.dep?.scheduled ?? null;
  const landed = notFuture(leg?.arr?.actual) || (s === "Arrived" && notFuture(arrBestRaw));
  const departed =
    landed || notFuture(leg?.dep?.actual) || (["Departed", "EnRoute", "Approaching"].includes(s) && notFuture(depBestRaw));
  return {
    canceled,
    diverted,
    landed,
    departed,
    depBest: leg?.dep?.actual ?? leg?.dep?.estimated ?? leg?.dep?.scheduled ?? null,
    arrBest: leg?.arr?.actual ?? leg?.arr?.estimated ?? leg?.arr?.scheduled ?? null,
  };
}

const delta = (sched, best) => (sched && best ? minutesBetween(sched, best) : 0);
const plusMin = (m) => (m > 0 ? ` (+${m} min)` : m < 0 ? ` (${m} min)` : "");

/** Bevestiging direct na aanmelden. */
export function confirmationText({ flight, leg, rol, dagLabel, rit, nowMs = Date.now() }) {
  const c = classify(leg, nowMs);
  const lines = [];
  lines.push(`✈️ ${flight}${leg.airline ? ` (${leg.airline})` : ""}: ${leg.from.city ?? leg.from.iata ?? "?"} → ${leg.to.city ?? leg.to.iata ?? "?"}, ${dagLabel}`);
  lines.push(`Gepland: vertrek ${hhmm(leg.dep.scheduled)}, aankomst ${hhmm(leg.arr.scheduled)}`);
  const dDep = delta(leg.dep.scheduled, c.depBest);
  const dArr = delta(leg.arr.scheduled, c.arrBest);
  if (Math.abs(dDep) >= 5 || Math.abs(dArr) >= 5) {
    lines.push(`Nu verwacht: vertrek ${hhmm(c.depBest)}${plusMin(dDep)}, aankomst ${hhmm(c.arrBest)}${plusMin(dArr)}`);
  }
  lines.push(`Status: ${statusNl(leg.status)}`);
  if (rit) lines.push(`Gekoppeld aan rit ${rit.referentie} om ${rit.tijd} (${rit.van ?? "?"} → ${rit.naar ?? "?"}).`);
  else lines.push("Geen taxiID-rit met dit vluchtnummer gevonden; ik volg de vlucht toch.");
  lines.push(
    rol === "vertrek"
      ? "Je krijgt bericht bij vertraging, annulering en vertrek."
      : "Je krijgt bericht bij vertraging, opstijgen, een nieuwe aankomsttijd en de landing."
  );
  if (c.canceled) lines.push("❌ Let op: deze vlucht staat nu al als geannuleerd.");
  return lines.join("\n");
}

/**
 * @param {object} notified  wat al gemeld is: { canceled, diverted, departed, landed, lastEta, lastDep }
 * @returns {{messages:string[], notified:object, done:boolean}}
 */
export function detectEvents({ flight, leg, rol, notified = {}, cfg = DEFAULTS, nowMs = Date.now() }) {
  const c = classify(leg, nowMs);
  const n = { ...notified };
  const msgs = [];
  const fromCity = leg.from.city ?? leg.from.iata ?? "";
  const toCity = leg.to.city ?? leg.to.iata ?? "";

  if (c.canceled && !n.canceled) {
    msgs.push(`❌ ${flight} is GEANNULEERD volgens de vluchtgegevens${leg.status === "CanceledUncertain" ? " (nog niet zeker)" : ""}. Overleg met de centrale.`);
    n.canceled = true;
    return { messages: msgs, notified: n, done: leg.status === "Canceled" };
  }
  if (c.diverted && !n.diverted) {
    msgs.push(`⚠️ ${flight} is omgeleid en landt niet in ${toCity} zoals gepland. Overleg met de centrale.`);
    n.diverted = true;
  }

  // Vertraagd vertrek (alleen zolang nog niet vertrokken).
  if (!c.departed && leg.dep.scheduled && c.depBest) {
    const d = delta(leg.dep.scheduled, c.depBest);
    const prev = n.lastDep ? minutesBetween(n.lastDep, c.depBest) : null;
    if (d >= cfg.vertragingDrempelMin && (prev === null ? true : Math.abs(prev) >= cfg.etaDrempelMin)) {
      msgs.push(
        `⏳ ${flight} vertrekt later: verwacht ${hhmm(c.depBest)} in plaats van ${hhmm(leg.dep.scheduled)}${plusMin(d)}.` +
          (rol === "aankomst" && c.arrBest ? ` Verwachte aankomst ${hhmm(c.arrBest)}.` : "")
      );
      n.lastDep = c.depBest;
      if (c.arrBest) n.lastEta = c.arrBest;
    }
  }

  if (c.departed && !n.departed) {
    const tijd = leg.dep.actual ?? c.depBest;
    msgs.push(
      `🛫 ${flight} is opgestegen${tijd ? ` om ${hhmm(tijd)}` : ""}${fromCity ? ` uit ${fromCity}` : ""}.` +
        (rol === "aankomst" && c.arrBest && !c.landed ? ` Verwachte aankomst in ${toCity}: ${hhmm(c.arrBest)}${plusMin(delta(leg.arr.scheduled, c.arrBest))}.` : "")
    );
    n.departed = true;
    if (c.arrBest) n.lastEta = c.arrBest;
    if (rol === "vertrek") return { messages: msgs, notified: n, done: true };
  }

  // Nieuwe verwachte aankomst (alleen bij ophalen en zolang niet geland).
  if (rol === "aankomst" && !c.landed && c.arrBest) {
    const ref = n.lastEta ?? leg.arr.scheduled;
    if (ref && Math.abs(minutesBetween(ref, c.arrBest)) >= cfg.etaDrempelMin) {
      msgs.push(`🕒 ${flight}: nieuwe verwachte aankomst ${hhmm(c.arrBest)} (was ${hhmm(ref)}; gepland ${hhmm(leg.arr.scheduled)}).`);
      n.lastEta = c.arrBest;
    } else if (!n.lastEta) {
      n.lastEta = c.arrBest;
    }
  }

  if (c.landed && !n.landed) {
    const tijd = leg.arr.actual ?? c.arrBest;
    const extra = [leg.arr.terminal && `terminal ${leg.arr.terminal}`, leg.arr.gate && `gate ${leg.arr.gate}`, leg.arr.belt && `bagageband ${leg.arr.belt}`]
      .filter(Boolean)
      .join(", ");
    msgs.push(`🛬 ${flight} is geland${tijd ? ` om ${hhmm(tijd)}` : ""}${toCity ? ` in ${toCity}` : ""}.${extra ? ` ${extra[0].toUpperCase()}${extra.slice(1)}.` : ""}`);
    n.landed = true;
  }

  return { messages: msgs, notified: n, done: (rol === "aankomst" && c.landed) || (rol === "vertrek" && c.departed) || (c.canceled && leg.status === "Canceled") };
}

/**
 * Volgende controle (UTC-ms) of null als we klaar zijn.
 * Ruwe schatting per vlucht van 2 uur, 's avonds aangemeld: ~12-15 aanroepen.
 */
export function nextCheckAt({ leg, nowMs, cfg = DEFAULTS }) {
  const c = classify(leg, nowMs);
  const sched = leg?.arr?.scheduled ? Date.parse(leg.arr.scheduled) : null;
  if (sched && nowMs > sched + 8 * HOUR) return null; // te lang geleden: opgeven

  const dep = c.depBest ? Date.parse(c.depBest) : null;
  const arr = c.arrBest ? Date.parse(c.arrBest) : null;
  if (!dep && !arr) return nowMs + HOUR;

  let next;
  if (!c.departed) {
    if (dep && nowMs < dep - 2 * HOUR) {
      next = Math.min(nowMs + 3 * HOUR, dep - 2 * HOUR);
    } else {
      next = nowMs + 30 * MIN;
      if (dep && nowMs > dep + 30 * MIN) next = nowMs + 20 * MIN; // had al weg moeten zijn
    }
  } else if (arr && nowMs < arr - HOUR) {
    next = Math.min(nowMs + 45 * MIN, arr - HOUR);
  } else {
    next = nowMs + 10 * MIN;
  }
  next = Math.max(next, nowMs + 10 * MIN);

  // Nachtrust: niet tussen stilVan en stilTot, behalve als de vlucht dan zelf in beweging is.
  const h = amsterdamHour(next);
  if (h >= cfg.stilVan && h < cfg.stilTot) {
    const wake = next + ((cfg.stilTot - h) * HOUR - (next % HOUR));
    const limit = c.departed ? arr - HOUR : dep - 2 * HOUR;
    if (Number.isFinite(limit) && wake <= limit) next = wake;
    else if (Number.isFinite(limit) && limit > next) next = limit;
  }
  return next;
}
