/**
 * Telegram-bot (long polling: de app vraagt zelf om nieuwe berichten, dus
 * er is geen publieke webhook-URL nodig).
 *
 * Toegang: de bot is voor iedereen op Telegram te vinden. Daarom moet een
 * chauffeur één keer de toegangscode (BOT_TOEGANGSCODE) sturen; daarna
 * onthoudt de bot zijn chat. Beheerders (BOT_BEHEER_CHAT_IDS) krijgen een
 * berichtje als er iemand nieuw bijkomt en kunnen /gebruik en /chauffeurs.
 */
const API = "https://api.telegram.org";

export function createTelegram({ token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = (...a) => fetch(...a), log = console } = {}) {
  async function call(method, payload, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? `HTTP ${res.status}`}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  const sendMessage = (chatId, text) => call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

  /** Blijft berichten ophalen tot `stop()` wordt aangeroepen. */
  function startPolling(onMessage) {
    let offset = 0;
    let stopped = false;
    (async () => {
      await call("deleteWebhook", {}).catch(() => {});
      while (!stopped) {
        try {
          const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65000);
          for (const u of updates) {
            offset = u.update_id + 1;
            if (u.message?.text) {
              await onMessage(u.message).catch((err) => log.error?.(`Bericht verwerken mislukt: ${err.message}`));
            }
          }
        } catch (err) {
          if (stopped) break;
          log.warn?.(`Telegram ophalen mislukt (${err.message}); opnieuw over 10 s.`);
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
    })();
    return { stop: () => (stopped = true) };
  }

  return { sendMessage, startPolling, call };
}

export const HELP = [
  "Zo werkt het (alleen voor ritten die op een luchthaven beginnen):",
  "• Stuur je vluchtnummer, bv. KL1234. Ik zoek de rit in taxiID en kies die dag; anders morgen.",
  "• Andere dag? KL1234 vandaag, of KL1234 13-10.",
  "• /mijn: welke vluchten je volgt en de laatste stand",
  "• /stop KL1234: stoppen met één vlucht (/stop zonder nummer: alles)",
  "Je krijgt een bericht bij vertraging, opstijgen, een nieuwe verwachte aankomst en de landing.",
].join("\n");

/**
 * Verwerkt één binnenkomend bericht. Los van Telegram zelf, zodat het te testen is.
 * @returns {Promise<string|null>} het antwoord
 */
export function createBotHandler({ store, tracker, env = process.env, notifyAdmins = async () => {}, now = () => Date.now() }) {
  const code = String(env.BOT_TOEGANGSCODE ?? "").trim();
  const admins = new Set(String(env.BOT_BEHEER_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  return async function handle(message) {
    const chatId = String(message.chat.id);
    const text = String(message.text ?? "").trim();
    const name = message.from?.first_name ?? "";
    const chats = store.state.chats;
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.startsWith("/") ? cmdRaw.toLowerCase().replace(/@.*$/, "") : null;
    const arg = rest.join(" ");

    if (cmd === "/id") return `Je chat-id is ${chatId}.`;

    if (!chats[chatId]?.toegelaten) {
      if (!code) return "De bot is nog niet ingesteld (geen toegangscode). Meld dit bij de centrale.";
      const attempt = cmd === "/start" ? arg : text;
      if (attempt && attempt === code) {
        chats[chatId] = { toegelaten: true, naam: name, sinds: new Date(now()).toISOString() };
        store.save();
        await notifyAdmins(`Nieuwe chauffeur in de vluchtbot: ${name || "(geen naam)"} (chat ${chatId}).`);
        return `Welkom${name ? ` ${name}` : ""}! Je bent aangemeld.\n\n${HELP}`;
      }
      return "Hallo! Dit is de vluchtbot van Wilnu Taxi. Stuur eerst de toegangscode die je van de centrale hebt gekregen.";
    }

    switch (cmd) {
      case "/start":
      case "/help":
      case "/hulp":
        return HELP;
      case "/mijn":
      case "/lijst":
        return tracker.list({ chatId });
      case "/stop":
        return tracker.unsubscribe({ chatId, text: arg });
      case "/gebruik": {
        if (!admins.has(chatId)) return HELP;
        const u = tracker.usage(now());
        const actief = store.state.subscriptions.length;
        return `Vandaag: ${u.calls} aanroepen, ${u.units} van ${u.budget} units. Actieve aanmeldingen: ${actief}.`;
      }
      case "/chauffeurs": {
        if (!admins.has(chatId)) return HELP;
        const list = Object.entries(chats).filter(([, c]) => c.toegelaten);
        return list.length ? list.map(([id, c]) => `• ${c.naam || "(geen naam)"} (${id})`).join("\n") : "Nog niemand.";
      }
      case "/verwijder": {
        if (!admins.has(chatId)) return HELP;
        if (!chats[arg]) return "Onbekend chat-id. Zie /chauffeurs.";
        delete chats[arg];
        store.state.subscriptions = store.state.subscriptions.filter((s) => s.chatId !== arg);
        store.save();
        return `Chat ${arg} heeft geen toegang meer.`;
      }
      default:
        if (cmd) return HELP;
        return tracker.subscribe({ chatId, text, nowMs: now() });
    }
  };
}
