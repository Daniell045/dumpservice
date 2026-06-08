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
const START_TIJD             = 8 * 60;
const MAX_EINDTIJD           = 18 * 60;
const MINUTEN_PER_STOP       = 25;
const MINUTEN_NAAR_STORT     = 20;
const MIN_WINST_PER_RIT      = 50; // minimale winst per rit om het te doen

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

// Weken wachttijd per aanvraag berekenen
function aantalWekenWachten(timestamp) {
  if (!timestamp) return 0;
  const nu = new Date();
  const aangemeld = new Date(timestamp);
  return Math.floor((nu - aangemeld) / (7 * 24 * 60 * 60 * 1000));
}

function kiesVoertuig(m3) {
  return VOERTUIGEN.find(v => v.maxM3 >= m3) || VOERTUIGEN[VOERTUIGEN.length - 1];
}

function berekenFinancien(geselecteerd, tweePersoons) {
  const totaalM3 = geselecteerd.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
  const omzet = geselecteerd.reduce((s, a) => s + (SERVICE_PRIJS[a.volume] || 75), 0);
  const stortkosten = geselecteerd.reduce((s, a) => {
    return s + ((VOLUME_M3[a.volume] || 2) * (STORTKOSTEN[a.soort] ?? 35));
  }, 0);
  const aantalVoertuigen = tweePersoons ? 2 : 1;
  const voertuig = kiesVoertuig(tweePersoons ? totaalM3 / 2 : totaalM3);
  const huurPerVoertuig = voertuig.huurprijs + VERZEKERING_PER_DAG + (GESCHATTE_KM_PER_ROUTE * KM_PRIJS);
  const huurTotaal = huurPerVoertuig * aantalVoertuigen;
  const winst = omzet - huurTotaal - stortkosten;
  return { totaalM3, omzet, stortkosten: Math.round(stortkosten), huurTotaal: Math.round(huurTotaal), winst: Math.round(winst), voertuig };
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
  Tel: ${a.telefoon || 'niet opgegeven'}
  Volume: ${a.volume} (~${m3} m³) | Soort: ${a.soort || 'onbekend'}
  Ruimte: ${a.ruimte}${a.opmerking ? ` | Opmerking: ${a.opmerking}` : ''}`;
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

async function maakKlantMail(client, geselecteerd, datum) {
  const namen = geselecteerd.map(a => a.voornaam).join(', ');
  const adressen = geselecteerd.map(a => `- ${a.voornaam} ${a.achternaam}, ${a.straat} ${a.plaats}`).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Schrijf een korte, vriendelijke mail namens Dumpservice Zuid-Limburg naar de volgende klanten:
${adressen}

De mail is voor ophaaldag: ${datum}

De mail moet:
- Persoonlijk en informeel zijn (geen "geachte")
- Bevestigen dat we langskomen op ${datum}
- Vragen of ze de spullen klaar kunnen zetten buiten
- Zeggen dat we 's ochtends contact opnemen met een tijdsindicatie
- Eindigen met Sjoerd & Daniël van Dumpservice

Schrijf de mail zodat je hem makkelijk kan aanpassen. Gebruik [NAAM] als placeholder voor de naam van de klant.
Houd het kort — max 5 regels tekst.`,
    }],
  });
  return msg.content[0].text;
}

