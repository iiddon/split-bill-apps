/**
 * Split Bill Struk – server pembaca struk (Cloudflare Worker) · versi 2
 *
 * Menerima foto struk dari aplikasi, meneruskannya ke API Anthropic dengan API key
 * yang disimpan rahasia di sini, lalu mengembalikan hasil bacaan.
 * Versi 2: kode akses per orang, dikunci ke satu HP, dengan batas scan harian per orang.
 *
 * Variables and Secrets (Workers → splitbill → Settings):
 *   ANTHROPIC_API_KEY  (Secret)  API key dari console.anthropic.com
 *   ACCESS_CODE        (Secret)  kode akses pemilik (kamu). Tidak dikunci ke HP.
 *   ADMIN_CODE         (Secret)  kode admin untuk menu "Kelola kode akses" di aplikasi
 *   ALLOWED_ORIGIN     (Text)    alamat web app, mis. https://namakamu.github.io
 *   DAILY_LIMIT        (Text)    opsional, batas scan harian pemilik (default 50)
 *   USER_LIMIT         (Text)    opsional, batas scan harian default untuk kode teman (default 10)
 *   MODEL              (Text)    opsional, default claude-sonnet-5-5
 * Bindings: KV namespace dengan Variable name LIMITS (wajib untuk kode per orang).
 */

const PROMPT = "Kamu membaca foto struk/nota pembayaran (biasanya restoran di Indonesia).\nKembalikan HANYA JSON valid, tanpa teks lain, dengan bentuk:\n{\"merchant\":string|null,\n \"items\":[{\"name\":string,\"qty\":number,\"price\":number}],\n \"charges\":[{\"name\":string,\"amount\":number}],\n \"total\":number|null,\n \"tax_included_note\":string|null}\nAturan:\n- \"price\" = harga TOTAL baris item (qty × harga satuan, setelah diskon per item jika ada), dalam rupiah sebagai bilangan bulat tanpa titik/koma.\n- Angka Indonesia memakai titik sebagai pemisah ribuan: \"38.000\" = 38000.\n- \"charges\" berisi pajak dan biaya di luar item: PPN, PB1/pajak restoran, service charge, biaya kemasan, pembulatan. Diskon/voucher tingkat struk ditulis sebagai amount negatif.\n- Jangan masukkan subtotal, total, tunai/bayar, kembalian, atau metode pembayaran sebagai item atau charge.\n- Jika struk menyatakan harga sudah termasuk pajak (mis. \"PPN termasuk\"/\"incl. tax\"), JANGAN masukkan pajak itu ke charges; tulis keterangannya di tax_included_note.\n- Modifier/topping tanpa harga digabung ke nama item di atasnya; yang berharga jadikan item sendiri.\n- \"total\" = total akhir yang harus dibayar menurut struk, atau null jika tidak terbaca.\n- Jika gambar bukan struk, kembalikan {\"items\":[],\"charges\":[],\"total\":null,\"merchant\":null,\"tax_included_note\":\"bukan struk\"}.";
const MAX_B64 = 6_000_000;
const OWNER = "__owner__";
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa huruf/angka yang mirip (0/O, 1/I)

