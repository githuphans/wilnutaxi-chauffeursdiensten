/**
 * Belherinnering ("belronde"): elke middag krijgt iedere chauffeur met ritten
 * voor morgen een Telegram-bericht om zijn passagiers te bellen, met een knop
 * "Gebeld ✅". Alles op basis van de planning in taxiID; niemand hoeft iets
 * in te stellen.
 *
 *   17:00  eerste bericht per chauffeur (BEL_HERINNERING_TIJD)
 *   elke 30 min tot 21:30: nieuwe, verplaatste of vervallen ritten -> extra bericht
 *   19:30  herinnering voor wie nog niet op "Gebeld" heeft getikt (BEL_NOGMAALS_TIJD)
 *   20:00  overzicht voor de beheerders (BEL_OVERZICHT_TIJD)
 *   na 21:30 niets meer (BEL_LAATST_TIJD), zodat niemand 's avonds laat belt
 *
 * Koppeling: een Telegram-chat weet niet welke taxiID-chauffeur het is. Na de
 * toegangscode kiest de chauffeur één keer zijn naam ("wie ben je?"); dat
 * kan later opnieuw met /ikben. De beheerders krijgen daar een bericht van.
 *
 * Privacy (zoals de rest van de app): in berichten en opslag alleen
 * ritreferentie, tijd, plaatsnaam en vluchtnummer, plus de naam van de
 * chauffeur. Namen en telefoonnummers van passagiers staan in de taxiID-app
 * van de chauffeur en komen hier nooit langs.
 */
import { amsterdamYmd, addDays, dayBoundsMs, dayLabel, hhmm } from "./time.js";
import { isCanceled, safeRide, driverIdOf } from "./taxiid.js";

const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTijd(waarde, standaard) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(waarde ?? "").trim()) ?? /^(\d{1,2})[:.](\d{2})$/.exec(standaard);
  return Number(m[1]) * 60 + Number(m[2]);
}
const tijdTekst = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const minuutVanDag = (t) => {
  const [h, m] = hhmm(t).split(":").map(Number);
  return h * 60 + m;
};
const ritten = (n) => (n === 1 ? "1 rit" : `${n} ritten`);

/** Ritten van één dag per chauffeur (zonder geannuleerde), gesorteerd op tijd. */
export function rittenPerChauffeur(rides, ymd) {
  const { startMs, endMs } = dayBoundsMs(ymd);
  const per = new Map();
  const zonder = [];
  for (const r of rides ?? []) {
    const t = Date.parse(r?.requestedDate);
    if (!(t >= startMs && t < endMs) || isCanceled(r)) continue;
    const s = safeRide(r);
    const ref = s.reference ?? r.id ?? r._id;
    if (!ref) continue;
    const item = { ref: String(ref), t, van: s.from, naar: s.to, vlucht: s.flightNumber ? String(s.flightNumber).replace(/\s+/g, "").toUpperCase() : null };
    const d = driverIdOf(r);
    if (!d) zonder.push(item);
    else (per.get(d) ?? per.set(d, []).get(d)).push(item);
  }
  for (const lijst of per.values()) lijst.sort((a, b) => a.t - b.t);
  zonder.sort((a, b) => a.t - b.t);
  return { per, zonder };
}

export function ritRegel(i) {
  return `${hhmm(i.t)}  ${i.ref}  ${i.van ?? "?"} → ${i.naar ?? "?"}${i.vlucht ? `  ✈ ${i.vlucht}` : ""}`;
}

