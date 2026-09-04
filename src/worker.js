import { neon } from '@neondatabase/serverless';

// ============================================================
// KONFIGURASI TETAP (tidak sensitif, sama seperti di file S1)
// ============================================================
const FIREBASE_DB_URL = 'https://analisa-frekuensi-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_DATA_PATH = 'savedData';

// ============================================================
// BAGIAN 1 — Generate Google OAuth access token dari Service Account
// (dibutuhkan supaya Worker bisa menulis ke Firebase Realtime Database
//  tanpa ada user yang login secara manual)
// ============================================================

function base64UrlEncode(input) {
  let str;
  if (typeof input === 'string') {
    str = btoa(unescape(encodeURIComponent(input)));
  } else {
    // ArrayBuffer -> base64
    const bytes = new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    str = btoa(binary);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getFirebaseAccessToken(sql) {
  const rows = await sql`SELECT value FROM app_secrets WHERE key = 'firebase_service_account'`;
  if (!rows.length) {
    throw new Error('Kredensial firebase_service_account tidak ditemukan di tabel app_secrets');
  }
  const sa = JSON.parse(rows[0].value);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const json = await resp.json();
  if (!json.access_token) {
    throw new Error('Gagal ambil access token Firebase: ' + JSON.stringify(json));
  }
  return json.access_token;
}

// ============================================================
// BAGIAN 2 — Baca & tulis Firebase Realtime Database lewat REST
// ============================================================

async function firebaseGetSavedData(token) {
  const resp = await fetch(`${FIREBASE_DB_URL}/${FIREBASE_DATA_PATH}.json`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error('Gagal baca savedData: ' + resp.status);
  return resp.json(); // bisa null, array, atau object (tergantung isi Firebase)
}

async function firebaseUpdateEntryData(token, entryKey, newDataString) {
  const resp = await fetch(
    `${FIREBASE_DB_URL}/${FIREBASE_DATA_PATH}/${entryKey}.json`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: newDataString })
    }
  );
  if (!resp.ok) throw new Error(`Gagal update entry ${entryKey}: ${resp.status}`);
}

