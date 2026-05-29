import { getStore } from "@netlify/blobs";

export default async (req) => {
  const auth = req.headers.get("x-admin-password");
  if (auth !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Niet geautoriseerd" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const store = getStore("aanvragen");
    const { blobs } = await store.list();

    const aanvragen = await Promise.all(
      blobs.map(async ({ key }) => {
        try { return await store.get(key, { type: "json" }); } catch { return null; }
      })
    );

    const gesorteerd = aanvragen
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return new Response(JSON.stringify({ aanvragen: gesorteerd }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Fout bij ophalen aanvragen:", err);
    return new Response(JSON.stringify({ error: "Interne serverfout" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/aanvragen" };