const today = () => new Date().toISOString().slice(0, 10);
const norm = c => String(c || "").trim().toUpperCase();

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
function cors(origin, env) {
  const list = allowedOrigins(env);
  return {
    "Access-Control-Allow-Origin": origin && list.includes(origin) ? origin : (list[0] || "null"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-access-code, x-device-id, x-admin-code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
function sameSecret(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function getJSON(kv, key) { const v = await kv.get(key); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function usedToday(kv, code) { return kv ? Number((await kv.get(`use:${code}:${today()}`)) || 0) : 0; }
async function addUse(kv, code) {
  if (!kv) return;
  const k = `use:${code}:${today()}`;
  await kv.put(k, String(Number((await kv.get(k)) || 0) + 1), { expirationTtl: 60 * 60 * 48 });
}

/* Who is calling? Returns {who} or {err,status}. */
async function identify(request, env) {
  const raw = request.headers.get("x-access-code");
  if (sameSecret(raw, env.ACCESS_CODE)) return { who: { code: OWNER, name: "Pemilik", limit: Number(env.DAILY_LIMIT || 50), owner: true } };
  const code = norm(raw);
  if (!code) return { err: "Isi kode akses di Pengaturan aplikasi.", status: 401 };
  if (!env.LIMITS) return { err: "Kode akses salah. Cek lagi di Pengaturan aplikasi.", status: 401 };
  const rec = await getJSON(env.LIMITS, "code:" + code);
  if (!rec) return { err: "Kode akses salah. Cek lagi di Pengaturan aplikasi.", status: 401 };
  if (rec.revoked) return { err: "Kode akses ini sudah dicabut. Hubungi pemilik aplikasi.", status: 403 };
  const dev = String(request.headers.get("x-device-id") || "");
  if (!/^[a-z0-9-]{8,64}$/i.test(dev)) return { err: "Perbarui aplikasi ke versi terbaru dulu.", status: 400 };
  if (rec.device && rec.device !== dev)
    return { err: "Kode ini sudah dipakai di HP lain. Minta kode baru atau reset ke pemilik aplikasi.", status: 403 };
  if (!rec.device) { rec.device = dev; rec.boundAt = new Date().toISOString(); await env.LIMITS.put("code:" + code, JSON.stringify(rec)); }
  return { who: { code, name: rec.name, limit: Number(rec.limit || env.USER_LIMIT || 10), rec } };
}

function newCode(name) {
  const pre = String(name || "").toUpperCase().normalize("NFD").replace(/[^A-Z]/g, "").slice(0, 6) || "TEMAN";
  const r = crypto.getRandomValues(new Uint8Array(4));
  return pre + "-" + Array.from(r, x => ALPH[x % ALPH.length]).join("");
}

async function admin(request, env, h) {
  if (!env.ADMIN_CODE) return reply({ error: "ADMIN_CODE belum diisi di server." }, 500, h);
  if (!sameSecret(request.headers.get("x-admin-code"), env.ADMIN_CODE)) return reply({ error: "Kode admin salah." }, 401, h);
  if (!env.LIMITS) return reply({ error: "Pasang KV namespace dengan nama LIMITS dulu di Cloudflare." }, 500, h);
  const kv = env.LIMITS;
  let q = {}; try { q = await request.json(); } catch (e) {}
  const code = norm(q.code);
  const key = "code:" + code;

  if (q.action === "list") {
    const codes = []; let cursor;
    do {
      const page = await kv.list({ prefix: "code:", cursor });
      for (const k of page.keys) {
        const rec = await getJSON(kv, k.name); if (!rec) continue;
        const c = k.name.slice(5);
        codes.push({ code: c, name: rec.name, limit: Number(rec.limit || env.USER_LIMIT || 10), bound: !!rec.device, boundAt: rec.boundAt || null,
          revoked: !!rec.revoked, createdAt: rec.createdAt, lastUsed: rec.lastUsed || null, total: rec.total || 0, today: await usedToday(kv, c) });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    codes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return reply({ ok: true, owner: { limit: Number(env.DAILY_LIMIT || 50), today: await usedToday(kv, OWNER) }, codes }, 200, h);
  }
  if (q.action === "create") {
    const name = String(q.name || "").trim().slice(0, 40);
    if (!name) return reply({ error: "Isi nama teman dulu." }, 400, h);
    let c = newCode(name);
    for (let i = 0; i < 5 && (await kv.get("code:" + c)); i++) c = newCode(name);
    const rec = { name, limit: Math.max(1, Math.min(500, Number(q.limit) || Number(env.USER_LIMIT || 10))), device: null, revoked: false, createdAt: new Date().toISOString(), total: 0 };
    await kv.put("code:" + c, JSON.stringify(rec));
    return reply({ ok: true, code: c }, 200, h);
  }
  const rec = code ? await getJSON(kv, key) : null;
  if (!rec) return reply({ error: "Kode tidak ditemukan." }, 404, h);
  if (q.action === "reset") { rec.device = null; rec.boundAt = null; }
  else if (q.action === "revoke") rec.revoked = true;
  else if (q.action === "restore") rec.revoked = false;
  else if (q.action === "limit") rec.limit = Math.max(1, Math.min(500, Number(q.limit) || 10));
  else if (q.action === "delete") { await kv.delete(key); return reply({ ok: true }, 200, h); }
  else return reply({ error: "Perintah tidak dikenal." }, 400, h);
  await kv.put(key, JSON.stringify(rec));
  return reply({ ok: true }, 200, h);
}

export default {
  async fetch(request, env) {
    const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
    const h = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (origin && !allowedOrigins(env).includes(origin))
      return reply({ error: "Alamat web app ini belum diizinkan. Cek ALLOWED_ORIGIN di server." }, 403, h);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "/admin") {
      if (request.method !== "POST") return reply({ error: "Metode tidak didukung." }, 405, h);
      return admin(request, env, h);
    }

    if (!env.ANTHROPIC_API_KEY || !env.ACCESS_CODE)
      return reply({ error: "Server belum lengkap: isi ANTHROPIC_API_KEY dan ACCESS_CODE." }, 500, h);
    const id = await identify(request, env);
    if (id.err) return reply({ error: id.err }, id.status, h);
    const who = id.who;

    if (request.method === "GET") {
      const used = await usedToday(env.LIMITS, who.code);
      return reply({ ok: true, name: who.name, owner: !!who.owner, limit: env.LIMITS ? who.limit : null, remaining: env.LIMITS ? Math.max(0, who.limit - used) : null }, 200, h);
    }
    if (request.method !== "POST") return reply({ error: "Metode tidak didukung." }, 405, h);

    const b64 = (await request.text()).trim();
    if (!b64 || b64.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      return reply({ error: "Foto tidak valid atau terlalu besar." }, 400, h);
    const used = await usedToday(env.LIMITS, who.code);
    if (env.LIMITS && used >= who.limit)
      return reply({ error: `Batas scan hari ini (${who.limit}) sudah habis. Coba lagi besok.` }, 429, h);
    const mediaType = b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("UklGR") ? "image/webp" : "image/jpeg";

    // Built by hand so the large image string is not re-parsed (keeps CPU time low on the free plan).
    const body = '{"model":' + JSON.stringify(env.MODEL || "claude-sonnet-5-5") +
      ',"max_tokens":2048,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"' + mediaType +
      '","data":"' + b64 + '"}},{"type":"text","text":' + JSON.stringify(PROMPT) + '}]}]}';
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body,
      });
    } catch (e) {
      return reply({ error: "Server tidak bisa menghubungi layanan pembaca struk. Coba lagi sebentar lagi." }, 502, h);
    }
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const t = (j && j.error && j.error.type) || "";
      const msg = r.status === 401 ? "API key Anthropic tidak valid. Cek ANTHROPIC_API_KEY."
        : /credit|billing/i.test(JSON.stringify(j)) ? "Saldo API Anthropic habis. Isi ulang di console.anthropic.com."
        : r.status === 429 || r.status === 529 || t === "overloaded_error" ? "Layanan pembaca struk sedang sibuk. Coba lagi sebentar lagi."
        : "Struk gagal dibaca (kode " + r.status + ").";
      return reply({ error: msg }, 502, h);
    }
    // count only successful reads
    if (env.LIMITS) {
      await addUse(env.LIMITS, who.code);
      if (who.rec) { who.rec.total = (who.rec.total || 0) + 1; who.rec.lastUsed = new Date().toISOString(); await env.LIMITS.put("code:" + who.code, JSON.stringify(who.rec)); }
    }
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return reply({ text, remaining: env.LIMITS ? Math.max(0, who.limit - used - 1) : null }, 200, h);
  },
};
