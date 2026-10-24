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

  /**
   * Eén voertuig opzoeken: GET /vehicles/<id> geeft o.a. licensePlate, brand
   * en model (getest op 12-10-2026). Alleen kenteken en merk/model worden
   * bewaard, niet de chauffeur. Gevonden: 10 minuten in de cache, fout: 5 min.
   */
  const vehicleCache = new Map();
  // Kort cachen: een chauffeur kan in zijn app van auto wisselen.
  const vehicleCacheMs = (Number(process.env.VOERTUIG_CACHE_MINUTEN) || 10) * 60000;
  async function getVehicle(id) {
    const hit = vehicleCache.get(id);
    if (hit && hit.expiresAt > now()) return hit.value;
    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetchImpl(`${baseUrl}/vehicles/${encodeURIComponent(id)}`, {
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const v = await res.json();
        const kenteken = String(v?.formattedLicensePlate || v?.licensePlate || "").trim().toUpperCase() || null;
        const naam = [v?.brand, v?.model].filter((x) => typeof x === "string" && x.trim()).join(" ") || null;
        value = kenteken ? { kenteken, naam } : null;
      } else {
        log.warn?.(`Voertuig ${id} opzoeken in taxiID: HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn?.(`Voertuig ${id} opzoeken in taxiID mislukt: ${err.message}`);
    }
    vehicleCache.set(id, { value, expiresAt: now() + (value ? vehicleCacheMs : 5 * 60000) });
    return value;
  }

  /**
   * Actieve auto van een chauffeur: GET /drivers/<id> geeft `activeVehicleId`
   * (de auto die de chauffeur nu in zijn app gebruikt; zo toont het portaal
   * het ook). Alleen dat id wordt bewaard, verder niets van de chauffeur.
   * Getest op 20-10-2026. Cache zoals bij voertuigen.
   */
  const driverCache = new Map();
  async function getActiveVehicleId(driverId) {
    const hit = driverCache.get(driverId);
    if (hit && hit.expiresAt > now()) return hit.value;
    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetchImpl(`${baseUrl}/drivers/${encodeURIComponent(driverId)}`, {
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const d = await res.json();
        value = typeof d?.activeVehicleId === "string" && d.activeVehicleId ? d.activeVehicleId : null;
      } else {
        log.warn?.(`Chauffeur opzoeken in taxiID: HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn?.(`Chauffeur opzoeken in taxiID mislukt: ${err.message}`);
    }
    driverCache.set(driverId, { value, expiresAt: now() + (value ? vehicleCacheMs : 5 * 60000) });
    return value;
  }

  /**
   * Naam van een chauffeur (voor de belherinnering: koppelen aan Telegram en
   * het overzicht voor de centrale). Uit GET /drivers/<id> wordt ALLEEN de
   * naam bewaard; telefoonnummer, adres e.d. worden niet gebruikt.
   * Gevonden: 12 uur in de cache, fout: 10 minuten.
   */
  const driverNameCache = new Map();
  async function getDriver(driverId) {
    const hit = driverNameCache.get(driverId);
    if (hit && hit.expiresAt > now()) return hit.value;
    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetchImpl(`${baseUrl}/drivers/${encodeURIComponent(driverId)}`, {
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const body = await res.json();
        value = { id: driverId, naam: driverNaam(body), velden: veldnamen(body) };
      }
      else log.warn?.(`Chauffeur opzoeken in taxiID: HTTP ${res.status}`);
    } catch (err) {
      log.warn?.(`Chauffeur opzoeken in taxiID mislukt: ${err.message}`);
    }
    driverNameCache.set(driverId, { value, expiresAt: now() + (value ? 12 * 3600000 : 10 * 60000) });
    return value;
  }

  /**
   * Alle chauffeurs van het bedrijf (id + naam), voor de keuzelijst "wie ben
   * je?". Of taxiID deze lijst geeft is niet zeker; lukt het niet, dan
   * `null` en kiest de bot uit de chauffeurs die in de ritten staan.
   */
  let driverListCache = null;
  async function listDrivers() {
    if (driverListCache && driverListCache.expiresAt > now()) return driverListCache.value;
    let value = null;
    try {
      const filter = encodeURIComponent(JSON.stringify({ limit: 200 }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetchImpl(`${baseUrl}/companies/${companyId}/drivers?filter=${filter}`, {
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const body = await res.json();
        const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
        if (list) {
          value = list
            .filter((d) => d && d.active !== false && d.deleted !== true && d.archived !== true && !/inactie|inactiv|disabled|blocked|deleted|archived|removed|suspended/i.test(String(d.status ?? "")))
            .map((d) => ({ id: String(d.id ?? d._id ?? ""), naam: driverNaam(d) }))
            .filter((d) => d.id);
          for (const d of value) driverNameCache.set(d.id, { value: d, expiresAt: now() + 12 * 3600000 });
        }
      } else {
        log.warn?.(`Chauffeurslijst uit taxiID: HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn?.(`Chauffeurslijst uit taxiID mislukt: ${err.message}`);
    }
    driverListCache = { value, expiresAt: now() + (value ? 3600000 : 15 * 60000) };
    return value;
  }

  return { getUpcomingRides, fetchRidesBetween, getVehicle, getActiveVehicleId, getDriver, listDrivers };
}

/**
 * Naam uit een taxiID-chauffeur. De veldnamen zijn niet gedocumenteerd, dus
 * we zoeken laag voor laag (eerst het object zelf, dan geneste objecten zoals
 * `user`, `profile` of `person`) naar voornaam/achternaam of een hele naam.
 * Objecten over voertuig, bedrijf, bank of noodcontact worden overgeslagen.
 */
const VOOR = /^(first|given|voor)[_-]?(name|naam)$|^voornaam$|^fname$/i;
const ACHTER = /^(last|family|sur|achter)[_-]?(name|naam)$|^achternaam$|^lname$/i;
const HEEL = /^(full[_-]?name|display[_-]?name|name|naam|nick[_-]?name|roepnaam|call[_-]?name)$/i;
const OVERSLAAN = /vehicle|company|car$|^auto|bedrijf|bank|account|emergency|nood|iban|invoice|factuur/i;
export function driverNaam(d) {
  if (!d || typeof d !== "object") return null;
  const tekst = (v) => (typeof v === "string" && v.trim() && v.trim().length <= 60 ? v.trim() : null);
  let laag = [d];
  for (let diepte = 0; diepte < 3 && laag.length; diepte++) {
    let heel = null;
    const volgende = [];
    for (const o of laag) {
      let voor = null, achter = null;
      for (const [k, v] of Object.entries(o)) {
        if (VOOR.test(k)) voor ??= tekst(v);
        else if (ACHTER.test(k)) achter ??= tekst(v);
        else if (HEEL.test(k)) heel ??= tekst(v);
        else if (v && typeof v === "object" && !Array.isArray(v) && !OVERSLAAN.test(k)) volgende.push(v);
      }
      if (voor || achter) return [voor, achter].filter(Boolean).join(" ");
    }
    if (heel) return heel;
    laag = volgende;
  }
  return null;
}

/** Alleen de veldnamen (geen waarden), om te zien waar taxiID de naam zet. */
export function veldnamen(d, pad = "", diepte = 0, uit = []) {
  if (!d || typeof d !== "object" || Array.isArray(d) || diepte > 1) return uit;
  for (const [k, v] of Object.entries(d)) {
    const p = pad ? `${pad}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && diepte < 1) veldnamen(v, p, diepte + 1, uit);
    else uit.push(p);
  }
  return uit;
}

/** Chauffeur-id van een rit (taxiID geeft meestal `driverId`). */
export function driverIdOf(ride) {
  const d = ride?.driver;
  const v = ride?.driverId ?? (typeof d === "string" ? d : d?.id ?? d?._id);
  return typeof v === "string" && v ? v : null;
}

export function isCanceled(ride) {
  return String(ride?.status ?? "").toLowerCase().includes("cancel");
}

/**
 * Begint de rit op een luchthaven? taxiID geeft niet altijd een plaatsnaam,
 * dus we kijken in alle tekst van het vertrekpunt (naam, synoniem, adres):
 * "Eindhoven Airport", "Luchthavenweg 25", "Schiphol", "Flughafen Weeze", ...
 */
const AIRPORT_RE = /airport|luchthaven|schiphol|flughafen|a[ée]roport|aeropuerto|\b(EIN|AMS|RTM|BRU|CRL|DUS|NRN|CGN|MST|LGG)\b/i;
export function startsAtAirport(ride) {
  const dep = ride?.departure;
  if (!dep) return false;
  const texts = [];
  (function walk(v, depth) {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  })(dep, 0);
  return texts.some((t) => AIRPORT_RE.test(t));
}

/**
 * Plaatsnaam van een vertrek- of aankomstpunt. taxiID vult `city` niet
 * altijd; dan halen we de plaats uit een adresregel zoals
 * "Zilvermeeuwhof 10, Nuenen, Nederland" of "Torenallee 20, 5617 BC Eindhoven, Nederland".
 * Alleen de plaatsnaam komt in de uitvoer, nooit straat of huisnummer.
 */
const LAND = /^(nederland|netherlands|the netherlands|nl|belgi[eë]|belgium|belgique|deutschland|germany|duitsland|france|frankrijk)$/i;
const CITY_KEYS = ["city", "locality", "town", "place", "municipality", "plaats"];
export function cityOf(place) {
  if (!place || typeof place !== "object") return null;
  for (const k of CITY_KEYS) {
    const v = place[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const strings = [];
  (function walk(v, depth) {
    if (depth > 2 || v === null || v === undefined) return;
    if (typeof v === "string") strings.push(v);
    else if (typeof v === "object" && !Array.isArray(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
  })(place, 0);
  for (const text of strings) {
    const parts = text.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    while (parts.length > 1 && LAND.test(parts.at(-1))) parts.pop();
    if (parts.length < 2) continue;
    const candidate = parts.at(-1).replace(/^\d{4}\s?[A-Z]{2}\s+/, "").replace(/^\d{4,5}\s+/, "").trim();
    if (candidate && !/\d/.test(candidate) && candidate.length <= 40) return candidate;
  }
  // Geen adresregel: dan een korte naam zonder cijfers, bv. "Eindhoven Airport"
  // (zo staat de luchthaven soms alleen in `internationalAlias`).
  const naam = strings.map((t) => t.trim()).find((t) => t && t.length <= 40 && !/\d/.test(t) && !t.includes(","));
  return naam ?? null;
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
    from: cityOf(ride.departure),
    fromAirport: startsAtAirport(ride),
    to: cityOf(ride.destination),
  };
}
