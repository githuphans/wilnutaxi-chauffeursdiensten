/**
 * Opslag van de bot: welke chauffeurs zijn toegelaten, wie volgt welke
 * vlucht, en de laatst bekende vluchtstand. Eén klein JSON-bestand.
 *
 * - Lokaal / op een server met schijf: data/state.json.
 * - Op DigitalOcean App Platform (geen blijvende schijf): als SPACES_* is
 *   ingesteld, wordt hetzelfde bestand in een Space bewaard
 *   (sleutel SPACES_STATE_KEY, standaard "chauffeursdiensten/state.json").
 *
 * Er staan GEEN klantgegevens in: alleen Telegram-chat-id + voornaam van de
 * chauffeur, vluchtnummers, ritreferentie/tijd/plaatsnamen en vluchttijden,
 * en voor de belherinnering: taxiID-chauffeur-id + naam en per rit
 * referentie, tijd en of er gebeld is.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpacesClient } from "./spacesClient.js";

const DEFAULT_FILE = fileURLToPath(new URL("../data/state.json", import.meta.url));

export function emptyState() {
  return { chats: {}, subscriptions: [], flights: {}, usage: { day: null, units: 0 }, bel: { dagen: {}, koppelVersie: 2 } };
}

export function createStore({ env = process.env, log = console } = {}) {
  let state = emptyState();
  let saveTimer = null;
  let saving = Promise.resolve();

  const spaces =
    env.SPACES_KEY && env.SPACES_SECRET && env.SPACES_BUCKET && env.SPACES_REGION
      ? createSpacesClient({
          accessKeyId: String(env.SPACES_KEY).trim(),
          secretAccessKey: String(env.SPACES_SECRET).trim(),
          bucket: String(env.SPACES_BUCKET).trim().replace(/^https?:\/\//, "").split(".")[0],
          region: String(env.SPACES_REGION).trim().toLowerCase(),
          endpoint: env.SPACES_ENDPOINT || `https://${String(env.SPACES_REGION).trim().toLowerCase()}.digitaloceanspaces.com`,
        })
      : null;
  const key = env.SPACES_STATE_KEY || "chauffeursdiensten/state.json";
  if (spaces) log.info?.(`Spaces: bucket "${String(env.SPACES_BUCKET).trim()}", regio "${String(env.SPACES_REGION).trim()}".`);
  const file = env.STATE_FILE || DEFAULT_FILE;

  async function load() {
    try {
      const text = spaces ? await spaces.getObject(key) : await readFile(file, "utf8").catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
      if (text) state = { ...emptyState(), ...JSON.parse(text) };
      log.info?.(`Opslag geladen (${spaces ? "Spaces" : "bestand"}): ${Object.keys(state.chats).length} chauffeurs, ${state.subscriptions.length} aanmeldingen.`);
    } catch (err) {
      log.error?.(`Opslag laden mislukt, start leeg: ${err.message}`);
    }
    return state;
  }

  async function writeNow() {
    const text = JSON.stringify(state, null, 1);
    if (spaces) return spaces.putObject(key, text);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
  }

  /** Bewaar binnen enkele seconden (meerdere wijzigingen worden samengevoegd). */
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = saving.then(writeNow).catch((err) => log.error?.(`Opslaan mislukt: ${err.message}`));
    }, 2000);
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saving = saving.then(writeNow).catch((err) => log.error?.(`Opslaan mislukt: ${err.message}`));
    }
    await saving;
  }

  return { load, save, flush, get state() { return state; }, kind: spaces ? "spaces" : "bestand" };
}
