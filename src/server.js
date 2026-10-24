/**
 * Wilnu Taxi chauffeursdiensten: garagescherm + vluchtbot in één kleine app.
 *
 *   /             garagescherm (voor de tv in de garage)
 *   /api/garage   de inrijvolgorde als JSON (het scherm ververst zichzelf)
 *   /api/health   voor DigitalOcean
 *
 * De bot en de vluchtvolger starten alleen als TELEGRAM_BOT_TOKEN is gezet;
 * het garagescherm werkt ook zonder.
 */
import "dotenv/config";
console.log(`Start chauffeursdiensten (Node ${process.version}), poort ${process.env.PORT || 3000}.`);
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTaxiIdClient } from "./taxiid.js";
import { computeGarageOrder } from "./garage.js";
import { loadVehicles, resolveVehicles, loadEigenKentekens, rittenMetActieveAuto } from "./vehicles.js";
import { createRoosterBron, loadRoosterConfig, pasRoosterToe } from "./rooster.js";
import { planDay } from "./garage.js";
import { createStore } from "./store.js";
import { createAeroDataBox } from "./flights/aerodatabox.js";
import { createTracker } from "./flights/tracker.js";
import { createTelegram, createBotHandler } from "./telegram.js";
import { createBelronde } from "./belronde.js";

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const SCREEN_TOKEN = String(env.GARAGE_TOKEN ?? "").trim();
const SWITCH_HOUR = Number(env.GARAGE_WISSELUUR ?? 12);
const pagePath = fileURLToPath(new URL("../public/garage.html", import.meta.url));

const taxiId = createTaxiIdClient();
const rooster = createRoosterBron();
let vehicles = loadVehicles();

function authorized(url) {
  return !SCREEN_TOKEN || url.searchParams.get("t") === SCREEN_TOKEN;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/" || url.pathname === "/garage") {
      if (!authorized(url)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Geen toegang: open het scherm met de juiste link (?t=...).");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await readFile(pagePath));
    }
    if (url.pathname === "/api/garage") {
      if (!authorized(url)) return sendJson(res, 403, { fout: "geen toegang" });
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("datum") ?? "") ? url.searchParams.get("datum") : undefined;
      try {
        vehicles = loadVehicles();
      } catch (err) {
        console.warn(`voertuigen.json lezen mislukt, vorige versie blijft: ${err.message}`);
      }
      const opgehaald = await taxiId.getUpcomingRides({ force: url.searchParams.has("vers") });
      const { fetchedAt, stale, error } = opgehaald;
      // Auto via de chauffeur (zoals het portaal), niet via het id in de rit.
      const rides = await rittenMetActieveAuto(opgehaald.rides, taxiId);
      const eigen = loadEigenKentekens();
      const nowMs = Date.now();
      const dag = day ?? planDay(nowMs, SWITCH_HOUR);
      let allVehicles = await resolveVehicles(vehicles, rides, taxiId);
      // Rooster uit Google Agenda gaat voor op de auto die in de chauffeursapp staat.
      const diensten = rooster.actief ? await rooster.voorDag(dag, loadRoosterConfig(), eigen) : [];
      const { vehicles: metRooster, afwijkingen } = pasRoosterToe(allVehicles, diensten);
      allVehicles = metRooster;
      const result = computeGarageOrder(rides, allVehicles, { nowMs, day: dag, switchHour: SWITCH_HOUR, eigenKentekens: eigen });
      for (const a of afwijkingen) {
        const heeftRit = result.inrijvolgorde.some((c) => c.aantalRitten > 0 && c.vehicleIds?.some((id) => a.voertuigIds.includes(id)));
        if (heeftRit) result.waarschuwingen.unshift(`${a.naam}: rooster ${a.rooster}, chauffeursapp ${a.app}. Het scherm volgt het rooster.`);
      }
      result.rooster = diensten.map((d) => ({ naam: d.naam, kenteken: d.kenteken }));
      if (stale) result.waarschuwingen.unshift(`taxiID was niet bereikbaar (${error}); dit is de stand van ${new Date(fetchedAt).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" })}.`);
      result.taxiIdOpgehaald = new Date(fetchedAt).toISOString();
      return sendJson(res, 200, result);
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Niet gevonden");
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { fout: err.message });
  }
});

server.on("error", (err) => {
  console.error(`Webserver kan niet starten: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => console.log(`Chauffeursdiensten draait op poort ${PORT}${SCREEN_TOKEN ? " (scherm met token)" : ""}.`));

// --- Vluchtbot -------------------------------------------------------------
if (env.TELEGRAM_BOT_TOKEN) {
  const store = createStore();
  await store.load();
  const telegram = createTelegram();
  const admins = String(env.BOT_BEHEER_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const notifyAdmins = async (text) => {
    for (const id of admins) await telegram.sendMessage(id, text).catch(() => {});
  };
  const tracker = createTracker({ store, api: createAeroDataBox(), taxiId, send: (chatId, text) => telegram.sendMessage(chatId, text) });
  const belronde = createBelronde({
    store,
    taxiId,
    send: (chatId, text, extra) => telegram.sendMessage(chatId, text, extra),
    editText: (chatId, messageId, text) => telegram.editMessageText(chatId, messageId, text),
    removeButtons: (chatId, messageId) => telegram.removeButtons(chatId, messageId),
  });
  const handle = createBotHandler({ store, tracker, belronde, notifyAdmins });
  const reageer = async (chatId, reply) => {
    if (!reply) return;
    if (typeof reply === "string") await telegram.sendMessage(chatId, reply);
    else await telegram.sendMessage(chatId, reply.text, { reply_markup: reply.reply_markup });
  };
  const poller = telegram.startPolling(
    async (message) => {
      await reageer(message.chat.id, await handle(message));
      // Net toegelaten en nog niet gekoppeld aan een taxiID-chauffeur? Dan meteen "wie ben je?".
      await reageer(message.chat.id, await belronde.naBericht(message.chat.id));
    },
    async (cb) => {
      const antwoord = await belronde.knopGedrukt(cb);
      await telegram.answerCallback(cb.id, antwoord).catch(() => {});
    },
  );
  const interval = setInterval(() => {
    tracker.tick().catch((err) => console.error(`Vluchtcontrole mislukt: ${err.message}`));
    belronde.tick().catch((err) => console.error(`Belherinnering mislukt: ${err.message}`));
  }, 60000);
  console.log(`Vluchtbot gestart (opslag: ${store.kind}; belherinnering ${belronde.actief ? "aan" : "uit"}).`);

  const shutdown = async () => {
    poller.stop();
    clearInterval(interval);
    await store.flush();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.log("TELEGRAM_BOT_TOKEN niet gezet: alleen het garagescherm draait.");
}
