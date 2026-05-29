import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const data = await req.json();

    // Valideer verplichte velden
    const vereist = ["voornaam", "achternaam", "email", "straat", "postcode", "plaats", "ruimte", "volume"];
    for (const veld of vereist) {
      if (!data[veld]?.trim()) {
        return new Response(JSON.stringify({ error: `Veld '${veld}' is verplicht` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const store = getStore("aanvragen");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await store.setJSON(id, {
      ...data,
      id,
      timestamp: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ success: true, id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Fout bij opslaan aanvraag:", err);
    return new Response(JSON.stringify({ error: "Interne serverfout" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/aanvraag" };