// Update banyak entry sekaligus dalam SATU request (hemat subrequest)
// updates berbentuk: { "savedData/<key1>/data": "...", "savedData/<key2>/data": "..." }
async function firebaseMultiUpdate(token, updates) {
  const resp = await fetch(`${FIREBASE_DB_URL}/.json`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  if (!resp.ok) throw new Error('Gagal multi-update Firebase: ' + resp.status);
}

// ============================================================
// BAGIAN 3 — Baca data terbaru dari Neon (tabel history, punya S2)
// ============================================================

// Ambil SEMUA baris history dalam SATU query, lalu dikelompokkan per kode_pasaran di memori
// (jauh lebih hemat subrequest dibanding query terpisah per kode pasaran)
async function getAllHistoryGrouped(sql) {
  const rows = await sql`
    SELECT kode_pasaran, tanggal, periode, nomor
    FROM history
    ORDER BY kode_pasaran ASC, sort_key ASC
  `;
  const grouped = {};
  for (const row of rows) {
    if (!row.kode_pasaran) continue;
    if (!grouped[row.kode_pasaran]) grouped[row.kode_pasaran] = [];
    grouped[row.kode_pasaran].push(row);
  }
  return grouped;
}

// ============================================================
// BAGIAN 4 — Logika diff: key unik = Tanggal + Periode
// ============================================================

function parseExistingKeys(dataString) {
  const keys = new Set();
  if (!dataString) return keys;
  dataString.split(/\n+/).forEach(line => {
    const cols = line.split('\t');
    if (cols.length >= 2) {
      keys.add(`${cols[0].trim()}|${cols[1].trim()}`);
    }
  });
  return keys;
}

function findEntryKeyByName(savedData, kode) {
  if (!savedData) return null;
  if (Array.isArray(savedData)) {
    const idx = savedData.findIndex(e => e && e.name === kode);
    return idx >= 0 ? { key: idx, entry: savedData[idx] } : null;
  }
  for (const [key, entry] of Object.entries(savedData)) {
    if (entry && entry.name === kode) return { key, entry };
  }
  return null;
}

// ============================================================
// BAGIAN 5 — Handler utama, dipanggil tiap cron trigger jalan
// ============================================================

async function runSync(env) {
  const dbUrl = await env.DATABASE_URL_SECRET.get();
  const sql = neon(dbUrl);

  const token = await getFirebaseAccessToken(sql);        // 1 query
  const savedData = await firebaseGetSavedData(token);     // 1 fetch
  const grouped = await getAllHistoryGrouped(sql);         // 1 query (semua kode sekaligus)

  const summary = [];
  const updates = {}; // path -> value, dikirim sekaligus di akhir

  for (const kode of Object.keys(grouped)) {
    const found = findEntryKeyByName(savedData, kode);
    if (!found) {
      summary.push(`${kode}: dilewati (belum ada entry Firebase dengan nama ini)`);
      continue;
    }

    const existingKeys = parseExistingKeys(found.entry.data || '');
    const newLines = [];
    for (const row of grouped[kode]) {
      const k = `${String(row.tanggal).trim()}|${String(row.periode).trim()}`;
      if (!existingKeys.has(k)) {
        newLines.push(`${row.tanggal}\t${row.periode}\t${row.nomor}`);
      }
    }

    if (newLines.length === 0) {
      summary.push(`${kode}: sudah update, tidak ada data baru`);
      continue;
    }

    const oldData = (found.entry.data || '').trim();
    const combined = oldData ? `${oldData}\n${newLines.join('\n')}` : newLines.join('\n');
    updates[`${FIREBASE_DATA_PATH}/${found.key}/data`] = combined;
    summary.push(`${kode}: +${newLines.length} baris baru ditambahkan`);
  }

  if (Object.keys(updates).length > 0) {
    await firebaseMultiUpdate(token, updates); // 1 fetch, apa pun jumlah kode yang berubah
  }

  console.log('[auto-sync]', summary.join(' | '));
  return summary;
}

// ============================================================
// EXPORT WORKER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      const dbUrl = await env.DATABASE_URL_SECRET.get();
      const sql = neon(dbUrl);
      const rows = await sql`SELECT key FROM app_secrets WHERE key = 'firebase_service_account'`;
      return Response.json({
        db_test: env.DB_TEST ?? 'KOSONG',
        has_secret_binding: !!env.DATABASE_URL_SECRET,
        has_firebase_secret_in_neon: rows.length > 0,
        available_env_keys: Object.keys(env)
      });
    }

    // Endpoint manual buat trigger sync sendiri kalau mau tes tanpa nunggu cron
    // (sengaja diizinkan lewat GET juga supaya bisa dibuka langsung dari browser HP)
    if (url.pathname === '/api/sync-now') {
      try {
        const summary = await runSync(env);
        return Response.json({ ok: true, summary });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    const match = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
    if (match) {
      const pasaran = decodeURIComponent(match[1]);
      const dbUrl = await env.DATABASE_URL_SECRET.get();
      if (!dbUrl) {
        return Response.json({ ok: false, stage: 'env', error: 'DATABASE_URL tidak tersedia di Worker' });
      }
      const sql = neon(dbUrl);
      if (request.method === 'GET') {
        const rows = await sql`SELECT settings FROM s1_settings WHERE pasaran = ${pasaran}`;
        return Response.json(rows[0]?.settings ?? null);
      }
      if (request.method === 'POST') {
        const body = await request.json();
        await sql`
          INSERT INTO s1_settings (pasaran, settings, updated_at)
          VALUES (${pasaran}, ${JSON.stringify(body)}, now())
          ON CONFLICT (pasaran) DO UPDATE SET settings = ${JSON.stringify(body)}, updated_at = now()
        `;
        return Response.json({ ok: true });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  }
};
