/**
 * Split Bill Struk – server pembaca struk (Cloudflare Worker)
 *
 * Menerima foto struk dari web app, meneruskannya ke API Anthropic (Claude)
 * dengan API key yang disimpan rahasia di sini, lalu mengembalikan hasil bacaan.
 *
 * Pengaturan (Workers → splitbill → Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  (Secret)  API key dari console.anthropic.com
 *   ACCESS_CODE        (Secret)  kode akses buatanmu, diisi juga di Pengaturan aplikasi
 *   ALLOWED_ORIGIN     (Text)    alamat web app, mis. https://namakamu.github.io
 *                                (boleh lebih dari satu, pisahkan dengan koma)
 *   DAILY_LIMIT        (Text)    opsional, batas scan per hari (default 50)
 *   MODEL              (Text)    opsional, default claude-sonnet-5-5
 * Opsional: hubungkan KV namespace dengan nama binding LIMITS supaya batas harian berlaku.
 */

const PROMPT = "Kamu membaca foto struk/nota pembayaran (biasanya restoran di Indonesia).\nKembalikan HANYA JSON valid, tanpa teks lain, dengan bentuk:\n{\"merchant\":string|null,\n \"items\":[{\"name\":string,\"qty\":number,\"price\":number}],\n \"charges\":[{\"name\":string,\"amount\":number}],\n \"total\":number|null,\n \"tax_included_note\":string|null}\nAturan:\n- \"price\" = harga TOTAL baris item (qty × harga satuan, setelah diskon per item jika ada), dalam rupiah sebagai bilangan bulat tanpa titik/koma.\n- Angka Indonesia memakai titik sebagai pemisah ribuan: \"38.000\" = 38000.\n- \"charges\" berisi pajak dan biaya di luar item: PPN, PB1/pajak restoran, service charge, biaya kemasan, pembulatan. Diskon/voucher tingkat struk ditulis sebagai amount negatif.\n- Jangan masukkan subtotal, total, tunai/bayar, kembalian, atau metode pembayaran sebagai item atau charge.\n- Jika struk menyatakan harga sudah termasuk pajak (mis. \"PPN termasuk\"/\"incl. tax\"), JANGAN masukkan pajak itu ke charges; tulis keterangannya di tax_included_note.\n- Modifier/topping tanpa harga digabung ke nama item di atasnya; yang berharga jadikan item sendiri.\n- \"total\" = total akhir yang harus dibayar menurut struk, atau null jika tidak terbaca.\n- Jika gambar bukan struk, kembalikan {\"items\":[],\"charges\":[],\"total\":null,\"merchant\":null,\"tax_included_note\":\"bukan struk\"}.";

const MAX_B64 = 6_000_000; // ~4,5 MB foto

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function cors(origin, env) {
  const list = allowedOrigins(env);
  const ok = origin && list.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (list[0] || "null"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-access-code",
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
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function usage(env, add) {
  const limit = Number(env.DAILY_LIMIT || 50);
  if (!env.LIMITS) return { ok: true, remaining: null };
  const key = "day:" + new Date().toISOString().slice(0, 10);
  const used = Number((await env.LIMITS.get(key)) || 0);
  if (used >= limit) return { ok: false, remaining: 0 };
  if (add) await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return { ok: true, remaining: limit - used - (add ? 1 : 0) };
}

export default {
  async fetch(request, env) {
    const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
    const h = cors(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    if (origin && !allowedOrigins(env).includes(origin))
      return reply({ error: "Alamat web app ini belum diizinkan. Cek ALLOWED_ORIGIN di server." }, 403, h);
    if (!env.ANTHROPIC_API_KEY || !env.ACCESS_CODE)
      return reply({ error: "Server belum lengkap: isi ANTHROPIC_API_KEY dan ACCESS_CODE." }, 500, h);
    if (!sameSecret(request.headers.get("x-access-code"), env.ACCESS_CODE))
      return reply({ error: "Kode akses salah. Cek lagi di Pengaturan aplikasi." }, 401, h);

    if (request.method === "GET") {
      const u = await usage(env, false);
      return reply({ ok: true, remaining: u.remaining }, 200, h);
    }
    if (request.method !== "POST") return reply({ error: "Metode tidak didukung." }, 405, h);

    const b64 = (await request.text()).trim();
    if (!b64 || b64.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      return reply({ error: "Foto tidak valid atau terlalu besar." }, 400, h);
    const mediaType = b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("UklGR") ? "image/webp" : "image/jpeg";

    const u = await usage(env, true);
    if (!u.ok) return reply({ error: "Batas scan hari ini sudah habis. Coba lagi besok." }, 429, h);

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
      return reply({ error: "Server tidak bisa menghubungi Claude. Coba lagi sebentar lagi." }, 502, h);
    }
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const t = (j && j.error && j.error.type) || "";
      const msg = r.status === 401 ? "API key Anthropic tidak valid. Cek ANTHROPIC_API_KEY."
        : r.status === 429 ? "Claude sedang sibuk atau batas API tercapai. Coba lagi sebentar lagi."
        : /credit|billing/i.test(JSON.stringify(j)) ? "Saldo API Anthropic habis. Isi ulang di console.anthropic.com."
        : r.status === 529 || t === "overloaded_error" ? "Claude sedang sibuk. Coba lagi sebentar lagi."
        : "Claude gagal membaca struk (kode " + r.status + ").";
      return reply({ error: msg }, 502, h);
    }
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return reply({ text, remaining: u.remaining }, 200, h);
  },
};
