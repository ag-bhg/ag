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
//
// PENTING SOAL URUTAN (diperbaiki):
// Data yang sudah tersimpan di Firebase (hasil paste manual dari S1
// dulu) urutannya DESCENDING -- baris teratas = draw TERBARU, makin
// ke bawah makin lama. Ini konvensi yang dipakai S1 untuk nentuin
// "data paling baru" (selalu baca baris PALING ATAS).
//
// Baris baru dari Neon HARUS masuk di ATAS (bukan di bawah!), dan
// urutannya sendiri juga descending (kalau ada >1 baris baru,
// yang paling baru taruh paling atas di antara baris-baris baru itu).
//
// grouped[kode] datang dari query "ORDER BY sort_key ASC" (ascending,
// lama->baru), jadi sebelum digabung ke depan data lama, urutannya
// DIBALIK dulu (.reverse()) supaya jadi descending juga.
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
    const newLinesAscending = []; // sementara masih urutan lama->baru (dari query)
    for (const row of grouped[kode]) {
      const k = `${String(row.tanggal).trim()}|${String(row.periode).trim()}`;
      if (!existingKeys.has(k)) {
        newLinesAscending.push(`${row.tanggal}\t${row.periode}\t${row.nomor}`);
      }
    }

    if (newLinesAscending.length === 0) {
      summary.push(`${kode}: sudah update, tidak ada data baru`);
      continue;
    }

    // Balik jadi descending (baru->lama) supaya baris paling baru
    // ada paling atas di antara baris-baris baru ini sendiri.
    const newLinesDescending = newLinesAscending.slice().reverse();

    const oldData = (found.entry.data || '').trim();

    // Baris baru ditaruh DI ATAS data lama (bukan di bawah seperti
    // sebelumnya) -- supaya urutan keseluruhan tetap descending
    // (terbaru selalu di paling atas), konsisten dengan cara S1
    // membaca "data terbaru".
    const combined = oldData
      ? `${newLinesDescending.join('\n')}\n${oldData}`
      : newLinesDescending.join('\n');

    updates[`${FIREBASE_DATA_PATH}/${found.key}/data`] = combined;
    summary.push(`${kode}: +${newLinesAscending.length} baris baru ditambahkan (di atas)`);
  }

  if (Object.keys(updates).length > 0) {
    await firebaseMultiUpdate(token, updates); // 1 fetch, apa pun jumlah kode yang berubah
  }

  console.log('[auto-sync]', summary.join(' | '));
  return summary;
}

// ============================================================
// BAGIAN 6 — CLEANUP SATU KALI untuk entry yang SUDAH KEBURU
// BERANTAKAN (baris baru numpuk di bawah sebelum fix ini ada)
//
// Yang dilakukan:
// 1. Ambil semua entry savedData
// 2. Parse tiap baris jadi {tanggal, periode, nomor}
// 3. Sort ulang descending berdasarkan tanggal + nomor urut periode
//    (bukan cuma string tanggal -- supaya "31-08" vs "01-09" ke-
//    urut benar berdasarkan waktu asli, bukan alfabet)
// 4. Buang duplikat (key tanggal+periode sama)
// 5. Tulis balik ke Firebase
//
// Aman dijalankan berkali-kali (idempotent) -- kalau data sudah
// rapi, hasil sort ulang akan identik dengan yang sudah ada.
// ============================================================

function parseLineToObj(line) {
  const cols = line.split('\t');
  if (cols.length < 3) return null;
  const [tanggal, periode, nomor] = cols;
  // tanggal format "DD-MM-YYYY" -> dibuat sortable "YYYY-MM-DD"
  const m = String(tanggal).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const sortableDate = `${m[3]}-${m[2]}-${m[1]}`; // YYYY-MM-DD

  // Ambil nomor urut dari periode (mis. "VTM-616" -> 616), dipakai
  // sebagai tie-breaker kalau tanggalnya sama (misal pasaran KK yang
  // 2x sehari, atau format tanpa strip "VTM616").
  const urutMatch = String(periode).trim().match(/(\d+)\s*$/);
  const urutan = urutMatch ? parseInt(urutMatch[1], 10) : 0;

  return {
    tanggal: String(tanggal).trim(),
    periode: String(periode).trim(),
    nomor: String(nomor).trim(),
    sortableDate,
    urutan,
    raw: `${tanggal.trim()}\t${periode.trim()}\t${nomor.trim()}`
  };
}

function sortDataStringDescending(dataString) {
  if (!dataString || !dataString.trim()) return dataString;

  const lines = dataString.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const parsed = [];
  const skipped = [];

  for (const line of lines) {
    const obj = parseLineToObj(line);
    if (obj) parsed.push(obj);
    else skipped.push(line); // baris yang tidak bisa diparse (format lama/aneh) -- dipertahankan, ditaruh di akhir
  }

  // Dedup by tanggal+periode, simpan yang pertama ditemukan
  const seen = new Set();
  const deduped = [];
  for (const obj of parsed) {
    const key = `${obj.tanggal}|${obj.periode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(obj);
  }

  // Sort descending: tanggal terbaru dulu, lalu urutan periode terbesar dulu
  deduped.sort((a, b) => {
    if (a.sortableDate !== b.sortableDate) {
      return a.sortableDate < b.sortableDate ? 1 : -1;
    }
    return b.urutan - a.urutan;
  });

  const sortedLines = deduped.map(o => o.raw);
  return [...sortedLines, ...skipped].join('\n');
}

async function runCleanupOrder(env) {
  const dbUrl = await env.DATABASE_URL_SECRET.get();
  const sql = neon(dbUrl);

  const token = await getFirebaseAccessToken(sql);
  const savedData = await firebaseGetSavedData(token);

  if (!savedData) {
    return ['Tidak ada data di savedData'];
  }

  const entries = Array.isArray(savedData)
    ? savedData.map((entry, idx) => ({ key: idx, entry }))
    : Object.entries(savedData).map(([key, entry]) => ({ key, entry }));

  const summary = [];
  const updates = {};

  for (const { key, entry } of entries) {
    if (!entry || typeof entry.data !== 'string' || !entry.name) {
      continue;
    }

    const before = entry.data;
    const after = sortDataStringDescending(before);

    if (before === after) {
      summary.push(`${entry.name}: sudah rapi, tidak diubah`);
      continue;
    }

    updates[`${FIREBASE_DATA_PATH}/${key}/data`] = after;

    const beforeLines = before.split(/\n+/).filter(Boolean).length;
    const afterLines = after.split(/\n+/).filter(Boolean).length;
    summary.push(
      `${entry.name}: diurutkan ulang (${beforeLines} -> ${afterLines} baris` +
      (beforeLines !== afterLines ? ', ada duplikat dibuang' : '') + ')'
    );
  }

  if (Object.keys(updates).length > 0) {
    await firebaseMultiUpdate(token, updates);
  }

  console.log('[cleanup-order]', summary.join(' | '));
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

    // Endpoint SATU KALI untuk merapikan entry yang sudah keburu berantakan
    // (baris baru numpuk di bawah, dari sebelum runSync() diperbaiki).
    // Aman dipanggil berkali-kali -- kalau sudah rapi, tidak ada perubahan.
    if (url.pathname === '/api/fix-order') {
      try {
        const summary = await runCleanupOrder(env);
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
