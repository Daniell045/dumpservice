import { getStore } from "@netlify/blobs";

const VOLUME_M3 = { klein: 0.75, middel: 2, groot: 4.5, onbekend: 2 };
const MAX_M3 = 24;

export default async () => {
  try {
    const store = getStore("aanvragen");
    const { blobs } = await store.list();

    const aanvragen = await Promise.all(
      blobs.map(async ({ key }) => {
        try { return await store.get(key, { type: "json" }); } catch { return null; }
      })
    );

    const totaalM3 = aanvragen
      .filter(Boolean)
      .reduce((s, a) => s + (VOLUME_M3[a.volume] || 2), 0);

    const plekken = Math.max(0, Math.round((MAX_M3 - totaalM3) / 2));

    return new Response(JSON.stringify({ plekken, totaalM3 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ plekken: 0, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/capaciteit" };