async function maakSelectieAdvies(client, alleAanvragen) {
  const aanvraagInfo = alleAanvragen.map((a, i) => {
    const weken = aantalWekenWachten(a.timestamp);
    const m3 = VOLUME_M3[a.volume] || 2;
    const omzet = SERVICE_PRIJS[a.volume] || 75;
    const stortK = m3 * (STORTKOSTEN[a.soort] ?? 35);
    return `${i + 1}. ${a.voornaam} ${a.achternaam} | ${a.postcode} ${a.plaats} | ${a.volume} (${m3}m³) | Soort: ${a.soort || 'onbekend'} | Service: €${omzet} | Wacht: ${weken} weken${a.opmerking ? ` | Opmerking: ${a.opmerking}` : ''}`;
  }).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Je bent de planner van Dumpservice Zuid-Limburg. Analyseer deze aanvragen en geef advies over welke je het beste samen kunt oppakken.

ALLE AANVRAGEN:
${aanvraagInfo}

Voertuigcapaciteit: max 17 m³ per bus (liefst 1 bus, max 3)
Startlocatie: Brunssum
Max werkdag: 08:00-18:00

Geef advies:
1. Welke combinatie van aanvragen is het meest rendabel EN logistiek slim?
2. Zijn er aanvragen die te lang wachten (>3 weken) en prioriteit verdienen?
3. Zijn er aanvragen die je beter kunt overslaan of doorschuiven (te ver, te weinig marge)?
4. Hoeveel bussen adviseer je?

Wees direct en concreet. Noem namen. Max 200 woorden.`,
    }],
  });
  return msg.content[0].text;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const password = event.queryStringParameters?.password
    || (event.body ? JSON.parse(event.body).password : null);
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  // Optioneel: geselecteerde IDs meegeven vanuit admin
  const body = event.body ? JSON.parse(event.body) : {};
  const geselecteerdeIds = body.geselecteerdeIds || null;
  const ophaalDatum = body.datum || 'aankomende zaterdag';

  try {
    const store = getStore({
      name: 'aanvragen',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const { blobs } = await store.list();
    const alleAanvragen = [];
    for (const blob of blobs) {
      try {
        const item = await store.get(blob.key, { type: 'json' });
        if (item && item.status !== 'afgerond') alleAanvragen.push(item);
      } catch {}
    }

    if (alleAanvragen.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ bericht: 'Geen openstaande aanvragen gevonden.' }) };
    }

    // Sorteer op wachttijd (oudste eerst)
    alleAanvragen.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Als admin specifieke IDs heeft geselecteerd, gebruik die — anders gebruik alle
    const geselecteerd = geselecteerdeIds
      ? alleAanvragen.filter(a => geselecteerdeIds.includes(a.id))
      : alleAanvragen;

    if (geselecteerd.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ bericht: 'Geen aanvragen gevonden met die IDs.' }) };
    }

    // AI selectie advies (altijd op basis van alle aanvragen)
    const selectieAdvies = await maakSelectieAdvies(client, alleAanvragen);

    // Financiën berekenen
    const totaalM3 = geselecteerd.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const tweePersoons = totaalM3 > 10 && geselecteerd.length > 4;
    const fin = berekenFinancien(geselecteerd, tweePersoons);

    // Routes splitsen
    let route1 = geselecteerd;
    let route2 = [];
    if (tweePersoons) {
      const gesorteerd = [...geselecteerd].sort((a, b) => (a.postcode || '').localeCompare(b.postcode || ''));
      const helft = Math.ceil(gesorteerd.length / 2);
      route1 = gesorteerd.slice(0, helft);
      route2 = gesorteerd.slice(helft);
    }

    const m3R1 = route1.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const m3R2 = route2.reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);
    const voertuig1 = kiesVoertuig(m3R1);
    const voertuig2 = tweePersoons ? kiesVoertuig(m3R2) : null;

    // Google Maps
    const adr1 = route1.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const adr2 = route2.map(a => `${a.straat}, ${a.postcode} ${a.plaats}, Nederland`);
    const [gmap1, gmap2] = await Promise.all([
      optimaliseerRoute(adr1, process.env.GOOGLE_MAPS_API_KEY),
      tweePersoons ? optimaliseerRoute(adr2, process.env.GOOGLE_MAPS_API_KEY) : Promise.resolve(null),
    ]);

    const stopsR1 = gmap1 ? gmap1.volgorde.map(i => route1[i]) : route1;
    const stopsR2 = gmap2 ? gmap2.volgorde.map(i => route2[i]) : route2;

    const rondeInfo1 = berekenRondeInfo(stopsR1.length, gmap1?.minuten);
    const rondeInfo2 = tweePersoons ? berekenRondeInfo(stopsR2.length, gmap2?.minuten) : null;

    // Briefings + klantmail parallel
    const [briefingSjoerd, briefingDaniel, klantMail] = await Promise.all([
      maakBriefing(client, 'Sjoerd', voertuig1, stopsR1, gmap1?.km, gmap1?.minuten, rondeInfo1),
      tweePersoons
        ? maakBriefing(client, 'Daniël', voertuig2, stopsR2, gmap2?.km, gmap2?.minuten, rondeInfo2)
        : Promise.resolve(null),
      maakKlantMail(client, geselecteerd, ophaalDatum),
    ]);

    const mapsLink = (stops) =>
      `https://www.google.com/maps/dir/Brunssum/${stops.map(a => encodeURIComponent(`${a.straat}, ${a.postcode} ${a.plaats}`)).join('/')}/Brunssum`;

    const formatStop = (a, i) => ({
      stop: i + 1,
      id: a.id,
      naam: `${a.voornaam} ${a.achternaam}`,
      adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
      telefoon: a.telefoon || null,
      email: a.email || null,
      volume: a.volume,
      m3: VOLUME_M3[a.volume] || 2,
      soort: a.soort || null,
      ruimte: a.ruimte,
      opmerking: a.opmerking || null,
      weken: aantalWekenWachten(a.timestamp),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        aantalAanvragen: alleAanvragen.length,
        aantalGeselecteerd: geselecteerd.length,
        totaalM3: totaalM3.toFixed(1),
        tweePersoons,
        selectieAdvies,
        klantMail,
        financieel: {
          omzet: fin.omzet,
          stortkosten: fin.stortkosten,
          huurkosten: fin.huurTotaal,
          winst: fin.winst,
          winstPerPersoon: Math.round(fin.winst / 2),
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
        overigeAanvragen: geselecteerdeIds
          ? alleAanvragen.filter(a => !geselecteerdeIds.includes(a.id)).map(a => ({
              id: a.id,
              naam: `${a.voornaam} ${a.achternaam}`,
              adres: `${a.straat}, ${a.postcode} ${a.plaats}`,
              volume: a.volume,
              weken: aantalWekenWachten(a.timestamp),
            }))
          : [],
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
