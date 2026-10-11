/**
 * taxiID DispatchAPI (productie) -- ALLEEN LEZEN.
 *
 * - Authenticatie: header `Authorization: <sleutel>` (geen "Bearer").
 *   De sleutel komt uit de omgevingsvariabele TAXIID_PROD_API_KEY en staat
 *   nooit in code of in een log.
 * - Het datumfilter (`where` op `requestedDate`) wordt door taxiID niet
 *   toegepast; we sturen het wel mee (schaadt niet), maar filteren zelf.
 * - Pagineren met `limit` en `skip`.
 * - Antwoorden worden kort gecachet (standaard 5 minuten), zodat het
 *   garagescherm en de bot taxiID niet onnodig belasten.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

export function createTaxiIdClient({
  apiKey = process.env.TAXIID_PROD_API_KEY,
  baseUrl = (process.env.TAXIID_PROD_BASE_URL || "https://api.dispatchapi.io/api").replace(/\/$/, ""),
  companyId = process.env.TAXIID_COMPANY_ID || "5e76134226a257e34bd9bb17",
  cacheMs = (Number(process.env.TAXIID_CACHE_SECONDS) || 300) * 1000,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console,
} = {}) {
  let cache = null; // { at, rides }
  let inFlight = null;

  async function getPage(filter) {
    const url = `${baseUrl}/companies/${companyId}/rides?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`taxiID gaf HTTP ${res.status} bij het ophalen van ritten`);
      const body = await res.json();
      return Array.isArray(body) ? body : body?.data ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Alle ritten van `fromMs` t/m `toMs` (zelf gefilterd). */
  async function fetchRidesBetween(fromMs, toMs) {
    const all = [];
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const filter = {
        where: { requestedDate: { gte: new Date(fromMs).toISOString(), lte: new Date(toMs).toISOString() } },
        limit: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      };
      const list = await getPage(filter);
      let fresh = 0;
      for (const r of list) {
        const id = r.id ?? r._id ?? r.reference;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        all.push(r);
        fresh++;
      }
      if (list.length < PAGE_SIZE || fresh === 0) break;
    }
    return all.filter((r) => {
      const t = Date.parse(r.requestedDate);
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    });
  }

  /**
   * Ritten van gisteren t/m overmorgen (ruim genoeg voor garage en bot),
   * met cache. Bij een fout wordt de laatste goede lijst teruggegeven
   * (met `stale: true`), zodat het scherm niet leeg wordt bij een storing.
   */
  async function getUpcomingRides({ force = false } = {}) {
    if (!apiKey) throw new Error("TAXIID_PROD_API_KEY ontbreekt");
    if (!force && cache && now() - cache.at < cacheMs) return { rides: cache.rides, fetchedAt: cache.at, stale: false };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const t = now();
        const rides = await fetchRidesBetween(t - 24 * 3600000, t + 72 * 3600000);
        cache = { at: now(), rides };
        return { rides, fetchedAt: cache.at, stale: false };
      } catch (err) {
        log.warn?.(`taxiID ophalen mislukt: ${err.message}`);
        if (cache) return { rides: cache.rides, fetchedAt: cache.at, stale: true, error: err.message };
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { getUpcomingRides, fetchRidesBetween };
}

export function isCanceled(ride) {
  return String(ride?.status ?? "").toLowerCase().includes("cancel");
}

/** Alleen de velden die we nodig hebben -- geen namen, telefoonnummers of adressen. */
export function safeRide(ride) {
  return {
    reference: ride.reference ?? null,
    requestedDate: ride.requestedDate ?? null,
    status: ride.status ?? null,
    vehicleType: ride.vehicleType ?? null,
    vehicleId: ride.vehicleId ?? null,
    hasDriver: Boolean(ride.driverId || ride.driver),
    flightNumber: ride.flightNumber ?? null,
    from: ride.departure?.city ?? null,
    to: ride.destination?.city ?? null,
  };
}
