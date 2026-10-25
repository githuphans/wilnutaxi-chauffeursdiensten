# Wilnu Taxi chauffeursdiensten

Kleine losse app (dus niet in het boekingsformulier) met drie functies:

1. **Garagescherm**: toont op de tv in de garage in welke volgorde de auto's
   naar binnen moeten. De garage is één rij: wie er als laatste in rijdt,
   staat bij de deur en kan er als eerste uit. Dus de auto met de vroegste
   eerste rit gaat er als laatste in, en een auto zonder rit als eerste.
2. **Telegram-vluchtbot**: een chauffeur stuurt het vluchtnummer van zijn rit
   en krijgt een bericht bij vertraging, opstijgen, een nieuwe verwachte
   aankomst, de landing (met bagageband als die bekend is) en annulering.

3. **Belherinnering** (via dezelfde bot): elke middag om 17:00 krijgt iedere
   chauffeur met ritten voor morgen een bericht om zijn passagiers te bellen,
   met een knop "Gebeld ✅". De centrale krijgt om 20:00 een overzicht.

Alle drie lezen de ritten uit taxiID (productie, **alleen lezen**). Er komen geen
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
- Alleen de eigen auto's uit `config/eigen-autos.json` staan in de rij. Auto's van
  anderen (bv. ZZP'ers) met ritten worden onderaan apart vermeld. Komt er een
  eigen auto bij, zet het kenteken in dat bestand.
- **Rooster:** voor chauffeurs in `config/rooster.json` (nu Han) leest de app
  de diensten uit Google Agenda (`ROOSTER_ICS_URL`). Een dienst telt als de
  titel het zoekwoord bevat (bv. "HAN") en er een eigen kenteken bij staat
  (meestal in de geboekte auto/locatie). Het rooster gaat voor op de auto in
  de chauffeursapp; wijkt de app af, dan staat er een gele melding.
- Een andere dag bekijken: `/?datum=2026-10-13`.
- De deur staat links, met de auto die het eerst weg moet ernaast. Deur rechts: zet `&deur=rechts` achter de link.

**Vluchtbot**
- Eerste keer: de chauffeur stuurt de toegangscode (`BOT_TOEGANGSCODE`).
- Daarna: `KL1234` → de bot zoekt een taxiID-rit met dat vluchtnummer en
  neemt die dag; is er geen rit, dan morgen. Een andere dag: `KL1234 vandaag`
  of `KL1234 13-10`. Vrije schrijfwijzen werken (`hv6474`, `FR 1718`, `OS 7`).
- Alleen voor **ophaalritten vanaf een luchthaven**: begint de gevonden
  taxiID-rit niet op een luchthaven, of landt de vlucht niet op een van de
  `THUIS_LUCHTHAVENS`, dan weigert de bot de aanmelding.
- Alleen vluchten waar een chauffeur zich voor heeft aangemeld worden
  gecontroleerd; er wordt niets automatisch gevolgd.
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

**Belherinnering**
- Gaat vanzelf op basis van de planning in taxiID; niemand hoeft iets in te
  stellen. Ook ZZP'ers krijgen hem, als ze in de bot zitten.
- **Koppelen (één keer per chauffeur):** na de toegangscode vraagt de bot
  "wie ben je?" met de chauffeurs uit taxiID als knoppen. Opnieuw kiezen:
  `/ikben`. Chauffeurs die al in de bot zaten krijgen die vraag één keer
  vanzelf (overdag). In de lijst staan alleen chauffeurs met een rit in de
  afgelopen 30 of komende 14 dagen; "Mijn naam staat er niet bij" toont
  iedereen. Beheer krijgt een bericht bij elke koppeling (behalve de eigen),
  met een knop "Ongedaan maken"; dat kan ook met `/ontkoppel <chat-id>`.
- **17:00** (`BEL_HERINNERING_TIJD`): bericht met de ritten van morgen
  (tijd, ritreferentie, plaatsen, vluchtnummer) en de knop "Gebeld ✅".
  Namen en telefoonnummers van passagiers staan in de taxiID-app van de
  chauffeur, niet in het bericht.
- **Tot 21:30** (`BEL_LAATST_TIJD`) wordt elk half uur gekeken of er ritten
  bij zijn gekomen, verplaatst of vervallen; de chauffeur krijgt dan een
  extra bericht (bij nieuwe of verplaatste ritten weer met de knop).
- Direct na 17:00 krijgt beheer een **verzendrapport**: per chauffeur aan
  welke chat het bericht ging, wie geen gekoppelde chat heeft, en of Telegram
  een bericht weigerde (bv. bot geblokkeerd). Uitzetten: `BEL_VERZENDRAPPORT=uit`.
- **19:30** (`BEL_NOGMAALS_TIJD`): herinnering voor wie nog niet heeft afgevinkt.
- **20:00** (`BEL_OVERZICHT_TIJD`): overzicht voor `BOT_BEHEER_CHAT_IDS`:
  ✅ gebeld, ⏳ nog niet afgevinkt, ❓ chauffeur niet gekoppeld aan de bot,
  ⚠️ ritten zonder chauffeur.
- Beheer: `/belronde` (stand voor morgen; vóór 17:00 een voorproef),
  `/koppelingen` (welke chat bij welke chauffeur hoort, met het taxiID-account,
  sinds wanneer en hoeveel ritten de komende dagen op dat account staan).
- Uitzetten: `BEL_HERINNERING=uit`.
- Proberen zonder iets te versturen: `npm run bellen` (of
  `npm run bellen -- 2026-10-26`).

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
- `src/belronde.js`: de belherinnering
- `src/store.js`: opslag (bestand of Spaces)
- `public/garage.html`: het scherm
- `config/voertuigen.json`: koppeltabel voertuig-id → kenteken

## Bekende punten (stand 20 oktober 2026)

- **Welke auto bij een rit:** het voertuig-id in de rit loopt soms achter
  (20-10-2026: rit van Ronald stond op een id dat nu GNP-46-F is). Het scherm
  kijkt daarom, net als het portaal, naar de chauffeur van de rit:
  `GET /drivers/<id>` → `activeVehicleId` (de auto die hij nu in zijn app
  heeft), en zoekt dan het kenteken op via `GET /vehicles/<id>` (beide 10
  minuten gecachet). Zonder chauffeur of antwoord geldt het id uit de rit.
  Id's met hetzelfde kenteken worden één kaart. `config/voertuigen.json` is
  alleen reserve. Controleren: `node scripts/chauffeur-proef.js 2026-10-21`.
  Heeft een chauffeur in zijn app nog de auto van zijn vorige dienst
  geselecteerd, dan toont het scherm die auto: dat is niet op te lossen.
- **`include` met vehicle en/of driver** in de rittenlijst geeft HTTP 500; niet gebruiken.
- **AeroDataBox** stuurt bij een vluchtnummer soms ook de vlucht van een andere
  dag mee. De bot gebruikt alleen het deel van de aangemelde dag en negeert
  "opgestegen/geland" met een tijd in de toekomst (fout van 13-10, hersteld).
- **DigitalOcean:** bleef een nieuwe versie hangen op "deploy readiness probe
  failed" zonder logs, dan hielp **Actions → Force Rebuild and Deploy** met
  **Clear build cache** (13-10-2026).
- Alleen één exemplaar van de app laten draaien (`instance_count: 1`); bij een
  herstart verschijnt eenmalig een Telegram-"Conflict"-melding, dat is normaal.
