/**
 * Rooster uit Google Agenda (via het geheime iCal-adres van de agenda).
 *
 * Een dienst in de agenda ziet er bijvoorbeeld zo uit (14-10-2026):
 *   titel:    HAN
 *   tijd:     04:00 - 11:00, herhalend per week
 *   locatie/ruimte: "(Standaard auto)-Taxi garage-G-GHN-49-K BYD Atto 3 (1)"
 *
 * Een afspraak telt als dienst als de TITEL het zoekwoord van een chauffeur
 * bevat (bv. "HAN", als los woord) en ergens in titel, locatie, beschrijving
 * of deelnemers een van onze eigen kentekens staat. Herhalingen,
 * uitzonderingen (EXDATE) en losse wijzigingen van één keer worden verwerkt.
 *
 * Het rooster gaat voor: voor de plandag krijgen de voertuig-id's van die
 * chauffeur het kenteken uit het rooster. Wijkt de chauffeursapp af, dan
 * meldt het scherm dat.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ical from "node-ical";
import { amsterdamYmd, dayBoundsMs } from "./time.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/rooster.json", import.meta.url));
const norm = (k) => String(k ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();

export function loadRoosterConfig(path = CONFIG_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return (raw.chauffeurs ?? []).filter((c) => c?.zoekwoord && Array.isArray(c.voertuigIds));
  } catch {
    return [];
  }
}

function textsOf(ev) {
  const out = [ev.summary, ev.location, ev.description];
  const att = ev.attendee ? (Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee]) : [];
  for (const a of att) {
    if (typeof a === "string") out.push(a);
    else if (a) out.push(a.params?.CN, a.val);
  }
  return out
    .map((t) => (typeof t === "string" ? t : t?.val ?? ""))
    .filter(Boolean);
}

function matchEvent(ev, chauffeurs, eigenKentekens) {
  const summary = typeof ev.summary === "string" ? ev.summary : ev.summary?.val ?? "";
  const chauffeur = chauffeurs.find((c) => new RegExp(`(^|[^A-Za-zÀ-ÿ])${c.zoekwoord}([^A-Za-zÀ-ÿ]|$)`, "i").test(summary));
  if (!chauffeur) return null;
  const blob = norm(textsOf(ev).join(" "));
  const kenteken = eigenKentekens.find((k) => blob.includes(norm(k)));
  return kenteken ? { naam: chauffeur.naam ?? chauffeur.zoekwoord, kenteken, voertuigIds: chauffeur.voertuigIds } : null;
}

/** Alle diensten (chauffeur + kenteken) die op Nederlandse dag `ymd` beginnen. */
export function roosterVoorDag(icsText, { ymd, chauffeurs, eigenKentekens }) {
  const data = ical.sync.parseICS(icsText);
  const { startMs, endMs } = dayBoundsMs(ymd);
  const found = new Map(); // naam -> dienst (dezelfde dienst in twee agenda's telt één keer)
  const add = (ev, dagVanStart) => {
    if (dagVanStart !== ymd) return;
    const m = matchEvent(ev, chauffeurs, eigenKentekens);
    if (m && !found.has(m.naam)) found.set(m.naam, m);
  };

  // Eenmalige wijzigingen eerst, zodat die voorgaan op een kopie van de vaste dienst.
  const events = Object.values(data).filter((ev) => ev?.type === "VEVENT" && ev.status !== "CANCELLED");
  for (const ev of events) {
    for (const o of Object.values(ev.recurrences ?? {})) {
      if (o.status !== "CANCELLED") add({ ...ev, ...o }, amsterdamYmd(o.start));
    }
  }
  for (const ev of events) {
    if (!ev.rrule) {
      add(ev, amsterdamYmd(ev.start));
      continue;
    }
    // node-ical/rrule geeft herhalingen als "kloktijd in UTC-velden" (04:00 lokaal
    // -> 04:00Z). De datum daarvan is dus de lokale datum; uitzonderingen en
    // wijzigingen staan in node-ical ook op lokale datum (JJJJ-MM-DD).
    const exdates = new Set(Object.keys(ev.exdate ?? {}).map((k) => k.slice(0, 10)));
    const gewijzigd = new Set(Object.keys(ev.recurrences ?? {}).map((k) => k.slice(0, 10)));
    const occ = ev.rrule.between(new Date(startMs - 36 * 3600000), new Date(endMs + 36 * 3600000), true);
    for (const o of occ) {
      const lokaleDag = o.toISOString().slice(0, 10);
      if (exdates.has(lokaleDag) || gewijzigd.has(lokaleDag)) continue;
      add(ev, lokaleDag);
    }
  }
  return [...found.values()];
}

/**
 * Haalt het iCal-bestand op (15 minuten gecachet; bij een storing de laatste
 * goede versie). Zonder ROOSTER_ICS_URL doet dit niets.
 */
export function createRoosterBron({ url = process.env.ROOSTER_ICS_URL, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console } = {}) {
  let cache = null; // { at, text }
  async function getText() {
    if (!url) return null;
    if (cache && now() - cache.at < 15 * 60000) return cache.text;
    try {
      const res = await fetchImpl(url, { headers: { accept: "text/calendar" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes("BEGIN:VCALENDAR")) throw new Error("geen agenda-bestand");
      cache = { at: now(), text };
      return text;
    } catch (err) {
      log.warn?.(`Rooster ophalen mislukt (${err.message}); ${cache ? "vorige versie gebruikt" : "zonder rooster verder"}.`);
      return cache?.text ?? null;
    }
  }
  return {
    actief: Boolean(url),
    async voorDag(ymd, chauffeurs, eigenKentekens) {
      const text = await getText();
      if (!text || !chauffeurs.length) return [];
      try {
        return roosterVoorDag(text, { ymd, chauffeurs, eigenKentekens });
      } catch (err) {
        log.warn?.(`Rooster lezen mislukt: ${err.message}`);
        return [];
      }
    },
  };
}

/**
 * Zet het roosterkenteken op de voertuig-id's van de chauffeur.
 * @returns {{ vehicles: object, afwijkingen: {naam, rooster, app, voertuigIds}[] }}
 */
export function pasRoosterToe(vehicles, diensten) {
  const out = { ...vehicles };
  const naamPerKenteken = new Map(Object.values(vehicles).filter((v) => v?.kenteken && v.naam).map((v) => [norm(v.kenteken), v.naam]));
  const afwijkingen = [];
  for (const d of diensten) {
    const appKentekens = new Set();
    for (const id of d.voertuigIds) {
      const app = out[id]?.kenteken;
      if (app && norm(app) !== norm(d.kenteken)) appKentekens.add(app);
      out[id] = { kenteken: d.kenteken, naam: naamPerKenteken.get(norm(d.kenteken)) ?? out[id]?.naam ?? null, bron: "rooster" };
    }
    for (const app of appKentekens) afwijkingen.push({ naam: d.naam, rooster: d.kenteken, app, voertuigIds: d.voertuigIds });
  }
  return { vehicles: out, afwijkingen };
}

export { amsterdamYmd };
