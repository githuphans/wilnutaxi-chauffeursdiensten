/**
 * Garagevolgorde.
 *
 * De garage is één rij: de auto die er als LAATSTE in rijdt, staat vooraan
 * bij de deur en kan er als EERSTE uit. Dus:
 *   - auto's zonder rit op de plandag gaan er het eerst in (achteraan);
 *   - daarna de auto met de LAATSTE eerste rit, enzovoort;
 *   - de auto met de VROEGSTE eerste rit gaat er als laatste in (bij de deur).
 *
 * Plandag: na WISSELUUR (standaard 12:00) is dat morgen, daarvoor vandaag.
 * Zo klopt het scherm 's avonds (morgen) én na middernacht (de dag zelf).
 * Ritten die al begonnen zijn (tijd < nu) tellen niet mee.
 */
import { amsterdamYmd, amsterdamHour, addDays, dayBoundsMs, hhmm, dayLabel } from "./time.js";
import { isCanceled, safeRide } from "./taxiid.js";

export function planDay(nowMs, switchHour = 12) {
  const today = amsterdamYmd(nowMs);
  return amsterdamHour(nowMs) >= switchHour ? addDays(today, 1) : today;
}

/**
 * @param {object[]} rides  ruwe taxiID-ritten
 * @param {Record<string,{kenteken:string,naam?:string}>} vehicles  koppeltabel vehicleId -> kenteken
 * @param {{nowMs:number, day?:string, switchHour?:number}} opts
 */
export function computeGarageOrder(rides, vehicles, { nowMs, day, switchHour = 12 }) {
  const ymd = day ?? planDay(nowMs, switchHour);
  const { startMs, endMs } = dayBoundsMs(ymd);
  const fromMs = Math.max(startMs, nowMs);

  const dayRides = rides
    .filter((r) => !isCanceled(r))
    .map(safeRide)
    .filter((r) => {
      const t = Date.parse(r.requestedDate);
      return Number.isFinite(t) && t >= fromMs && t < endMs;
    })
    .sort((a, b) => Date.parse(a.requestedDate) - Date.parse(b.requestedDate));

  // Eén kaart per fysieke auto: taxiID kan voor dezelfde auto meerdere
  // voertuig-id's hebben (bv. per chauffeur). Id's met hetzelfde kenteken
  // worden samengevoegd; een id zonder kenteken telt als eigen auto.
  const carKey = (id) => {
    const k = vehicles[id]?.kenteken;
    return k ? `k:${k.replace(/[^A-Z0-9]/gi, "").toUpperCase()}` : `id:${id}`;
  };
  const perCar = new Map(); // key -> { ids: Set, rides: [] }
  const ensure = (id) => {
    const key = carKey(id);
    if (!perCar.has(key)) perCar.set(key, { ids: new Set(), rides: [] });
    perCar.get(key).ids.add(id);
    return perCar.get(key);
  };
  for (const id of Object.keys(vehicles)) ensure(id);
  const zonderAuto = [];
  for (const r of dayRides) {
    if (!r.vehicleId) {
      zonderAuto.push(r);
      continue;
    }
    ensure(r.vehicleId).rides.push(r);
  }

  const cars = [...perCar.values()].map(({ ids, rides: list }) => {
    list.sort((a, b) => Date.parse(a.requestedDate) - Date.parse(b.requestedDate));
    const vehicleId = [...ids][0];
    const info = vehicles[vehicleId];
    const first = list[0] ?? null;
    return {
      vehicleId,
      vehicleIds: [...ids],
      kenteken: info?.kenteken ?? null,
      naam: info?.naam ?? null,
      bekend: Boolean(info),
      aantalRitten: list.length,
      eersteRit: first
        ? {
            tijd: hhmm(first.requestedDate),
            iso: first.requestedDate,
            referentie: first.reference,
            van: first.from,
            naar: first.to,
            vlucht: first.flightNumber,
            chauffeur: first.hasDriver,
          }
        : null,
    };
  });

  // Inrijvolgorde: eerst zonder rit, dan laatste eerste rit ... vroegste eerste rit.
  cars.sort((a, b) => {
    if (!a.eersteRit && !b.eersteRit) return (a.kenteken ?? a.vehicleId).localeCompare(b.kenteken ?? b.vehicleId);
    if (!a.eersteRit) return -1;
    if (!b.eersteRit) return 1;
    const diff = Date.parse(b.eersteRit.iso) - Date.parse(a.eersteRit.iso);
    if (diff !== 0) return diff;
    return a.aantalRitten - b.aantalRitten; // gelijke tijd: de drukste auto bij de deur
  });

  const inrijvolgorde = cars.map((c, i) => ({
    ...c,
    inrijden: i + 1, // 1 = er als eerste in, staat achteraan
    positie: i === cars.length - 1 ? "bij de deur" : i === 0 ? "achteraan" : "midden",
  }));

  const waarschuwingen = [];
  if (zonderAuto.length) {
    waarschuwingen.push(
      `${zonderAuto.length} ${zonderAuto.length === 1 ? "rit heeft" : "ritten hebben"} nog geen auto (eerste om ${hhmm(zonderAuto[0].requestedDate)}). De volgorde kan nog veranderen.`
    );
  }
  for (const c of inrijvolgorde.filter((c) => !c.bekend)) {
    waarschuwingen.push(`Kenteken van voertuig-id ${c.vehicleId} niet gevonden in taxiID. Zet het in config/voertuigen.json.`);
  }

  return {
    dag: ymd,
    dagLabel: dayLabel(ymd),
    berekendOm: new Date(nowMs).toISOString(),
    inrijvolgorde,
    zonderAuto: zonderAuto.map((r) => ({ tijd: hhmm(r.requestedDate), referentie: r.reference, van: r.from, naar: r.to })),
    waarschuwingen,
  };
}
