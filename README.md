# Wilnu Taxi chauffeursdiensten

Kleine losse app (dus niet in het boekingsformulier) met twee functies:

1. **Garagescherm**: toont op de tv in de garage in welke volgorde de auto's
   naar binnen moeten. De garage is één rij: wie er als laatste in rijdt,
   staat bij de deur en kan er als eerste uit. Dus de auto met de vroegste
   eerste rit gaat er als laatste in, en een auto zonder rit als eerste.
2. **Telegram-vluchtbot**: een chauffeur stuurt het vluchtnummer van zijn rit
   en krijgt een bericht bij vertraging, opstijgen, een nieuwe verwachte
   aankomst, de landing (met bagageband als die bekend is) en annulering.

Beide lezen de ritten uit taxiID (productie, **alleen lezen**). Er komen geen
klantnamen, telefoonnummers of adressen in het scherm, de bot of de opslag;
alleen ritreferentie, tijd, plaatsnaam en vluchtnummer.

## Hoe het werkt

**Garagescherm**
- Vanaf 12:00 (`GARAGE_WISSELUUR`) toont het de ritten van morgen, daarvoor
  die van vandaag. Ritten die al voorbij zijn tellen niet mee.
- Geannuleerde ritten tellen niet mee. Ritten zonder auto geven een gele
  waarschuwing ("de volgorde kan nog veranderen").
- taxiID geeft alleen een `vehicleId`; het kenteken komt uit
  `config/voertuigen.json`. Een onbekend voertuig-id geeft een waarschuwing.
- Het scherm ververst elke 2 minuten (taxiID wordt hooguit elke 5 minuten
  gevraagd). Bij een storing blijft de laatste stand staan met een melding.
- Een andere dag bekijken: `/?datum=2026-10-13`.

**Vluchtbot**
- Eerste keer: de chauffeur stuurt de toegangscode (`BOT_TOEGANGSCODE`).
- Daarna: `KL1234` → de bot zoekt een taxiID-rit met dat vluchtnummer en
  neemt die dag; is er geen rit, dan morgen. Een andere dag: `KL1234 vandaag`
  of `KL1234 13-10`. Vrije schrijfwijzen werken (`hv6474`, `FR 1718`, `OS 7`).
- `/mijn` laat de stand zien, `/stop KL1234` stopt (zonder nummer: alles).
- Beheer (alleen `BOT_BEHEER_CHAT_IDS`): `/gebruik` (units vandaag),
  `/chauffeurs`, `/verwijder <chat-id>`. Iedereen: `/id` geeft je chat-id.
- Twee chauffeurs op dezelfde vlucht delen één controle.
- Zuinig controleren: 's nachts (00-06 uur) niet, ver voor vertrek elke paar
  uur, vanaf 2 uur voor vertrek elk half uur, in de lucht elke 45 minuten
  en in het laatste uur voor de landing elke 10 minuten. Daarna stopt het.
  Een vlucht van 2 uur kost zo ongeveer **15 aanroepen**.
- Dagbudget (`FLIGHT_DAILY_UNITS`) bewaakt het abonnement; is het op, dan
  wachten de controles en krijgen nieuwe aanmeldingen een melding.

## Eerst lokaal proberen (op je eigen pc)

```
npm install
copy .env.example .env      (Windows; op Mac/Linux: cp)
```
Zet in `.env` zelf je `TAXIID_PROD_API_KEY` (dezelfde als in het
boekingsformulier). Daarna:

```
npm run garage
```
Dit toont de inrijvolgorde met de echte ritten, met per voertuig-id een
ritreferentie. Zoek die op in het taxiID-portaal en zet de kentekens in
`config/voertuigen.json`. Dan het scherm:

```
npm start
```
en open http://localhost:3000.

Vluchtgegevens proberen (kost 1 aanroep):
```
npm run vlucht -- KL1234 2026-10-12
```

Tests: `npm test`.

## Telegram-bot aanmaken

1. Open in Telegram **@BotFather**, stuur `/newbot`, kies een naam (bv.
   "Wilnu Taxi vluchten") en een gebruikersnaam die op `bot` eindigt.
2. Je krijgt een token: zet dat als `TELEGRAM_BOT_TOKEN` (nooit in de chat).
3. Kies een toegangscode voor `BOT_TOEGANGSCODE` en geef die aan je chauffeurs.
4. Start de app, stuur `/id` naar je bot en zet dat getal in
   `BOT_BEHEER_CHAT_IDS`.

## Vluchtdienst en abonnement

De app gebruikt AeroDataBox, net als het boekingsformulier (zelfde sleutel kan).
Reken per gevolgde vlucht ongeveer 15 aanroepen × 2 units = 30 units
(kan verdubbelen als AeroDataBox extra rekent voor vluchtplannen).

| Vluchten per dag | Units per maand (ca.) | Past in |
|---|---|---|
| 3 | 2.700 | RapidAPI Pro (5.000, ca. $8) |
| 10 | 9.000 | API.market Pro 2 (15.000, ca. $15) of RapidAPI Ultra (50.000, ca. $40) |
| 20 | 18.000 | RapidAPI Ultra / API.market Ultra (50.000) |

Het gratis Basic-abonnement (400 units per maand) is te weinig. Kijk na een
week met `/gebruik` hoeveel het echt is. API.market gebruiken? Zet
`AERODATABOX_PROVIDER=apimarket` en de sleutel van API.market.

## Op DigitalOcean zetten

1. Maak een nieuwe (privé) GitHub-repository en push deze map.
2. DigitalOcean → Apps → Create App → kies de repository, of gebruik
   `.do/app.yaml` (vul eerst de repo-naam in).
3. Vul de geheime variabelen in (zie `.env.example`), als "Encrypted".
4. Opslag: App Platform wist de schijf bij elke nieuwe versie. Vul daarom de
   `SPACES_*`-variabelen in (dezelfde Space als het boekingsformulier mag);
   de bot bewaart dan alles in `chauffeursdiensten/state.json`.
5. Laat `instance_count` op 1 staan (twee exemplaren van de bot botsen).
6. Kosten: het kleinste formaat (basic-xxs) is ongeveer $5 per maand.

De link voor het scherm wordt dan
`https://<app-naam>.ondigitalocean.app/?t=<GARAGE_TOKEN>`.

## Het scherm in de garage (mini-pc)

Met een Raspberry Pi (Raspberry Pi OS met bureaublad):
1. Zet in de instellingen "scherm niet uitschakelen" aan.
2. Laat Chromium bij het opstarten in kioskmodus de link openen, bv. in
   `~/.config/autostart/garage.desktop`:
   ```
   [Desktop Entry]
   Type=Application
   Name=Garagescherm
   Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars "https://<app-naam>.ondigitalocean.app/?t=<GARAGE_TOKEN>"
   ```
3. De pagina herlaadt zichzelf elke nacht om 03:00.

## Bestanden

- `src/garage.js`: berekening van de inrijvolgorde
- `src/taxiid.js`: ritten ophalen (alleen lezen, eigen dagfilter, pagineren)
- `src/flights/`: vluchtnummers, AeroDataBox, meldingen en controleschema
- `src/telegram.js`: de bot
- `src/store.js`: opslag (bestand of Spaces)
- `public/garage.html`: het scherm
- `config/voertuigen.json`: koppeltabel voertuig-id → kenteken