export function createBelronde({ store, taxiId, send, editText = async () => {}, removeButtons = async () => {}, env = process.env, now = () => Date.now(), log = console }) {
  const actief = !/^(uit|nee|0|false|off)$/i.test(String(env.BEL_HERINNERING ?? "aan").trim());
  const T = {
    eerst: parseTijd(env.BEL_HERINNERING_TIJD, "17:00"),
    nogmaals: parseTijd(env.BEL_NOGMAALS_TIJD, "19:30"),
    overzicht: parseTijd(env.BEL_OVERZICHT_TIJD, "20:00"),
    laatst: parseTijd(env.BEL_LAATST_TIJD, "21:30"),
  };
  const admins = String(env.BOT_BEHEER_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isAdmin = (chatId) => admins.includes(String(chatId));

  const st = () => {
    store.state.bel ??= { dagen: {} };
    store.state.bel.dagen ??= {};
    return store.state.bel;
  };
  const chats = () => store.state.chats;
  const chatsVan = (driverId) => Object.entries(chats()).filter(([, c]) => c.toegelaten && c.driverId === driverId).map(([id]) => id);

  async function veilig(fn, wat) {
    try {
      return await fn();
    } catch (err) {
      log.warn?.(`Belherinnering: ${wat} mislukt: ${err.message}`);
      return null;
    }
  }
  const naarBeheer = async (tekst) => {
    for (const id of admins) await veilig(() => send(id, tekst), "bericht aan beheer");
  };

  let laatsteVelden = null;
  async function naamVan(driverId) {
    const gekoppeld = Object.values(chats()).find((c) => c.driverId === driverId && c.driverNaam);
    if (gekoppeld) return gekoppeld.driverNaam;
    const d = await veilig(() => taxiId.getDriver?.(driverId), "chauffeursnaam ophalen");
    if (!d?.naam && d?.velden) laatsteVelden = d.velden;
    return d?.naam ?? null;
  }

  async function haalRitten(t) {
    const r = await taxiId.getUpcomingRides({ force: true });
    // Een iets oudere stand (taxiID even weg) is goed genoeg; ouder dan een uur niet.
    if (r.stale && t - r.fetchedAt > 3600000) throw new Error(r.error ?? "taxiID niet bereikbaar");
    return r.rides;
  }

  const knop = (dag, driverId) => ({ reply_markup: { inline_keyboard: [[{ text: "Gebeld ✅", callback_data: `bel:${dag}:${driverId}` }]] } });

  function eersteTekst(dag, items) {
    return [
      `📞 Morgen (${dayLabel(dag)}) heb je ${ritten(items.length)}. Wil je je passagiers vanavond even bellen om de details te controleren?`,
      "",
      ...items.map(ritRegel),
      "",
      "Namen en telefoonnummers staan in je taxiID-app. Tik op Gebeld als je klaar bent.",
    ].join("\n");
  }

  async function verstuur(chatIds, tekst, extra) {
    const berichten = [];
    for (const chatId of chatIds) {
      const m = await veilig(() => send(chatId, tekst, extra), `bericht aan chat ${chatId}`);
      if (m?.message_id) berichten.push({ chatId, messageId: m.message_id });
    }
    return berichten;
  }

  // --- 17:00: eerste ronde ----------------------------------------------------
  async function eersteRonde(dag, t, m) {
    let rides;
    try {
      rides = await haalRitten(t);
    } catch (err) {
      const rec = (st().dagen[dag] ??= {});
      if (!rec.foutGemeld && m >= T.eerst + 30) {
        rec.foutGemeld = true;
        store.save();
        await naarBeheer(`⚠️ Belherinnering voor morgen nog niet verstuurd: taxiID is niet bereikbaar (${err.message}). Ik blijf het proberen tot ${tijdTekst(T.laatst)}.`);
      }
      return;
    }
    const { per, zonder } = rittenPerChauffeur(rides, dag);
    const rec = (st().dagen[dag] = { verstuurdOp: new Date(t).toISOString(), laatsteCheck: t, chauffeurs: {}, zonderChauffeur: zonder.map(({ ref, t }) => ({ ref, t })) });
    for (const [driverId, items] of per) {
      const c = (rec.chauffeurs[driverId] = {
        naam: await naamVan(driverId),
        ritten: Object.fromEntries(items.map((i) => [i.ref, { t: i.t, gebeld: false }])),
        berichten: [],
        gebeldOp: null,
      });
      c.berichten.push(...(await verstuur(chatsVan(driverId), eersteTekst(dag, items), knop(dag, driverId))));
    }
    store.save();
    log.info?.(`Belherinnering ${dag}: ${per.size} chauffeurs, ${zonder.length} ritten zonder chauffeur.`);
  }

  // --- daarna: wijzigingen in de planning ---------------------------------------
  async function wijzigingen(dag, t) {
    const rec = st().dagen[dag];
    rec.laatsteCheck = t;
    let rides;
    try {
      rides = await haalRitten(t);
    } catch {
      return;
    }
    const { per, zonder } = rittenPerChauffeur(rides, dag);
    rec.zonderChauffeur = zonder.map(({ ref, t }) => ({ ref, t }));
    for (const driverId of new Set([...Object.keys(rec.chauffeurs), ...per.keys()])) {
      const oud = { ...(rec.chauffeurs[driverId]?.ritten ?? {}) }; // kopie: c.ritten wordt hieronder bijgewerkt
      const nu = per.get(driverId) ?? [];
      const nieuw = nu.filter((i) => !oud[i.ref]);
      const verplaatst = nu.filter((i) => oud[i.ref] && oud[i.ref].t !== i.t);
      const weg = Object.keys(oud).filter((ref) => !nu.some((i) => i.ref === ref));
      if (!nieuw.length && !verplaatst.length && !weg.length) continue;

      const c = (rec.chauffeurs[driverId] ??= { naam: await naamVan(driverId), ritten: {}, berichten: [], gebeldOp: null });
      for (const ref of weg) delete c.ritten[ref];
      for (const i of [...nieuw, ...verplaatst]) c.ritten[i.ref] = { t: i.t, gebeld: false };
      const opnieuwBellen = nieuw.length + verplaatst.length > 0;
      if (opnieuwBellen) c.gebeldOp = null;

      const regels = [`🔄 Wijziging in je ritten van morgen (${dayLabel(dag)}):`, ""];
      if (nieuw.length) regels.push("Nieuw:", ...nieuw.map(ritRegel), "");
      if (verplaatst.length) regels.push("Andere tijd:", ...verplaatst.map((i) => `${ritRegel(i)}  (was ${hhmm(oud[i.ref].t)})`), "");
      if (weg.length) regels.push("Vervallen of niet meer bij jou:", ...weg.map((ref) => `${hhmm(oud[ref].t)}  ${ref}`), "");
      regels.push(opnieuwBellen ? "Wil je deze passagiers ook even bellen? Tik daarna op Gebeld." : "Voor deze rit hoef je niet meer te bellen.");
      c.berichten.push(...(await verstuur(chatsVan(driverId), regels.join("\n"), opnieuwBellen ? knop(dag, driverId) : undefined)));
    }
    store.save();
  }

  // --- 19:30: herinnering -----------------------------------------------------
  async function nogmaals(dag, t) {
    const rec = st().dagen[dag];
    rec.nogmaalsOp = new Date(t).toISOString();
    for (const [driverId, c] of Object.entries(rec.chauffeurs)) {
      const open = Object.entries(c.ritten).filter(([, r]) => !r.gebeld);
      if (!open.length) continue;
      const tekst = `⏰ Herinnering: heb je je passagiers voor morgen al gebeld? Nog niet afgevinkt: ${open.map(([ref, r]) => `${hhmm(r.t)} ${ref}`).join(", ")}.`;
      c.berichten.push(...(await verstuur(chatsVan(driverId), tekst, knop(dag, driverId))));
    }
    store.save();
  }

  // --- 20:00: overzicht voor beheer ----------------------------------------------
  function overzichtTekst(dag, rec) {
    const regels = [`📋 Belronde voor morgen (${dayLabel(dag)}):`];
    const lijst = Object.entries(rec.chauffeurs).filter(([, c]) => Object.keys(c.ritten).length);
    if (!lijst.length && !rec.zonderChauffeur?.length) return `${regels[0]}\nGeen ritten.`;
    lijst.sort(([, a], [, b]) => Math.min(...Object.values(a.ritten).map((r) => r.t)) - Math.min(...Object.values(b.ritten).map((r) => r.t)));
    for (let [driverId, c] of lijst) {
      const alle = Object.values(c.ritten);
      const eerste = Object.entries(c.ritten).sort(([, a], [, b]) => a.t - b.t)[0];
      // Naam onbekend: eerste rit erbij, dan is de chauffeur in het portaal terug te vinden.
      c = { ...c, naam: c.naam ?? `Onbekende chauffeur (eerste rit ${hhmm(eerste[1].t)} ${eerste[0]})` };
      const open = alle.filter((r) => !r.gebeld).length;
      if (!chatsVan(driverId).length) regels.push(`❓ ${c.naam}: ${ritten(alle.length)}, niet gekoppeld aan de bot`);
      else if (!open) regels.push(`✅ ${c.naam}: ${ritten(alle.length)}, gebeld${c.gebeldOp ? ` (${hhmm(c.gebeldOp)})` : ""}`);
      else regels.push(`⏳ ${c.naam}: ${ritten(alle.length)}, ${open === alle.length ? "nog niet afgevinkt" : `${open} nog niet afgevinkt`}`);
    }
    if (rec.zonderChauffeur?.length) regels.push(`⚠️ Zonder chauffeur: ${rec.zonderChauffeur.map((r) => `${hhmm(r.t)} ${r.ref}`).join(", ")}`);
    return regels.join("\n");
  }

  async function overzicht(dag, t) {
    const rec = st().dagen[dag];
    rec.overzichtOp = new Date(t).toISOString();
    store.save();
    await naarBeheer(overzichtTekst(dag, rec));
  }

  // --- koppelen: wie ben je? --------------------------------------------------------
  async function koppelVraag(chatId) {
    let lijst = await veilig(() => taxiId.listDrivers?.(), "chauffeurslijst ophalen");
    if (!lijst?.length) {
      // Geen lijst uit taxiID: kies uit de chauffeurs die in de ritten staan.
      const r = await veilig(() => taxiId.getUpcomingRides(), "ritten ophalen");
      const ids = [...new Set((r?.rides ?? []).map(driverIdOf).filter(Boolean))];
      lijst = [];
      for (const id of ids) lijst.push({ id, naam: await naamVan(id) });
    }
    lijst = lijst.filter((d) => d.id && d.naam).sort((a, b) => a.naam.localeCompare(b.naam, "nl"));
    if (!lijst.length) return "Ik kan de chauffeurs uit taxiID nu niet ophalen. Probeer het later opnieuw met /ikben.";
    const c = chats()[String(chatId)];
    if (c) c.koppelGevraagd = new Date(now()).toISOString();
    store.save();
    const rijen = lijst.slice(0, 40).map((d) => [{ text: d.naam, callback_data: `ikben:${d.id}` }]);
    rijen.push([{ text: "Ik rijd zelf geen ritten", callback_data: "ikben:geen" }]);
    return {
      text: "📞 Elke middag om " + tijdTekst(T.eerst) + " stuur ik je de ritten van morgen, zodat je je passagiers kunt bellen. Daarvoor moet ik weten wie je bent in taxiID. Tik op je naam:",
      reply_markup: { inline_keyboard: rijen },
    };
  }

  /** Na een bericht van een (net) toegelaten chauffeur: nog niet gekoppeld? Dan meteen vragen. */
  async function naBericht(chatId) {
    if (!actief) return null;
    const c = chats()[String(chatId)];
    if (!c?.toegelaten || c.driverId !== undefined || c.koppelGevraagd) return null;
    return koppelVraag(chatId);
  }

  /** Chauffeurs die al in de bot zaten voor de belherinnering bestond: één keer vragen (overdag). */
  async function vraagOudeChats(t) {
    // Eenmalig (24-10-2026): de eerste versie zette "gevraagd" ook als de vraag
    // niet verstuurd kon worden (namen niet herkend). Die markering wissen.
    if ((st().koppelVersie ?? 1) < 2) {
      for (const c of Object.values(chats())) if (c.driverId === undefined) delete c.koppelGevraagd;
      st().koppelVersie = 2;
      store.save();
    }
    const m = minuutVanDag(t);
    if (m < 8 * 60 || m > T.laatst) return;
    for (const [chatId, c] of Object.entries(chats())) {
      if (!c.toegelaten || c.driverId !== undefined || c.koppelGevraagd) continue;
      const vraag = await koppelVraag(chatId);
      if (typeof vraag === "object") await veilig(() => send(chatId, vraag.text, { reply_markup: vraag.reply_markup }), "koppelvraag");
    }
  }

  // --- knoppen ------------------------------------------------------------------
  /** @returns {Promise<string|null>} korte tekst voor het pop-upje bij de knop */
  async function knopGedrukt(cb) {
    const data = String(cb?.data ?? "");
    const chatId = String(cb?.message?.chat?.id ?? "");
    const c = chats()[chatId];
    if (!c?.toegelaten) return null;

    if (data.startsWith("ikben:")) {
      const id = data.slice(6);
      if (id === "geen") {
        c.driverId = null;
        c.driverNaam = null;
        store.save();
        await veilig(() => editText(chatId, cb.message.message_id, "Oké, je krijgt geen belherinnering. Toch wel? Stuur /ikben."), "bericht bijwerken");
        return "Genoteerd";
      }
      const naam = (await naamVan(id)) ?? "chauffeur";
      const anderen = chatsVan(id).filter((x) => x !== chatId);
      c.driverId = id;
      c.driverNaam = naam;
      store.save();
      await veilig(
        () => editText(chatId, cb.message.message_id, `Gekoppeld als ${naam}. Elke middag om ${tijdTekst(T.eerst)} krijg je je ritten van morgen. Verkeerde naam? Stuur /ikben.`),
        "bericht bijwerken",
      );
      await naarBeheer(`Belherinnering: ${c.naam || "(geen naam)"} (chat ${chatId}) is gekoppeld als ${naam}.${anderen.length ? ` Let op: ook chat ${anderen.join(", ")} is als ${naam} gekoppeld.` : ""}`);
      return `Gekoppeld als ${naam}`;
    }

    const m = /^bel:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(data);
    if (!m) return null;
    const [, dag, driverId] = m;
    const rec = st().dagen[dag]?.chauffeurs?.[driverId];
    if (!rec) return "Deze herinnering is verlopen.";
    if (c.driverId !== driverId && !isAdmin(chatId)) return "Dit is niet jouw herinnering.";
    for (const r of Object.values(rec.ritten)) r.gebeld = true;
    rec.gebeldOp = new Date(now()).toISOString();
    store.save();
    const tekst = `${cb.message.text ?? ""}\n\n✅ Gebeld (${hhmm(now())})`;
    await veilig(() => editText(chatId, cb.message.message_id, tekst), "bericht bijwerken");
    for (const b of rec.berichten) {
      if (b.chatId === chatId && b.messageId === cb.message.message_id) continue;
      await veilig(() => removeButtons(b.chatId, b.messageId), "knop weghalen");
    }
    rec.berichten = [];
    return "Bedankt!";
  }

  // --- beheer -------------------------------------------------------------------
  /** /belronde: stand voor morgen (of een voorproef als er nog niets verstuurd is). */
  async function stand() {
    const t = now();
    const dag = addDays(amsterdamYmd(t), 1);
    const rec = st().dagen[dag];
    if (rec?.verstuurdOp) return overzichtTekst(dag, rec);
    let rides;
    try {
      rides = (await taxiId.getUpcomingRides()).rides;
    } catch (err) {
      return `taxiID is niet bereikbaar (${err.message}).`;
    }
    const { per, zonder } = rittenPerChauffeur(rides, dag);
    const voorproef = { chauffeurs: {}, zonderChauffeur: zonder };
    for (const [id, items] of per) voorproef.chauffeurs[id] = { naam: await naamVan(id), ritten: Object.fromEntries(items.map((i) => [i.ref, { t: i.t, gebeld: false }])) };
    let tekst = `Nog niet verstuurd (dat gebeurt om ${tijdTekst(T.eerst)}).\n${overzichtTekst(dag, voorproef)}`;
    if (Object.values(voorproef.chauffeurs).some((c) => !c.naam)) {
      tekst += `\n\nℹ️ Ik herken de chauffeursnamen uit taxiID nog niet, dus chauffeurs kunnen zich nog niet koppelen.${laatsteVelden ? ` Velden bij een chauffeur in taxiID (alleen namen, geen inhoud): ${laatsteVelden.join(", ")}` : ""}`;
    }
    return tekst;
  }

  function koppelingen() {
    const lijst = Object.entries(chats()).filter(([, c]) => c.toegelaten);
    if (!lijst.length) return "Nog niemand.";
    return lijst
      .map(([id, c]) => `• ${c.naam || "(geen naam)"} (${id}): ${c.driverId ? c.driverNaam ?? c.driverId : c.driverId === null ? "rijdt geen ritten" : "nog niet gekoppeld"}`)
      .join("\n");
  }

  // --- elke minuut ------------------------------------------------------------------
  let bezig = false;
  async function tick() {
    if (!actief || bezig) return;
    bezig = true;
    try {
      const t = now();
      const m = minuutVanDag(t);
      const vandaag = amsterdamYmd(t);
      const dag = addDays(vandaag, 1);
      for (const d of Object.keys(st().dagen)) if (!DAG_RE.test(d) || d < addDays(vandaag, -7)) delete st().dagen[d];
      await vraagOudeChats(t);
      if (m < T.eerst || m > T.laatst) return;
      if (!st().dagen[dag]?.verstuurdOp) return await eersteRonde(dag, t, m);
      const rec = st().dagen[dag];
      const checkNodig = (ms) => t - (rec.laatsteCheck ?? 0) >= ms;
      if (checkNodig(30 * 60000)) await wijzigingen(dag, t);
      if (m >= T.nogmaals && !rec.nogmaalsOp) {
        if (checkNodig(5 * 60000)) await wijzigingen(dag, t);
        await nogmaals(dag, t);
      }
      if (m >= T.overzicht && !rec.overzichtOp) {
        if (checkNodig(5 * 60000)) await wijzigingen(dag, t);
        await overzicht(dag, t);
      }
    } finally {
      bezig = false;
    }
  }

  return { actief, tick, knopGedrukt, koppelVraag, naBericht, stand, koppelingen };
}
