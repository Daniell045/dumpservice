const { getStore } = require('@netlify/blobs');
const Anthropic = require('@anthropic-ai/sdk');

const VOERTUIGEN = [
  { naam: 'Kleine bestelwagen', maxM3: 6,  huurprijs: 24.50, beschrijving: 'tot 6 m³' },
  { naam: 'Middelgrote bus',    maxM3: 10, huurprijs: 34.30, beschrijving: 'tot 10 m³' },
  { naam: 'Grote transportbus', maxM3: 17, huurprijs: 41.30, beschrijving: 'tot 17 m³' },
  { naam: 'Verhuiswagen + laadklep', maxM3: 30, huurprijs: 64.40, beschrijving: 'groot volume' },
];

const VERZEKERING_PER_DAG = 19;
const KM_PRIJS = 0.21;
const GESCHATTE_KM_PER_ROUTE = 80;
const START_TIJD = 8 * 60; // 08:00 in minuten
const MAX_EINDTIJD = 18 * 60; // 18:00 max
const MINUTEN_PER_STOP = 25; // laadtijd per klant
const MINUTEN_NAAR_STORT = 20; // rijden naar RD4

const VOLUME_M3     = { klein: 0.75, middel: 2, groot: 4.5, onbekend: 2 };
const SERVICE_PRIJS = { klein: 45,   middel: 75, groot: 120, onbekend: 75 };
const STORTKOSTEN   = {
  'Grofvuil / meubels': 35,
  'Bouwafval / puin':   100,
  'Hout':               20,
  'Gemengd':            35,
  'Elektronica':        0,
  'Anders / combinatie': 35,
};

function kiesVoertuig(m3) {
  return VOERTUIGEN.find(v => v.maxM3 >= m3) || VOERTUIGEN[VOERTUIGEN.length - 1];
}

function bereken2eRonde(voertuig, aantalStops, rijtijdMinuten) {
  const tijdRonde1 = (rijtijdMinuten || 60) + (aantalStops * MINUTEN_PER_STOP) + MINUTEN_NAAR_STORT + 30;
  const eindtijdRonde1 = START_TIJD + tijdRonde1;
  const beschikbareTijd = MAX_EINDTIJD - eindtijdRonde1;
  const extraStopsMogelijk = Math.floor(beschikbareTijd / (MINUTEN_PER_STOP + 10));
  return {
    eindtijdRonde1Str: `${Math.floor(eindtijdRonde1/60).toString().padStart(2,'0')}:${(eindtijdRonde1%60).toString().padStart(2,'0')}`,
    beschikbareMinuten: Math.max(0, beschikbareTijd),
    extraStopsMogelijk: Math.max(0, extraStopsMogelijk),
    tweedeRondeAdvies: extraStopsMogelijk >= 2,
  };
}

async function optimaliseerRoute(adressen, apiKey) {
  if (!apiKey || adressen.length === 0) return null;
  try {
    const origin = 'Brunssum, Nederland';
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(origin)}&waypoints=optimize:true|${adressen.map(a => encodeURIComponent(a)).join('|')}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    const volgorde = data.routes[0].waypoint_order;
    const legs = data.routes[0].legs;
    return {
      volgorde,
      km: Math.round(legs.reduce((s, l) => s + l.distance.value, 0) / 1000),
      minuten: Math.round(legs.reduce((s, l) => s + l.duration.value, 0) / 60),
    };
  } catch { return null; }
}

