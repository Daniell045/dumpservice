const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Methode niet toegestaan' }) };
  }

  const password = JSON.parse(event.body || '{}').password;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  try {
    const store = getStore({
      name: 'aanvragen',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const { blobs } = await store.list();
    let afgerond = 0;

    for (const blob of blobs) {
      try {
        const item = await store.get(blob.key, { type: 'json' });
        if (item && item.status !== 'afgerond') {
          await store.setJSON(blob.key, { ...item, status: 'afgerond', afgerondOp: new Date().toISOString() });
          afgerond++;
        }
      } catch {}
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, afgerond }),
    };

  } catch (err) {
    console.error('Afronden fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Serverfout', detail: err.message }) };
  }
};
