// ===================== AI MEMORY (ingatan Mode Ai) =====================
// Jembatan penyimpanan untuk Mode Ai (aiMode.js). Dimuat SETELAH database.js (memakai variabel
// global `db` dan `authReadyPromise` yang sudah dibuat di sana) dan SEBELUM aiMode.js.
//
// Tidak membawa database sendiri — cuma menambah 1 node baru di Firebase Realtime DB yang sudah
// dipakai sistem ini ("aiMemory"), di samping node "savedData" yang sudah ada:
//   aiMemory/prefs     -> preferensi (OUT, pin/buang/famOff, tilt lintas-pasaran, catatan global)
//   aiMemory/chat      -> riwayat percakapan Mode Ai (dibatasi 100 pesan terakhir)
//   aiMemory/patterns  -> kamus kalimat yang sudah "diajarkan" user -> perintah asli yang dimaksud
//   aiMemory/brain/*   -> hasil belajar otak prediksi (aiBrain) per pasaran, DITIMPA tiap belajar
//                         ulang (bukan ditumpuk), plus log ringkas akurasi (maks 10 entri terakhir)
//                         supaya tren belajar bisa dipantau tanpa menyimpan riwayat penuh.
//
// Kalau Firebase tidak tersedia (db null / auth gagal / offline), semua fungsi di bawah otomatis
// fallback ke localStorage saja — aiMode.js tidak perlu tahu bedanya, cukup pakai AiMemory.*.
(function(root){
'use strict';

const LS_PREFS = 'aiMemory_prefs_v1';
const LS_CHAT = 'aiMemory_chat_v1';
const LS_PATTERNS = 'aiMemory_patterns_v1';
const LS_BRAIN = 'aiMemory_brain_v1';
const LS_CF = 'aiMemory_cf_v1'; // Tahap 1: tebakan Cloudflare AI (shadow-track) per pasaran
const LS_ZONE = 'aiMemory_zone_v1'; // Zona Aman Streak: hasil belajar (pool semua pasaran) + keputusan eksekusi PER pasaran

function hasDb(){ return typeof db !== 'undefined' && db && typeof authReadyPromise !== 'undefined'; }

function lsGet(key, fallback){
  try{ const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; }catch(e){ return fallback; }
}
function lsSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ /* penuh/diblokir — abaikan, tetap jalan dari memori */ } }

// Nama pasaran dipakai sebagai key node Firebase — Firebase melarang karakter . # $ [ ] / di key.
function encodeKey(name){ return String(name).replace(/[.#$\[\]\/]/g, '_'); }

// ---------- Baca semua ingatan sekali di awal (dipanggil oleh load() di aiMode.js) ----------
// Selalu mengembalikan sesuatu yang bisa langsung dipakai (fallback lokal kalau cloud gagal/offline).
function loadAll(){
  const local = {
    prefs: lsGet(LS_PREFS, {}),
    chat: lsGet(LS_CHAT, []),
    patterns: lsGet(LS_PATTERNS, {}),
    brain: lsGet(LS_BRAIN, {}),
    cf: lsGet(LS_CF, {}),
    zone: lsGet(LS_ZONE, {})
  };
  if(!hasDb()) return Promise.resolve(Object.assign({ synced: false }, local));
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return Object.assign({ synced: false }, local);
    return db.ref('aiMemory').once('value')
      .then(snap => {
        const v = snap.exists() ? snap.val() : {};
        const merged = {
          prefs: v.prefs || local.prefs,
          chat: v.chat || local.chat,
          patterns: v.patterns || local.patterns,
          brain: v.brain || local.brain,
          cf: v.cf || local.cf,
          zone: v.zone || local.zone,
          synced: true
        };
        lsSet(LS_PREFS, merged.prefs); lsSet(LS_CHAT, merged.chat);
        lsSet(LS_PATTERNS, merged.patterns); lsSet(LS_BRAIN, merged.brain); lsSet(LS_CF, merged.cf); lsSet(LS_ZONE, merged.zone);
        return merged;
      })
      .catch(e => { console.error('AiMemory: gagal baca cloud, pakai ingatan lokal', e); return Object.assign({ synced: false }, local); });
  });
}

// ---------- Tulis satu node saja (dipanggil terpisah, supaya tidak boros nulis semuanya tiap kali) ----------
function writeNode(path, val, localKey){
  if(localKey) lsSet(localKey, val);
  if(!hasDb()) return Promise.resolve({ synced: false, reason: 'no-db' });
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return { synced: false, reason: 'unauth' };
    return db.ref('aiMemory/' + path).set(val)
      .then(() => ({ synced: true }))
      .catch(e => { console.error('AiMemory: gagal sync ' + path, e); return { synced: false, reason: 'error', error: e }; });
  });
}