async function maakBriefing(client, naam, voertuig, stops, km, minuten, rondeInfo) {
  const stopsText = stops.map((a, i) =>
    `Stop ${i + 1}: ${a.voornaam} ${a.achternaam}
  Adres: ${a.straat}, ${a.postcode} ${a.plaats}
  Volume: ${a.volume} (~${VOLUME_M3[a.volume] || 2} m³)
  Soort: ${a.soort || 'onbekend'}
  Ruimte: ${a.ruimte}
  ${a.opmerking ? `Opmerking: ${a.opmerking}` : ''}
  Tel: ${a.telefoon || 'niet opgegeven'}`
  ).join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `Je bent de planner van Dumpservice Zuid-Limburg. Schrijf een persoonlijke dagbriefing voor ${naam}.

Vertrek: 08:00 vanuit Brunssum
Voertuig: ${voertuig.naam} (max ${voertuig.maxM3} m³, ${voertuig.beschrijving})
Aantal stops: ${stops.length}
${km ? `Rijafstand: ~${km} km` : ''}
${minuten ? `Rijtijd: ~${minuten} min` : ''}
Geschatte eindtijd ronde 1: ${rondeInfo.eindtijdRonde1Str}
Beschikbare tijd na stort: ${rondeInfo.beschikbareMinuten} minuten
Mogelijke extra stops: ${rondeInfo.extraStopsMogelijk}

STOPS (in rijvolgorde):
${stopsText}

Schrijf:
1. Korte persoonlijke intro voor ${naam}
2. Per stop: naam, adres, wat verwachten, aandachtspunten
3. Wanneer is de bus vol? (op basis van volume per stop)
4. Advies over tweede ronde: ${rondeInfo.tweedeRondeAdvies ? `JA — er is nog ~${rondeInfo.beschikbareMinuten} min over, je kunt ~${rondeInfo.extraStopsMogelijk} extra stops doen na de stort` : 'NEE — niet genoeg tijd meer na de stort'}
5. Praktische tips
6. Schatting eindtijd

Bondig, direct, Nederlands. Geen poespas.`
    }]
  });
  return msg.content[0].text;
}

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
    const store = getStore('aanvragen');
    const { blobs } = await store.list();
    const aanvragen = [];
    for (const blob of blobs) {
      try {
        const item = await store.get(blob.key, { type: 'json' });
        if (item) aanvragen.push(item);
      } catch {}
    }

    if (aanvragen.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ bericht: 'Geen aanvragen gevonden.' }) };
    }

    const totaalM3 = aanvragen.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);

    // Beslissing: 1 of 2 routes
    // 2 routes alleen als totaal > 10 m³ EN meer dan 4 aanvragen
    const tweePersoons = totaalM3 > 10 && aanvragen.length > 4;

    let route1 = aanvragen;
    let route2 = [];

    if (tweePersoons) {
      const gesorteerd = [...aanvragen].sort((a, b) => (a.postcode || '').localeCompare(b.postcode || ''));
      const helft = Math.ceil(gesorteerd.length / 2);
      route1 = gesorteerd.slice(0, helft);
      route2 = gesorteerd.slice(helft);
    }

    const m3Route1 = route1.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const m3Route2 = route2.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);

    const voertuig1 = kiesVoertuig(m3Route1);
    const voertuig2 = tweePersoons ? kiesVoertuig(m3Route2) : null;

    const omzet = aanvragen.reduce((s, a) => s + (SERVICE_PRIJS[a.volume] || 75), 0);
    const stortkosten = aanvragen.reduce((s, a) => {
      const m3 = VOLUME_M3[a.volume] || 2;
      return s + (m3 * (STORTKOSTEN[a.soort] ?? 35));
    }, 0);
    const huurTotaal = (voertuig1.huurprijs + VERZEKERING_PER_DAG + GESCHATTE_KM_PER_ROUTE * KM_PRIJS)
      + (voertuig2 ? voertuig2.huurprijs + VERZEKERING_PER_DAG + GESCHATTE_KM_PER_ROUTE * KM_PRIJS : 0);
    const winst = omzet - huurTotaal - stortkosten;

    // Google Maps
    const adressen1 = route1.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const adressen2 = route2.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const [gmap1, gmap2] = await Promise.all([
      optimaliseerRoute(adressen1, process.env.GOOGLE_MAPS_API_KEY),
      tweePersoons ? optimaliseerRoute(adressen2, process.env.GOOGLE_MAPS_API_KEY) : Promise.resolve(null),
    ]);

    const stopsR1 = gmap1 ? gmap1.volgorde.map(i => route1[i]) : route1;
    const stopsR2 = gmap2 ? gmap2.volgorde.map(i => route2[i]) : route2;

    // Ronde info
    const rondeInfo1 = bereken2eRonde(voertuig1, stopsR1.length, gmap1?.minuten);
    const rondeInfo2 = tweePersoons ? bereken2eRonde(voertuig2, stopsR2.length, gmap2?.minuten) : null;

    // Briefings
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const [briefingSjoerd, briefingDaniel] = await Promise.all([
      maakBriefing(client, 'Sjoerd', voertuig1, stopsR1, gmap1?.km, gmap1?.minuten, rondeInfo1),
      tweePersoons
        ? maakBriefing(client, 'Daniël', voertuig2, stopsR2, gmap2?.km, gmap2?.minuten, rondeInfo2)
        : Promise.resolve(null),
    ]);

    const mapsLink = (stops) =>
      `https://www.google.com/maps/dir/Brunssum/${stops.map(a => encodeURIComponent(`${a.straat}, ${a.postcode} ${a.plaats}`)).join('/')}/Brunssum`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        datum: aanvragen[0]?.datum || 'Aankomende zaterdag',
        aantalAanvragen: aanvragen.length,
        totaalM3: totaalM3.toFixed(1),
        tweePersoons,
        financieel: {
          omzet,
          stortkosten: Math.round(stortkosten),
          huurkosten: Math.round(huurTotaal),
          winst: Math.round(winst),
          winstPerPersoon: Math.round(winst / 2),
        },
        sjoerd: {
          voertuig: voertuig1,
          m3: m3Route1.toFixed(1),
          rondeInfo: rondeInfo1,
          stops: stopsR1.map((a, i) => ({
            stop: i + 1,
            naam: `${a.voornaam} ${a.achternaam}`,
            adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
            telefoon: a.telefoon,
            volume: a.volume,
            soort: a.soort,
            ruimte: a.ruimte,
            opmerking: a.opmerking,
          })),
          briefing: briefingSjoerd,
          googleMapsLink: mapsLink(stopsR1),
          km: gmap1?.km,
          minuten: gmap1?.minuten,
        },
        daniel: tweePersoons ? {
          voertuig: voertuig2,
          m3: m3Route2.toFixed(1),
          rondeInfo: rondeInfo2,
          stops: stopsR2.map((a, i) => ({
            stop: i + 1,
            naam: `${a.voornaam} ${a.achternaam}`,
            adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
            telefoon: a.telefoon,
            volume: a.volume,
            soort: a.soort,
            ruimte: a.ruimte,
            opmerking: a.opmerking,
          })),
          briefing: briefingDaniel,
          googleMapsLink: mapsLink(stopsR2),
          km: gmap2?.km,
          minuten: gmap2?.minuten,
        } : null,
      })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Serverfout', detail: err.message }) };
  }
};
