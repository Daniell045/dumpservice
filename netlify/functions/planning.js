const { getStore } = require('@netlify/blobs');
const Anthropic = require('@anthropic-ai/sdk');

const VOERTUIGEN = [
  { naam: 'Kleine bestelwagen',      maxM3: 6,  huurprijs: 24.50, beschrijving: 'tot 6 m³' },
  { naam: 'Middelgrote bus',         maxM3: 10, huurprijs: 34.30, beschrijving: 'tot 10 m³' },
  { naam: 'Grote transportbus',      maxM3: 17, huurprijs: 41.30, beschrijving: 'tot 17 m³' },
  { naam: 'Verhuiswagen + laadklep', maxM3: 30, huurprijs: 64.40, beschrijving: 'groot volume' },
];

const VERZEKERING_PER_DAG    = 19;
const KM_PRIJS               = 0.21;
const GESCHATTE_KM_PER_ROUTE = 80;
const START_TIJD             = 8 * 60;  // 08:00 in minuten
const MAX_EINDTIJD           = 18 * 60; // 18:00 max
const MINUTEN_PER_STOP       = 25;
const MINUTEN_NAAR_STORT     = 20;

const VOLUME_M3 = { klein: 0.75, middel: 2, groot: 4.5, onbekend: 2 };
const SERVICE_PRIJS = { klein: 45, middel: 75, groot: 120, onbekend: 75 };
const STORTKOSTEN = {
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

function berekenRondeInfo(aantalStops, rijtijdMinuten) {
  const rijtijd = rijtijdMinuten || 60;
  const tijdRonde1 = rijtijd + (aantalStops * MINUTEN_PER_STOP) + MINUTEN_NAAR_STORT + 30;
  const eindtijdRonde1 = START_TIJD + tijdRonde1;
  const beschikbaar = MAX_EINDTIJD - eindtijdRonde1;
  const extraStops = Math.max(0, Math.floor(beschikbaar / (MINUTEN_PER_STOP + 10)));
  const uurStr = (min) => `${Math.floor(min / 60).toString().padStart(2,'0')}:${(min % 60).toString().padStart(2,'0')}`;
  return {
    eindtijdRonde1Str: uurStr(Math.min(eindtijdRonde1, MAX_EINDTIJD)),
    beschikbareMinuten: Math.max(0, beschikbaar),
    extraStopsMogelijk: extraStops,
    tweedeRondeAdvies: extraStops >= 2,
  };
}

async function optimaliseerRoute(adressen, apiKey) {
  if (!apiKey || adressen.length === 0) return null;
  try {
    const origin = encodeURIComponent('Brunssum, Nederland');
    const waypoints = adressen.map(a => encodeURIComponent(a)).join('|');
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${origin}&waypoints=optimize:true|${waypoints}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    const legs = data.routes[0].legs;
    return {
      volgorde: data.routes[0].waypoint_order,
      km: Math.round(legs.reduce((s, l) => s + l.distance.value, 0) / 1000),
      minuten: Math.round(legs.reduce((s, l) => s + l.duration.value, 0) / 60),
    };
  } catch (e) {
    console.error('Google Maps fout:', e.message);
    return null;
  }
}

async function maakBriefing(client, naam, voertuig, stops, km, minuten, rondeInfo) {
  const stopsText = stops.map((a, i) => {
    const m3 = VOLUME_M3[a.volume] || 2;
    return `Stop ${i + 1}: ${a.voornaam} ${a.achternaam}
  Adres: ${a.straat}, ${a.postcode} ${a.plaats}
  Volume: ${a.volume} (~${m3} m³) | Soort: ${a.soort || 'onbekend'}
  Ruimte: ${a.ruimte}${a.opmerking ? ` | Opmerking: ${a.opmerking}` : ''}
  Tel: ${a.telefoon || 'niet opgegeven'}`;
  }).join('\n\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `Je bent de planner van Dumpservice Zuid-Limburg. Schrijf een persoonlijke dagbriefing voor ${naam}.

Vertrek: 08:00 vanuit Brunssum
Voertuig: ${voertuig.naam} (max ${voertuig.maxM3} m³)
Stops: ${stops.length}${km ? ` | ~${km} km` : ''}${minuten ? ` | ~${minuten} min rijden` : ''}
Verwachte eindtijd ronde 1: ${rondeInfo.eindtijdRonde1Str}

STOPS (rijvolgorde):
${stopsText}

Schrijf:
1. Korte persoonlijke intro voor ${naam} (1 zin)
2. Per stop: naam, adres, wat verwachten, aandachtspunten
3. Wanneer is de bus vol op basis van cumulatief volume
4. ${rondeInfo.tweedeRondeAdvies ? `Advies tweede ronde: JA — nog ~${rondeInfo.beschikbareMinuten} min, ~${rondeInfo.extraStopsMogelijk} extra stops mogelijk na de stort` : `Advies tweede ronde: NEE — te weinig tijd na ${rondeInfo.eindtijdRonde1Str}`}
5. Praktische tips
6. Geschatte eindtijd

Bondig, direct, Nederlands.`,
    }],
  });
  return msg.content[0].text;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Auth
  const password = event.queryStringParameters?.password
    || (event.body ? JSON.parse(event.body).password : null);
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  try {
    // ── Aanvragen ophalen ──
    const store = getStore({
      name: 'aanvragen',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

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

    // ── Routes splitsen ──
    const totaalM3 = aanvragen.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const tweePersoons = totaalM3 > 10 && aanvragen.length > 4;

    let route1 = aanvragen;
    let route2 = [];

    if (tweePersoons) {
      const gesorteerd = [...aanvragen].sort((a, b) => (a.postcode || '').localeCompare(b.postcode || ''));
      const helft = Math.ceil(gesorteerd.length / 2);
      route1 = gesorteerd.slice(0, helft);
      route2 = gesorteerd.slice(helft);
    }

    const m3R1 = route1.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const m3R2 = route2.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const voertuig1 = kiesVoertuig(m3R1);
    const voertuig2 = tweePersoons ? kiesVoertuig(m3R2) : null;

    // ── Financiën ──
    const omzet = aanvragen.reduce((s, a) => s + (SERVICE_PRIJS[a.volume] || 75), 0);
    const stortkosten = aanvragen.reduce((s, a) => {
      return s + ((VOLUME_M3[a.volume] || 2) * (STORTKOSTEN[a.soort] ?? 35));
    }, 0);
    const huur1 = voertuig1.huurprijs + VERZEKERING_PER_DAG + (GESCHATTE_KM_PER_ROUTE * KM_PRIJS);
    const huur2 = voertuig2 ? voertuig2.huurprijs + VERZEKERING_PER_DAG + (GESCHATTE_KM_PER_ROUTE * KM_PRIJS) : 0;
    const huurTotaal = huur1 + huur2;
    const winst = omzet - huurTotaal - stortkosten;

    // ── Google Maps ──
    const adr1 = route1.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const adr2 = route2.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const [gmap1, gmap2] = await Promise.all([
      optimaliseerRoute(adr1, process.env.GOOGLE_MAPS_API_KEY),
      tweePersoons ? optimaliseerRoute(adr2, process.env.GOOGLE_MAPS_API_KEY) : Promise.resolve(null),
    ]);

    const stopsR1 = gmap1 ? gmap1.volgorde.map(i => route1[i]) : route1;
    const stopsR2 = gmap2 ? gmap2.volgorde.map(i => route2[i]) : route2;

    // ── Ronde info ──
    const rondeInfo1 = berekenRondeInfo(stopsR1.length, gmap1?.minuten);
    const rondeInfo2 = tweePersoons ? berekenRondeInfo(stopsR2.length, gmap2?.minuten) : null;

    // ── Briefings via Claude ──
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const [briefingSjoerd, briefingDaniel] = await Promise.all([
      maakBriefing(client, 'Sjoerd', voertuig1, stopsR1, gmap1?.km, gmap1?.minuten, rondeInfo1),
      tweePersoons
        ? maakBriefing(client, 'Daniël', voertuig2, stopsR2, gmap2?.km, gmap2?.minuten, rondeInfo2)
        : Promise.resolve(null),
    ]);

    const mapsLink = (stops) =>
      `https://www.google.com/maps/dir/Brunssum/${stops.map(a => encodeURIComponent(`${a.straat}, ${a.postcode} ${a.plaats}`)).join('/')}/Brunssum`;

    const formatStop = (a, i) => ({
      stop: i + 1,
      naam: `${a.voornaam} ${a.achternaam}`,
      adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
      telefoon: a.telefoon || null,
      volume: a.volume,
      m3: VOLUME_M3[a.volume] || 2,
      soort: a.soort || null,
      ruimte: a.ruimte,
      opmerking: a.opmerking || null,
    });

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
          m3: m3R1.toFixed(1),
          km: gmap1?.km || null,
          minuten: gmap1?.minuten || null,
          rondeInfo: rondeInfo1,
          stops: stopsR1.map(formatStop),
          briefing: briefingSjoerd,
          googleMapsLink: mapsLink(stopsR1),
        },
        daniel: tweePersoons ? {
          voertuig: voertuig2,
          m3: m3R2.toFixed(1),
          km: gmap2?.km || null,
          minuten: gmap2?.minuten || null,
          rondeInfo: rondeInfo2,
          stops: stopsR2.map(formatStop),
          briefing: briefingDaniel,
          googleMapsLink: mapsLink(stopsR2),
        } : null,
      }),
    };

  } catch (err) {
    console.error('Planning fout:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Serverfout', detail: err.message }),
    };
  }
};