function savePrefs(prefs){ return writeNode('prefs', prefs, LS_PREFS); }
function saveChat(chat){ return writeNode('chat', (chat || []).slice(-100), LS_CHAT); }
function savePatterns(patterns){ return writeNode('patterns', patterns, LS_PATTERNS); }

// Hasil belajar 1 pasaran — DITIMPA (bukan ditumpuk). Log akurasi ringkas (waktu+skor saja,
// bukan data lengkap) ikut disimpan supaya trennya kelihatan tanpa boros ruang.
function saveBrainResult(name, payload){
  const key = encodeKey(name);
  const local = lsGet(LS_BRAIN, {});
  const prevLog = (local[key] && local[key].log) || [];
  const log = prevLog.concat([{ t: Date.now(), pct: payload.pct, z: payload.z }]).slice(-10);
  const entry = { name: String(name), state: payload.state, pct: payload.pct, z: payload.z, n: payload.n, log, updatedAt: Date.now() };
  local[key] = entry; lsSet(LS_BRAIN, local);
  if(!hasDb()) return Promise.resolve({ synced: false, reason: 'no-db' });
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return { synced: false, reason: 'unauth' };
    return db.ref('aiMemory/brain/' + key).set(entry)
      .then(() => ({ synced: true }))
      .catch(e => { console.error('AiMemory: gagal sync brain/' + key, e); return { synced: false, reason: 'error', error: e }; });
  });
}

// Tahap 1 (shadow-track): tebakan Cloudflare AI per pasaran — DITIMPA tiap update. entry = { name,
// pending: {t, digits, createdAt} | null, n, hits: {A:.., C:.., ...}, log: [{t, draw, detail}] (maks 20) }
// TIDAK ikut campuran bobot pakar aiBrain — murni dicatat supaya akurasinya bisa dibuktikan dulu.
function saveCfEntry(name, entry){
  const key = encodeKey(name);
  const local = lsGet(LS_CF, {});
  local[key] = entry; lsSet(LS_CF, local);
  if(!hasDb()) return Promise.resolve({ synced: false, reason: 'no-db' });
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return { synced: false, reason: 'unauth' };
    return db.ref('aiMemory/cf/' + key).set(entry)
      .then(() => ({ synced: true }))
      .catch(e => { console.error('AiMemory: gagal sync cf/' + key, e); return { synced: false, reason: 'error', error: e }; });
  });
}

// Zona Aman Streak — DITIMPA tiap update. key 'GLOBAL' = hasil belajar pooled (dari semua pasaran yang
// dimuat saat "pelajari zona" dijalankan). key per-nama-pasaran = snapshot keputusan eksekusi pasaran
// itu saja (streak berjalan pasaran itu, TIDAK dicampur pasaran lain) — parameter tersimpan sendiri2.
function saveZoneEntry(name, entry){
  const key = encodeKey(name);
  const local = lsGet(LS_ZONE, {});
  local[key] = entry; lsSet(LS_ZONE, local);
  if(!hasDb()) return Promise.resolve({ synced: false, reason: 'no-db' });
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return { synced: false, reason: 'unauth' };
    return db.ref('aiMemory/zone/' + key).set(entry)
      .then(() => ({ synced: true }))
      .catch(e => { console.error('AiMemory: gagal sync zone/' + key, e); return { synced: false, reason: 'error', error: e }; });
  });
}

const API = { loadAll, savePrefs, saveChat, savePatterns, saveBrainResult, saveCfEntry, saveZoneEntry, encodeKey };
if(typeof module !== 'undefined' && module.exports) module.exports = API;
root.AiMemory = API;
})(typeof window !== 'undefined' ? window : globalThis);
