/**
 * Vluchtnummers uit taxiID en uit chauffeursberichten zijn vrije tekst
 * ("hv6474", "FR 1718", "OS 7", "KL-1234", "tra6474"). Hier maken we er één
 * vaste vorm van: hoofdletters, geen spaties/streepjes, voorloopnullen in het
 * nummer weg ("KL0123" -> "KL123"), zodat taxiID-ritten en aanmeldingen
 * met elkaar te vergelijken zijn.
 *
 * Toegestaan: IATA-code (2 tekens, mag een cijfer bevatten zoals "U2" of
 * "W6") of ICAO-code (3 letters), gevolgd door 1-4 cijfers en eventueel
 * één letter.
 */
const PATTERN = /^([A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,4})([A-Z]?)$/;

export function normalizeFlightNumber(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.toUpperCase().replace(/[\s\-._/]+/g, "");
  const m = PATTERN.exec(cleaned);
  if (!m) return null;
  const num = String(Number(m[2]));
  return `${m[1]}${num}${m[3]}`;
}

/**
 * Zoekt een vluchtnummer ergens in een bericht ("ik heb morgen FR 1718",
 * "kl1234 13-10"). Geeft het genormaliseerde nummer of null.
 */
export function extractFlightNumber(text) {
  if (typeof text !== "string") return null;
  const upper = text.toUpperCase();
  const re = /(?:^|[^A-Z0-9])([A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])[\s\-]?(\d{1,4}[A-Z]?)(?=$|[^A-Z0-9])/g;
  let m;
  while ((m = re.exec(upper))) {
    const n = normalizeFlightNumber(`${m[1]}${m[2]}`);
    // Een datum als "13-10" of tijd mag geen vluchtnummer worden: code moet minstens één letter hebben.
    if (n && /[A-Z]/.test(m[1])) return n;
  }
  return null;
}

/**
 * Datum uit een bericht: "vandaag", "morgen", "overmorgen", "13-10",
 * "13/10", "13-10-2026" of "2026-10-13". Geeft YYYY-MM-DD of null.
 * `todayYmd` is de huidige Nederlandse datum.
 */
export function extractDate(text, todayYmd) {
  if (typeof text !== "string") return null;
  const t = text.toLowerCase();
  const add = (n) => {
    const d = new Date(`${todayYmd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (/\bovermorgen\b/.test(t)) return add(2);
  if (/\bmorgen\b/.test(t)) return add(1);
  if (/\bvandaag\b/.test(t)) return add(0);
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?\b/.exec(t);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(todayYmd.slice(0, 4));
    let ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // Zonder jaar en al ruim voorbij: dan volgend jaar bedoeld (bv. 2-1 in december).
    if (!m[3] && ymd < add(-7)) ymd = `${year + 1}${ymd.slice(4)}`;
    return ymd;
  }
  return null;
}
