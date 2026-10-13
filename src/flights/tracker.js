/**
 * Vluchtvolger: aanmeldingen, zuinig pollen en meldingen versturen.
 * Los van Telegram: berichten gaan via `send(chatId, tekst)`.
 *
 * Meerdere chauffeurs op dezelfde vlucht delen één controle (één aanroep).
 * Er geldt een dagbudget in AeroDataBox-units (FLIGHT_DAILY_UNITS), zodat
 * het abonnement nooit onverwacht op raakt.
 */
import { extractFlightNumber, extractDate, normalizeFlightNumber } from "./flightNumber.js";
import { chooseLeg } from "./aerodatabox.js";
import { classify, confirmationText, detectEvents, nextCheckAt, statusNl, DEFAULTS } from "./logic.js";
import { amsterdamYmd, amsterdamHour, addDays, dayLabel, hhmm } from "../time.js";
import { isCanceled, safeRide } from "../taxiid.js";

const MIN = 60000;
const HOUR = 60 * MIN;

export function createTracker({
  store,
  api, // { getFlight(flight, date) }
  taxiId, // { getUpcomingRides() } -- optioneel
  send, // async (chatId, text) => void
  env = process.env,
  log = console,
  cfg = DEFAULTS,
}) {
  const homeAirports = (env.THUIS_LUCHTHAVENS || "EIN,AMS,RTM,BRU,CRL,DUS,NRN,CGN,MST,LGG")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const dailyUnits = Number(env.FLIGHT_DAILY_UNITS) || 300;
  const unitsPerCall = Number(env.AERODATABOX_UNITS_PER_CALL) || 2;
  const maxPerChat = 6;
  let running = false;

  const S = () => store.state;
  const fkey = (flight, date) => `${flight}|${date}`;

  function takeBudget(nowMs) {
    const day = amsterdamYmd(nowMs);
    const u = S().usage;
    if (u.day !== day) {
      u.day = day;
      u.units = 0;
      u.calls = 0;
    }
    if (u.units + unitsPerCall > dailyUnits) return false;
    u.units += unitsPerCall;
    u.calls = (u.calls ?? 0) + 1;
    store.save();
    return true;
  }

  async function callApi(flight, date, nowMs) {
    if (!takeBudget(nowMs)) return { kind: "error", reason: "dagbudget", budget: true };
    return api.getFlight(flight, date);
  }

  /** Zoek een taxiID-rit met dit vluchtnummer (eventueel op een bepaalde dag). */
  async function findRide(flight, date, nowMs) {
    if (!taxiId) return null;
    try {
      const { rides } = await taxiId.getUpcomingRides();
      const matches = rides
        .filter((r) => !isCanceled(r) && normalizeFlightNumber(r.flightNumber ?? "") === flight)
        .map(safeRide)
        .filter((r) => {
          const t = Date.parse(r.requestedDate);
          if (!Number.isFinite(t) || t < nowMs - 2 * HOUR) return false;
          return date ? amsterdamYmd(t) === date : t < nowMs + 48 * HOUR;
        })
        // Ophaalritten vanaf een luchthaven eerst; daarbinnen de vroegste.
        .sort((a, b) => Number(b.fromAirport) - Number(a.fromAirport) || Date.parse(a.requestedDate) - Date.parse(b.requestedDate));
      const r = matches[0];
      return r ? { referentie: r.reference, tijd: hhmm(r.requestedDate), iso: r.requestedDate, van: r.from, naar: r.to, vanafLuchthaven: r.fromAirport } : null;
    } catch (err) {
      log.warn?.(`Rit zoeken in taxiID mislukt: ${err.message}`);
      return null;
    }
  }

  function subsFor(key) {
    return S().subscriptions.filter((s) => s.key === key);
  }

  async function subscribe({ chatId, text, nowMs = Date.now() }) {
    const flight = extractFlightNumber(text);
    if (!flight) {
      return "Ik zie geen vluchtnummer. Stuur bijvoorbeeld: KL1234, of KL1234 morgen, of FR1718 13-10.";
    }
    const today = amsterdamYmd(nowMs);
    let date = extractDate(text, today);
    const rit = await findRide(flight, date, nowMs);
    // Alleen ritten die op een luchthaven beginnen (ophalen na de landing).
    if (rit && !rit.vanafLuchthaven) {
      return `Rit ${rit.referentie} om ${rit.tijd} met vlucht ${flight} begint niet op een luchthaven. Vluchtupdates zijn alleen voor ophaalritten vanaf het vliegveld.`;
    }
    if (!date) date = rit ? amsterdamYmd(rit.iso) : addDays(today, 1);
    if (date < addDays(today, -1)) return `De datum ${date} ligt in het verleden.`;
    if (date > addDays(today, 3)) return "Je kunt je tot drie dagen vooruit aanmelden. Meld je later opnieuw aan.";

    const mine = S().subscriptions.filter((s) => s.chatId === chatId);
    let key = fkey(flight, date);
    if (mine.some((s) => s.key === key)) return `Je volgt ${flight} op ${dayLabel(date)} al. Stuur /mijn voor de stand.`;
    if (mine.length >= maxPerChat) return `Je volgt al ${maxPerChat} vluchten. Stop er eerst een met /stop.`;

    let fs = S().flights[key];
    if (!fs || !fs.leg || nowMs - (fs.lastCheck ?? 0) > 30 * MIN) {
      let res = await callApi(flight, date, nowMs);
      // Rit net na middernacht: de vlucht kan de dag ervoor geland zijn.
      if (res.kind === "empty" && rit && amsterdamYmd(rit.iso) === date && amsterdamHour(rit.iso) < 6) {
        const prev = addDays(date, -1);
        const res2 = await callApi(flight, prev, nowMs);
        if (res2.kind === "found") {
          res = res2;
          date = prev;
          key = fkey(flight, date);
          fs = S().flights[key];
        }
      }
      if (res.kind === "error") {
        return res.budget
          ? "Het vluchtbudget voor vandaag is op. Probeer het morgen opnieuw of meld het bij de centrale."
          : `Vluchtgegevens zijn nu niet bereikbaar (${res.reason}). Probeer het over een paar minuten opnieuw.`;
      }
      if (res.kind === "empty") {
        return `Ik vind vlucht ${flight} niet op ${dayLabel(date)}. Klopt het nummer en de datum? Stuur bijvoorbeeld: ${flight} 13-10.`;
      }
      const chosen = chooseLeg(res.legs, homeAirports, { date });
      if (!chosen) {
        return `Ik vind vlucht ${flight} niet op ${dayLabel(date)}. Klopt het nummer en de datum? Stuur bijvoorbeeld: ${flight} 13-10.`;
      }
      if (chosen.rol !== "aankomst") {
        return `Vlucht ${flight} op ${dayLabel(date)} landt niet op een luchthaven waar wij ophalen (${chosen.leg.from.iata ?? "?"} → ${chosen.leg.to.iata ?? "?"}). Vluchtupdates zijn alleen voor ophaalritten na de landing.`;
      }
      const c = classify(chosen.leg, nowMs);
      fs = {
        flight,
        date,
        rol: chosen.rol,
        leg: chosen.leg,
        refArr: chosen.leg.arr.scheduled ?? null,
        lastCheck: nowMs,
        notified: {
          ...(fs?.notified ?? {}),
          departed: c.departed || undefined,
          landed: c.landed || undefined,
          canceled: c.canceled || undefined,
          lastEta: c.arrBest ?? undefined,
          lastDep: !c.departed && c.depBest !== chosen.leg.dep.scheduled ? c.depBest : undefined,
        },
        done: false,
      };
      S().flights[key] = fs;
    }

    const c = classify(fs.leg, nowMs);
    if ((fs.rol === "aankomst" && c.landed) || (fs.rol === "vertrek" && c.departed)) {
      store.save();
      return `${flight} is al ${c.landed ? `geland om ${hhmm(fs.leg.arr.actual ?? c.arrBest)}` : `vertrokken om ${hhmm(c.depBest)}`}. Ik volg hem niet meer.`;
    }
    fs.done = false;
    fs.nextCheck = nextCheckAt({ leg: fs.leg, nowMs, cfg }) ?? nowMs + HOUR;
    S().subscriptions.push({ chatId, key, createdAt: new Date(nowMs).toISOString(), rit: rit ?? null });
    store.save();
    return confirmationText({ flight, leg: fs.leg, rol: fs.rol, dagLabel: dayLabel(date), rit, nowMs });
  }

  function unsubscribe({ chatId, text }) {
    const flight = extractFlightNumber(text ?? "");
    const before = S().subscriptions.length;
    S().subscriptions = S().subscriptions.filter((s) => !(s.chatId === chatId && (!flight || s.key.startsWith(`${flight}|`))));
    const removed = before - S().subscriptions.length;
    store.save();
    if (!removed) return flight ? `Je volgde ${flight} niet.` : "Je volgde geen vluchten.";
    return flight ? `Gestopt met ${flight}.` : `Gestopt met alle ${removed} vlucht(en).`;
  }

  function list({ chatId }) {
    const mine = S().subscriptions.filter((s) => s.chatId === chatId);
    if (!mine.length) return "Je volgt nu geen vluchten. Stuur een vluchtnummer om te beginnen.";
    return mine
      .map((s) => {
        const fs = S().flights[s.key];
        if (!fs?.leg) return `• ${s.key.replace("|", " op ")}: nog geen gegevens`;
        const c = classify(fs.leg);
        const tijd = fs.rol === "aankomst" ? `aankomst ${hhmm(c.arrBest)} (gepland ${hhmm(fs.leg.arr.scheduled)})` : `vertrek ${hhmm(c.depBest)} (gepland ${hhmm(fs.leg.dep.scheduled)})`;
        const rit = s.rit ? `, rit ${s.rit.referentie} om ${s.rit.tijd}` : "";
        const bijgewerkt = fs.lastCheck ? `, bijgewerkt ${hhmm(fs.lastCheck)}` : "";
        return `• ${fs.flight} ${dayLabel(fs.date)}: ${statusNl(fs.leg.status)}, ${tijd}${rit}${bijgewerkt}`;
      })
      .join("\n");
  }

  async function broadcast(key, text) {
    for (const s of subsFor(key)) {
      try {
        await send(s.chatId, text);
      } catch (err) {
        log.warn?.(`Bericht versturen mislukt: ${err.message}`);
      }
    }
  }

  /** Eén ronde: alle vluchten die aan de beurt zijn controleren. */
  async function tick(nowMs = Date.now()) {
    if (running) return;
    running = true;
    try {
      for (const [key, fs] of Object.entries(S().flights)) {
        const subs = subsFor(key);
        if (subs.length && isImplausible(fs, nowMs)) {
          log.warn?.(`Herstel ${fs.flight} ${fs.date}: eerdere melding hoorde bij een andere dag of lag in de toekomst.`);
          await broadcast(
            key,
            `⚠️ Correctie: de eerdere melding over ${fs.flight} (opgestegen/geland) was onjuist; die gegevens hoorden bij een andere vlucht of dag. Ik volg ${fs.flight} van ${dayLabel(fs.date)} gewoon verder.`
          );
          fs.done = false;
          fs.doneAt = undefined;
          fs.notified = {};
          fs.refArr = null;
          fs.nextCheck = nowMs;
          store.save();
        }
        if (fs.done || !subs.length || !fs.nextCheck || fs.nextCheck > nowMs) continue;
        const res = await callApi(fs.flight, fs.date, nowMs);
        if (res.kind !== "found") {
          if (res.budget) log.warn?.("Dagbudget AeroDataBox bereikt; controles wachten.");
          else log.warn?.(`Controle ${fs.flight} mislukt: ${res.reason ?? "niet gevonden"}`);
          fs.nextCheck = nowMs + (res.budget ? HOUR : 15 * MIN);
          store.save();
          continue;
        }
        const chosen = chooseLeg(res.legs, homeAirports, { date: fs.date, refArr: fs.refArr ?? null });
        if (!chosen) {
          log.warn?.(`Controle ${fs.flight} ${fs.date}: geen vluchtdeel van deze dag in het antwoord (${res.legs.length} deel/delen); overgeslagen.`);
          fs.nextCheck = nowMs + 15 * MIN;
          store.save();
          continue;
        }
        fs.leg = chosen.leg;
        fs.rol = chosen.rol;
        fs.refArr ??= chosen.leg.arr.scheduled ?? null;
        fs.lastCheck = nowMs;
        log.info?.(
          `Controle ${fs.flight} ${fs.date}: status ${fs.leg.status}, vertrek ${hhmm(fs.leg.dep.scheduled)}/${hhmm(fs.leg.dep.actual ?? fs.leg.dep.estimated)}, aankomst ${hhmm(fs.leg.arr.scheduled)}/${hhmm(fs.leg.arr.actual ?? fs.leg.arr.estimated)} (gepland/werkelijk of verwacht).`
        );
        const ev = detectEvents({ flight: fs.flight, leg: fs.leg, rol: fs.rol, notified: fs.notified, cfg, nowMs });
        fs.notified = ev.notified;
        for (const m of ev.messages) await broadcast(key, m);
        const next = ev.done ? null : nextCheckAt({ leg: fs.leg, nowMs, cfg });
        if (next === null) {
          if (!ev.done) await broadcast(key, `Ik stop met het volgen van ${fs.flight}: geen landing gezien binnen 8 uur na de geplande aankomst.`);
          fs.done = true;
          fs.doneAt = nowMs;
        } else {
          fs.nextCheck = next;
        }
        store.save();
      }
      cleanup(nowMs);
    } finally {
      running = false;
    }
  }

  /** Is een eerder gemelde start/landing onmogelijk (andere dag, of in de toekomst)? */
  function isImplausible(fs, nowMs) {
    if (!fs.leg || !(fs.notified?.landed || fs.notified?.departed)) return false;
    const otherDay = amsterdamYmd(fs.leg.arr.scheduled ?? fs.leg.dep.scheduled ?? nowMs) !== fs.date && amsterdamYmd(fs.leg.dep.scheduled ?? nowMs) !== fs.date;
    const c = classify(fs.leg, nowMs);
    return otherDay || (fs.notified.landed && !c.landed) || (fs.notified.departed && !c.departed);
  }

  function cleanup(nowMs) {
    const st = S();
    const before = st.subscriptions.length + Object.keys(st.flights).length;
    st.subscriptions = st.subscriptions.filter((s) => {
      const fs = st.flights[s.key];
      return fs && !(fs.done && nowMs - (fs.doneAt ?? 0) > 6 * HOUR);
    });
    const used = new Set(st.subscriptions.map((s) => s.key));
    for (const [key, fs] of Object.entries(st.flights)) {
      if (!used.has(key) && nowMs - (fs.lastCheck ?? 0) > 2 * HOUR) delete st.flights[key];
    }
    if (st.subscriptions.length + Object.keys(st.flights).length !== before) store.save();
  }

  function usage(nowMs = Date.now()) {
    const u = S().usage;
    const today = u.day === amsterdamYmd(nowMs);
    return { units: today ? u.units : 0, calls: today ? u.calls ?? 0 : 0, budget: dailyUnits };
  }

  return { subscribe, unsubscribe, list, tick, usage };
}
