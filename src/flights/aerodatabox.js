/**
 * AeroDataBox (via RapidAPI of API.market) -- vluchtstatus op vluchtnummer
 * en datum. Eén aanroep kost volgens het abonnement 2 "units" (soms meer);
 * dat getal staat in AERODATABOX_UNITS_PER_CALL zodat het dagbudget klopt.
 *
 * De sleutel staat alleen in de omgevingsvariabele AERODATABOX_API_KEY.
 * Standaard RapidAPI; voor API.market zet je AERODATABOX_PROVIDER=apimarket.
 */
const RAPIDAPI_HOST = "aerodatabox.p.rapidapi.com";
const APIMARKET_BASE = "https://prod.api.market/api/v1/aedbx/aerodatabox";

/** "2026-10-13 12:35Z" / "2026-10-13 14:35+02:00" -> ISO-UTC of null. */
export function toIsoUtc(value) {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const pickTime = (...vals) => {
  for (const v of vals) {
    const iso = toIsoUtc(v?.utc);
    if (iso) return iso;
  }
  return null;
};

/** Eén vluchtdeel uit AeroDataBox omzetten naar onze eigen, platte vorm. */
export function mapLeg(raw) {
  const dep = raw?.departure ?? {};
  const arr = raw?.arrival ?? {};
  return {
    number: raw?.number ?? null,
    airline: raw?.airline?.name ?? null,
    status: raw?.status ?? "Unknown",
    from: { iata: dep.airport?.iata ?? null, city: dep.airport?.municipalityName ?? dep.airport?.name ?? null },
    to: { iata: arr.airport?.iata ?? null, city: arr.airport?.municipalityName ?? arr.airport?.name ?? null },
    dep: {
      scheduled: pickTime(dep.scheduledTime),
      estimated: pickTime(dep.revisedTime, dep.predictedTime),
      actual: pickTime(dep.runwayTime),
    },
    arr: {
      scheduled: pickTime(arr.scheduledTime),
      estimated: pickTime(arr.revisedTime, arr.predictedTime),
      actual: pickTime(arr.runwayTime),
      terminal: arr.terminal ?? null,
      gate: arr.gate ?? null,
      belt: arr.baggageBelt ?? null,
    },
  };
}

/**
 * Kies het vluchtdeel dat voor ons telt: het deel dat aankomt op een
 * "thuisluchthaven" (ophalen), anders het deel dat daar vertrekt
 * (wegbrengen), anders het eerste.
 */
export function chooseLeg(legs, homeAirports, { date = null, refArr = null } = {}) {
  // Alleen vluchtdelen van de gevraagde dag. AeroDataBox kan bij een
  // vluchtnummer ook de vlucht van een andere dag meesturen (13-10-2026:
  // "opgestegen/geland" van de vlucht van gisteren). Bij een volgcontrole
  // moet de geplande aankomst bovendien binnen 6 uur van die bij aanmelden liggen.
  const ymd = (iso) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date(iso)) : null);
  let pool = legs;
  if (refArr) {
    const ref = Date.parse(refArr);
    pool = legs.filter((l) => l.arr.scheduled && Math.abs(Date.parse(l.arr.scheduled) - ref) <= 6 * 3600000);
  } else if (date) {
    pool = legs.filter((l) => ymd(l.arr.scheduled) === date || ymd(l.dep.scheduled) === date);
  }
  const home = new Set(homeAirports);
  const arriving = pool.find((l) => l.to.iata && home.has(l.to.iata));
  if (arriving) return { leg: arriving, rol: "aankomst" };
  const departing = pool.find((l) => l.from.iata && home.has(l.from.iata));
  if (departing) return { leg: departing, rol: "vertrek" };
  return pool.length ? { leg: pool[0], rol: "aankomst" } : null;
}

export function createAeroDataBox({
  apiKey = process.env.AERODATABOX_API_KEY,
  provider = (process.env.AERODATABOX_PROVIDER || "rapidapi").toLowerCase(),
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = 10000,
} = {}) {
  function request(flight, date) {
    const path = `/flights/number/${encodeURIComponent(flight)}/${date}?withAircraftImage=false&withLocation=false&withFlightPlan=false`;
    if (provider === "apimarket") {
      return { url: `${APIMARKET_BASE}${path}`, headers: { "x-magicapi-key": apiKey, accept: "application/json" } };
    }
    return { url: `https://${RAPIDAPI_HOST}${path}`, headers: { "x-rapidapi-key": apiKey, "x-rapidapi-host": RAPIDAPI_HOST, accept: "application/json" } };
  }

  /** @returns {Promise<{kind:"found",legs:object[]}|{kind:"empty"}|{kind:"error",reason:string}>} */
  async function getFlight(flight, date) {
    if (!apiKey) return { kind: "error", reason: "AERODATABOX_API_KEY ontbreekt" };
    const { url, headers } = request(flight, date);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 204 || res.status === 404) return { kind: "empty" };
      if (res.status === 429) return { kind: "error", reason: "quotum of limiet bereikt (HTTP 429)" };
      if (!res.ok) return { kind: "error", reason: `HTTP ${res.status}` };
      const body = await res.json().catch(() => null);
      const legs = (Array.isArray(body) ? body : []).map(mapLeg);
      return legs.length ? { kind: "found", legs } : { kind: "empty" };
    } catch (err) {
      return { kind: "error", reason: err?.name === "AbortError" ? "timeout" : "netwerkfout" };
    } finally {
      clearTimeout(timer);
    }
  }

  return { getFlight };
}
