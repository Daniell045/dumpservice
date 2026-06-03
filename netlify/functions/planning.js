const { getStore } = require('@netlify/blobs');
const Anthropic = require('@anthropic-ai/sdk');

// Autop Heerlen tarieven (per dagdeel, excl. km + verzekering)
const VOERTUIGEN = [
  { naam: 'Kleine bestelwagen', maxM3: 6,  huurprijs: 24.50, beschrijving: 'tot 6 m³' },
  { naam: 'Middelgrote bus',    maxM3: 10, huurprijs: 34.30, beschrijving: 'tot 10 m³' },
  { naam: 'Grote transportbus', maxM3: 17, huurprijs: 41.30, beschrijving: 'tot 17 m³' },
  { naam: 'Verhuiswagen + laadklep', maxM3: 30, huurprijs: 64.40, beschrijving: 'groot volume' },
];

const VERZEKERING_PER_DAG = 19;
const KM_PRIJS = 0.21;
const GESCHATTE_KM = 80; // schatting voor een dag Zuid-Limburg

const VOLUME_M3    = { klein: 0.75, middel: 2, groot: 4.5, onbekend: 2 };
const SERVICE_PRIJS = { klein: 45,  middel: 75, groot: 120, onbekend: 75 };

// Stortkosten per m³
const STORTKOSTEN = {
  'Grofvuil / meubels': 35,
  'Bouwafval / puin':   100,
  'Hout':               20,
  'Gemengd':            35,
  'Elektronica':        0, // op aanvraag
  'Anders / combinatie': 35,
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const password = event.queryStringParameters?.password || JSON.parse(event.body || '{}').password;
  if (password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  try {
    const store = getStore('dumpservice');

    // Haal alle aanvragen op
    const { blobs } = await store.list({ prefix: 'aanvraag_' });
    const aanvragen = [];
    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (raw) aanvragen.push(JSON.parse(raw));
    }

    if (aanvragen.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ bericht: 'Geen aanvragen gevonden.' }) };
    }

    // ── Financiële berekening ──
    const totaalM3 = aanvragen.reduce((sum, a) => sum + (VOLUME_M3[a.volume] || 2), 0);
    const voertuig = VOERTUIGEN.find(v => v.maxM3 >= totaalM3) || VOERTUIGEN[VOERTUIGEN.length - 1];

    const huurTotaal = voertuig.huurprijs + VERZEKERING_PER_DAG + (GESCHATTE_KM * KM_PRIJS);
    const omzet      = aanvragen.reduce((sum, a) => sum + (SERVICE_PRIJS[a.volume] || 75), 0);
    const stortkosten = aanvragen.reduce((sum, a) => {
      const m3 = VOLUME_M3[a.volume] || 2;
      const tarief = STORTKOSTEN[a.soort] ?? 35;
      return sum + (m3 * tarief);
    }, 0);
    const winst = omzet - huurTotaal - stortkosten;

    // ── Google Maps route optimalisatie ──
    let geoptimaliseerdeRoute = null;
    try {
      const adressen = aanvragen.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
      const origin = 'Brunssum, Nederland';

      const routeRes = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(origin)}&waypoints=optimize:true|${adressen.map(a => encodeURIComponent(a)).join('|')}&key=${process.env.GOOGLE_MAPS_API_KEY}`
      );
      const routeData = await routeRes.json();

      if (routeData.status === 'OK') {
        const volgorde = routeData.routes[0].waypoint_order;
        geoptimaliseerdeRoute = volgorde.map(i => aanvragen[i]);
        const legs = routeData.routes[0].legs;
        const totaalKm = legs.reduce((sum, l) => sum + l.distance.value, 0) / 1000;
        const totaalTijd = legs.reduce((sum, l) => sum + l.duration.value, 0) / 60;
        geoptimaliseerdeRoute._km = Math.round(totaalKm);
        geoptimaliseerdeRoute._minuten = Math.round(totaalTijd);
      }
    } catch (routeErr) {
      console.error('Google Maps fout:', routeErr);
    }

    const routeVolgorde = geoptimaliseerdeRoute || aanvragen;

    // ── Claude briefing ──
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stopsText = routeVolgorde.map((a, i) =>
      `Stop ${i + 1}: ${a.voornaam} ${a.achternaam}
  Adres: ${a.straat}, ${a.postcode} ${a.plaats}
  Volume: ${a.volume} (~${VOLUME_M3[a.volume] || 2} m³)
  Soort afval: ${a.soort || 'onbekend'}
  Ruimte: ${a.ruimte}
  ${a.opmerking ? `Opmerking: ${a.opmerking}` : ''}
  Tel: ${a.telefoon || 'niet opgegeven'}`
    ).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Je bent de planner van Dumpservice Zuid-Limburg. Schrijf een korte, praktische dagbriefing voor Sjoerd en Daniël.

Vertrek: 08:00 vanuit Brunssum
Voertuig: ${voertuig.naam} (${voertuig.beschrijving})
Totaal volume: ${totaalM3.toFixed(1)} m³
Aantal stops: ${routeVolgorde.length}
${geoptimaliseerdeRoute?._km ? `Geschatte rijafstand: ${geoptimaliseerdeRoute._km} km` : ''}
${geoptimaliseerdeRoute?._minuten ? `Geschatte rijtijd: ${geoptimaliseerdeRoute._minuten} min` : ''}

STOPS (in rijvolgorde):
${stopsText}

Schrijf:
1. Korte intro (1 zin)
2. Per stop: naam, adres, wat verwachten, aandachtspunten
3. Praktische tips voor de dag
4. Schatting eindtijd

Bondig, direct, geen poespas. Nederlands.`
      }]
    });

    const briefing = msg.content[0].text;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        datum: aanvragen[0]?.datum || 'Aankomende zaterdag',
        aantalAanvragen: aanvragen.length,
        totaalM3: totaalM3.toFixed(1),
        voertuig: {
          naam: voertuig.naam,
          beschrijving: voertuig.beschrijving,
          huurprijs: voertuig.huurprijs,
          verzekering: VERZEKERING_PER_DAG,
          kmKosten: Math.round(GESCHATTE_KM * KM_PRIJS),
          totaalHuur: Math.round(huurTotaal),
        },
        financieel: {
          omzet,
          stortkosten: Math.round(stortkosten),
          huurkosten: Math.round(huurTotaal),
          winst: Math.round(winst),
          winstPerPersoon: Math.round(winst / 2),
        },
        route: routeVolgorde.map((a, i) => ({
          stop: i + 1,
          naam: `${a.voornaam} ${a.achternaam}`,
          adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
          telefoon: a.telefoon,
          volume: a.volume,
          m3: VOLUME_M3[a.volume] || 2,
          soort: a.soort,
          ruimte: a.ruimte,
          opmerking: a.opmerking,
        })),
        briefing,
        googleMapsLink: `https://www.google.com/maps/dir/Brunssum/${routeVolgorde.map(a => encodeURIComponent(`${a.straat}, ${a.postcode} ${a.plaats}`)).join('/')}/Brunssum`,
      })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Serverfout', detail: err.message }) };
  }
};
