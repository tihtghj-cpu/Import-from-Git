import { getStore } from "@netlify/blobs";

const MAX_BYTES = 5.5 * 1024 * 1024; // Netlify Function request limit ~6MB
const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function makeKey(fileName, ext) {
  const base =
    fileName
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 24) || "image";
  return `${Date.now().toString(36)}-${base}.${ext}`;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = getStore("images");

  // ---------- পাবলিক: ছবি দেখানো ----------
  if (req.method === "GET" && path.startsWith("/uploads/")) {
    const key = decodeURIComponent(path.slice("/uploads/".length));
    if (!/^[a-z0-9._-]+$/i.test(key)) return new Response("Not found", { status: 404 });
    const res = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!res) return new Response("Not found", { status: 404 });
    return new Response(res.data, {
      headers: {
        "content-type": res.metadata?.type || "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // ---------- অ্যাডমিন API (পাসওয়ার্ড লাগবে) ----------
  const pass = Netlify.env.get("ADMIN_PASSWORD");
  if (!pass) {
    return json({ error: "Netlify-তে ADMIN_PASSWORD এনভায়রনমেন্ট ভেরিয়েবল সেট করা হয়নি" }, 500);
  }
  if (req.headers.get("x-admin-key") !== pass) {
    return json({ error: "unauthorized" }, 401);
  }

  // তালিকা
  if (req.method === "GET" && path === "/api/images") {
    const { blobs } = await store.list();
    const items = (
      await Promise.all(
        blobs.map(async (b) => {
          const m = await store.getMetadata(b.key);
          return m ? { key: b.key, ...m.metadata } : null;
        })
      )
    ).filter(Boolean);
    items.sort((a, b) => (b.added || 0) - (a.added || 0));
    return json({ items });
  }

  // আপলোড
  if (req.method === "POST" && path === "/api/images") {
    const type = (req.headers.get("content-type") || "").split(";")[0].trim();
    const ext = EXT[type];
    if (!ext) return json({ error: "শুধু JPG, PNG, GIF, WEBP, AVIF সমর্থিত" }, 400);

    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return json({ error: "ছবি অনেক বড় (সর্বোচ্চ ~5MB)" }, 413);

    let name = "image";
    try { name = decodeURIComponent(req.headers.get("x-file-name") || "image"); } catch {}
    const key = makeKey(name, ext);
    const metadata = {
      name,
      type,
      size: buf.byteLength,
      width: Number(req.headers.get("x-width")) || 0,
      height: Number(req.headers.get("x-height")) || 0,
      added: Date.now(),
    };
    await store.set(key, buf, { metadata });
    return json({ item: { key, ...metadata } }, 201);
  }

  // মুছে ফেলা
  if (req.method === "DELETE" && path.startsWith("/api/images/")) {
    const key = decodeURIComponent(path.slice("/api/images/".length));
    if (!/^[a-z0-9._-]+$/i.test(key)) return json({ error: "invalid key" }, 400);
    await store.delete(key);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config = {
  path: ["/uploads/*", "/api/images", "/api/images/*"],
};
