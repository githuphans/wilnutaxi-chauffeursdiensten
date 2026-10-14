import { test } from "node:test";
import assert from "node:assert/strict";
import { roosterVoorDag, pasRoosterToe } from "../src/rooster.js";

// Nagemaakt naar de agenda van 14-10-2026 (Google-opmaak, met VTIMEZONE).
const ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
X-WR-TIMEZONE:Europe/Amsterdam
BEGIN:VTIMEZONE
TZID:Europe/Amsterdam
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Europe/Amsterdam:20260901T040000
DTEND;TZID=Europe/Amsterdam:20260901T110000
RRULE:FREQ=WEEKLY;BYDAY=TU
UID:dinsdag@google.com
SUMMARY:HAN
LOCATION:(Standaard auto)-Taxi garage-G-GGZ-37-R BYD ATTO EV (1)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Amsterdam:20260902T040000
DTEND;TZID=Europe/Amsterdam:20260902T110000
RRULE:FREQ=WEEKLY;BYDAY=WE,TH
EXDATE;TZID=Europe/Amsterdam:20261022T040000
UID:woedo@google.com
SUMMARY:HAN
LOCATION:(Standaard auto)-Taxi garage-G-GHN-49-K BYD Atto 3 (1)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Amsterdam:20261029T050000
DTEND;TZID=Europe/Amsterdam:20261029T110000
RECURRENCE-ID;TZID=Europe/Amsterdam:20261029T040000
UID:woedo@google.com
SUMMARY:HAN
LOCATION:(Standaard auto)-Taxi garage-G-GNP-46-F Toyota bZ4X (1)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Amsterdam:20260902T040000
DTEND;TZID=Europe/Amsterdam:20260902T110000
RRULE:FREQ=WEEKLY;BYDAY=WE,TH
UID:kopie-andere-agenda@google.com
SUMMARY:HAN
ATTENDEE;CN=(Standaard auto)-Taxi garage-G-GHN-49-K BYD Atto 3 (1);CUTYPE=RESOURCE:mailto:c_123@resource.calendar.google.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Amsterdam:20261015T080000
DTEND;TZID=Europe/Amsterdam:20261015T090000
UID:rit@google.com
SUMMARY:9084872 - Peter Hanssen GGZ-37-R
END:VEVENT
END:VCALENDAR`.replace(/\n/g, "\r\n");

const ch = [{ naam: "Han", zoekwoord: "HAN", voertuigIds: ["HANID"] }];
const eigen = ["GGZ-37-R", "GHN-49-K", "GNP-46-F"];
const dag = (ymd) => roosterVoorDag(ICS, { ymd, chauffeurs: ch, eigenKentekens: eigen }).map((d) => d.kenteken);

test("rooster: dinsdag GGZ-37-R, woensdag/donderdag GHN-49-K", () => {
  assert.deepEqual(dag("2026-10-13"), ["GGZ-37-R"]);
  assert.deepEqual(dag("2026-10-14"), ["GHN-49-K"]);
  assert.deepEqual(dag("2026-10-15"), ["GHN-49-K"]);
  assert.deepEqual(dag("2026-10-16"), []); // vrijdag geen dienst
  assert.deepEqual(dag("2026-10-12"), []); // maandag; "Peter Hanssen" telt niet als HAN
});

test("rooster: na de wintertijd (25-10) klopt de dag nog", () => {
  assert.deepEqual(dag("2026-10-27"), ["GGZ-37-R"]);
});

test("rooster: uitzondering (vervallen dienst) en eenmalige wijziging van auto", () => {
  // 22-10: hoofdafspraak vervalt (EXDATE), maar de kopie in de andere agenda niet
  assert.deepEqual(dag("2026-10-22"), ["GHN-49-K"]);
  const ics2 = ICS.replace(/BEGIN:VEVENT\r\nDTSTART;TZID=Europe\/Amsterdam:20260902T040000\r\nDTEND;TZID=Europe\/Amsterdam:20260902T110000\r\nRRULE:FREQ=WEEKLY;BYDAY=WE,TH\r\nUID:kopie[\s\S]*?END:VEVENT\r\n/, "");
  assert.deepEqual(roosterVoorDag(ics2, { ymd: "2026-10-22", chauffeurs: ch, eigenKentekens: eigen }), []);
  // 29-10: die ene keer in de Toyota (kopie-agenda zegt nog GHN; eerste treffer telt)
  const d29 = roosterVoorDag(ics2, { ymd: "2026-10-29", chauffeurs: ch, eigenKentekens: eigen });
  assert.deepEqual(d29.map((d) => d.kenteken), ["GNP-46-F"]);
});

test("rooster gaat voor op de app, met afwijking", () => {
  const v = { HANID: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" }, X: { kenteken: "GHN-49-K", naam: "BYD Atto 3" } };
  const { vehicles, afwijkingen } = pasRoosterToe(v, [{ naam: "Han", kenteken: "GHN-49-K", voertuigIds: ["HANID"] }]);
  assert.equal(vehicles.HANID.kenteken, "GHN-49-K");
  assert.deepEqual(afwijkingen.map((a) => [a.rooster, a.app]), [["GHN-49-K", "GGZ-37-R"]]);
  assert.equal(pasRoosterToe(v, []).afwijkingen.length, 0);
});
