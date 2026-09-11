// ===================== DATABASE =====================
// Data historis (parse/simpan/muat/hapus), sinkron Firebase S1 (jadwal, dropdown pasaran,
// countdown), loading overlay, dan menu ngambang Input/Refresh/Repair/Update.

let lastHistoryNumbers = []; // data historis yang dipakai untuk filter "buang yang sudah keluar" (newest-first)
let lastPosLabels = null; // ['A','C','K','E'] dst — dipakai ulang saat Formula X dihitung ulang
let currentLoadedDataName = ''; // nama data tersimpan yang sedang dimuat (diisi lewat tombol Muat) — ditampilkan di Filter Pangkas Kombinasi

// Tampilkan nama data yang sedang dimuat di dekat "Sisa setelah difilter" (Filter Pangkas Kombinasi).
function renderFilterLoadedName(){
  const el = document.getElementById('filterLoadedName');
  if(el) el.textContent = currentLoadedDataName || '–';
}

function parseData(raw){
  // Kalau satu baris punya banyak kolom (dipisah tab/spasi ganda, mis. Tanggal - Kode - Angka),
  // ambil HANYA kolom paling kanan sebagai data historis, lalu ambil 4 digit dari kanan kolom itu.
  // Baris berformat lama (angka polos dipisah spasi/koma/*) tetap berjalan seperti biasa.
  const tokens = [];
  raw.split(/\n+/).forEach(line => {
    const trimmedLine = line.trim();
    if(!trimmedLine) return;
    const cols = trimmedLine.split(/\t+| {2,}/).filter(c => c.trim().length > 0);
    const lastCol = cols.length > 1 ? cols[cols.length - 1] : trimmedLine;
    lastCol.split(/[\s,\*]+/).forEach(field => {
      const digitsOnly = field.replace(/[^0-9]/g, '');
      if(digitsOnly.length === 0) return;
      tokens.push(digitsOnly.length > 4 ? digitsOnly.slice(-4) : digitsOnly);
    });
  });
  return tokens;
}

// =========================================================
// BANTUAN FORMAT DATA TERSIMPAN — Tgl + Id/NoUrut + Nomor
//
// "periode" isinya kode pasaran + nomor urut (mis. "TTM 22:00-604"),
// inilah "Id+NoUrut" yang dimaksud. Fungsi di bawah membaca baris
// tersimpan dalam format 3 kolom (Tanggal<TAB>Id+NoUrut<TAB>Nomor) —
// format yang sama seperti yang sudah dibaca parseData()/quickInputBtn
// di atas.
// =========================================================

// Satu sumber kebenaran untuk parsing periode: toleran format "HK-615" MAUPUN "HK615"
// (strip opsional). Dipakai oleh extractUrutanFromPeriode, rekapPeriodePrefix,
// rekapIncrementPeriode, dan rekapMakeId — supaya tidak ada logika ganda yang bisa geser.
function rekapParsePeriode(str){
  const m = String(str || '').match(/^(.*?)-?(\d+)\s*$/);
  if(!m) return { prefix: String(str || '').trim(), urutan: null, digits: 0 };
  return { prefix: m[1], urutan: parseInt(m[2], 10), digits: m[2].length };
}

function extractUrutanFromPeriode(periode){
  return rekapParsePeriode(periode).urutan;
}

function parseStoredRows(raw){
  // Baca ulang baris yang sudah tersimpan di kotak Data Historis.
  // Baris berformat baru (3 kolom, dipisah tab) dipecah jadi
  // tanggal/periode/nomor + nomor urutnya. Baris format lama (cuma
  // angka polos, tanpa tab) tetap dipertahankan apa adanya (urutan
  // null) supaya data historis lama tidak hilang.
  const out = [];
  raw.split(/\n+/).forEach(line => {
    const trimmed = line.trim();
    if(!trimmed) return;
    const cols = trimmed.split('\t');
    if(cols.length >= 3){
      const periode = cols[cols.length - 2].trim();
      out.push({
        tanggal: cols[0].trim(),
        periode,
        nomor: cols[cols.length - 1].trim(),
        urutan: extractUrutanFromPeriode(periode),
        raw: trimmed
      });
    } else {
      out.push({ tanggal: null, periode: null, nomor: trimmed, urutan: null, raw: trimmed });
    }
  });
  return out;
}

function pickTargetLength(tokens){
  const freq = {};
  tokens.forEach(t => { freq[t.length] = (freq[t.length]||0) + 1; });
  let best = 0, bestCount = -1;
  for(const len in freq){
    if(freq[len] > bestCount){ bestCount = freq[len]; best = parseInt(len,10); }
  }
  return best || 4;
}

function pad2(n){ return String(n).padStart(2, '0'); }
function todayDateStr(){
  const d = new Date();
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

document.getElementById('quickInputBtn').addEventListener('click', () => {
  const feedback = document.getElementById('quickInputFeedback');
  const digitsInput = document.getElementById('quickInputDigits');
  const digits = digitsInput.value.replace(/[^0-9]/g, '');
  if(digits.length < 4 || digits.length > 5){
    feedback.style.color = 'var(--rose)';
    feedback.textContent = 'Isi 4 atau 5 digit angka dulu.';
    return;
  }
  const ta = document.getElementById('dataInput');
  const raw = ta.value;
  const firstLine = raw.split('\n').find(l => l.trim().length > 0) || '';
  const cols = firstLine.trim().split(/\t+| {2,}/).filter(c => c.trim().length > 0);
  const today = todayDateStr();
  let newLine;
  if(cols.length >= 3){
    // format lama: Tanggal - Kode-Nomor - Angka. Ambil kolom kode (sebelum kolom angka terakhir),
    // lalu naikkan nomor urut di belakangnya +1 (mis. "TTM 22:00-594" -> "TTM 22:00-595").
    const codeCol = cols[cols.length - 2];
    const m = codeCol.match(/^(.*-)(\d+)$/);
    if(m){
      const nextNum = String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
      newLine = `${today}\t${m[1]}${nextNum}\t${digits}`;
    } else {
      newLine = `${today}\t${codeCol}\t${digits}`;
    }
  } else {
    // belum ada pola kode yang bisa dideteksi — tetap tambahkan dengan tanggal + angka saja
    newLine = `${today}\t${digits}`;
  }
  ta.value = raw.trim().length ? (newLine + '\n' + raw) : newLine;
  digitsInput.value = '';
  feedback.style.color = 'var(--teal)';
  feedback.textContent = `Ditambahkan: ${newLine.replace(/\t/g, '  ')} ✓`;
  analyze();
  setTimeout(() => { feedback.textContent = ''; }, 3500);
});

// =========================================================
// BATAS DATA PER PASARAN — jendela geser: data terbaru masuk,
// data terlama (paling belakang) otomatis dihapus kalau sudah
// mencapai 120 baris. Dipakai oleh tombol "Simpan" manual,
// supaya jumlah data tersimpan per pasaran tidak pernah lewat
// dari batas ini.
// =========================================================
const DATA_CAP_PER_PASARAN = 120;

function capDataToLimit(rawData, limit = DATA_CAP_PER_PASARAN){
  const rows = parseStoredRows(rawData || '');
  if(rows.length <= limit) return { data: rawData, trimmed: 0 };
  return {
    data: rows.slice(0, limit).map(r => r.raw).join('\n'),
    trimmed: rows.length - limit
  };
}



// ---------- Kode Keamanan (proteksi ringan untuk Simpan & Hapus) ----------
const SECURITY_CODE = '321';
const SECURITY_SESSION_KEY = 'analisaFrekuensi_sesiTerverifikasi';
function checkSecurityCode(actionLabel){
  // Kalau sudah pernah verifikasi kode di sesi (tab) ini, tidak perlu tanya lagi.
  if(sessionStorage.getItem(SECURITY_SESSION_KEY) === 'true') return true;
  const input = prompt(`Masukkan kode keamanan untuk ${actionLabel}:`);
  if(input === null) return false; // dibatalkan
  if(input !== SECURITY_CODE){
    alert('Kode salah. Aksi dibatalkan.');
    return false;
  }
  try{ sessionStorage.setItem(SECURITY_SESSION_KEY, 'true'); }catch(e){ /* sessionStorage diblokir — tetap lanjut, hanya tidak diingat */ }
  return true;
}

// ---------- Simpan / Muat / Hapus data historis (Firebase Realtime Database) ----------
const SAVE_KEY = 'analisaFrekuensi_savedData';
let savedEntriesCache = []; // sumber utama untuk render — diisi dari Firebase, fallback ke localStorage
let firebaseReady = false;
let pendingCloudSyncCount = 0; // >0 berarti ada write ke Firebase yang belum dikonfirmasi server

// Tampilkan data lokal DULU (instan, tanpa nunggu internet) supaya panel tidak kosong saat koneksi lambat.
// Nanti kalau cloud berhasil connect, list ini di-refresh otomatis (lihat authReadyPromise.then di bawah).
savedEntriesCache = loadSavedEntriesFromStorage();
renderSavedList();

const firebaseConfig = {
  apiKey: "AIzaSyB1yunsgfeJ-cyjx24hb0mG9nnVDOHfzl4",
  authDomain: "analisa-frekuensi.firebaseapp.com",
  databaseURL: "https://analisa-frekuensi-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "analisa-frekuensi",
  storageBucket: "analisa-frekuensi.firebasestorage.app",
  messagingSenderId: "44538798162",
  appId: "1:44538798162:web:c879bc4b44bc98371c3f8b"
};

let db = null;
let authReadyPromise = Promise.resolve(false);
try{
  firebase.initializeApp(firebaseConfig);

  // App Check: pastikan hanya request dari app resmi ini yang diterima Firebase.
  // GANTI 'TEMPEL_SITE_KEY_DI_SINI' dengan Site Key dari reCAPTCHA Admin Console.
  firebase.appCheck().activate(
    '6Lc3f48tAAAAAJwdUnKibs6HSj96NGKWDqdhPYPQ',
    true // isTokenAutoRefreshEnabled
  );

  db = firebase.database();
  // Anonymous sign-in: tanpa ini, Rules ".read/.write": "auth != null" akan menolak
  // permintaan tanpa login — termasuk bot yang mencoba akses langsung tanpa lewat app ini.
  authReadyPromise = firebase.auth().signInAnonymously()
    .then(() => true)
    .catch(e => {
      console.error('Gagal sign-in anonim ke Firebase:', e);
      const statusEl = document.getElementById('cloudStatus');
      if(statusEl){ statusEl.textContent = '· ⚠️ gagal autentikasi cloud, pakai data lokal'; statusEl.style.color = 'var(--rose)'; }
      return false;
    });
}catch(e){ console.error('Firebase gagal diinisialisasi:', e); }

// Cegah tab tertutup tanpa sadar selagi masih ada write ke cloud yang belum dikonfirmasi server
window.addEventListener('beforeunload', (e) => {
  if(pendingCloudSyncCount > 0){
    e.preventDefault();
    e.returnValue = 'Sinkronisasi ke cloud masih berjalan. Jika keluar sekarang, perubahan mungkin belum tersimpan di semua perangkat.';
    return e.returnValue;
  }
});

function loadSavedEntriesFromStorage(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}

function cacheToLocalStorage(list){
  try{ localStorage.setItem(SAVE_KEY, JSON.stringify(list)); }catch(e){ /* localStorage diblokir — tetap jalan dari cache memori */ }
}

function getSavedEntries(){
  return savedEntriesCache;
}

function getSortedEntries(){
  return getSavedEntries().slice().sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }));
}

function setSavedEntries(list){
  savedEntriesCache = list;
  cacheToLocalStorage(list);
  if(db){
    return authReadyPromise.then(isAuthed => {
      if(!isAuthed) return { synced: false, reason: 'unauth' }; // tetap tersimpan lokal, tanpa sync cloud
      pendingCloudSyncCount++;
      return db.ref('savedData').set(list)
        .then(() => ({ synced: true }))
        .catch(e => {
          console.error('Gagal sync ke cloud:', e);
          document.getElementById('saveFeedback').textContent = 'Tersimpan lokal, tapi gagal sync ke cloud (cek koneksi internet).';
          document.getElementById('saveFeedback').style.color = 'var(--rose)';
          return { synced: false, reason: 'error', error: e };
        })
        .finally(() => { pendingCloudSyncCount--; });
    });
  }
  return Promise.resolve({ synced: false, reason: 'no-db' });
}

function renderSavedList(){
  const entries = getSortedEntries();
  const countsSummary = document.getElementById('savedCountsSummary');
  const countsGrid = document.getElementById('savedCountsGrid');

  if(!countsSummary) return;

  if(entries.length === 0){
    countsSummary.style.display = 'none';
    return;
  }
  countsSummary.style.display = '';

  countsGrid.innerHTML = entries.map(e => {
    const count = parseData(e.data).length;
    return `<span style="background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:4px 10px; font-family:var(--mono); font-size:12px;"><b>${e.name}</b>: ${count} data</span>`;
  }).join('');
}

document.getElementById('saveDataBtn').addEventListener('click', async () => {
  const rawData = document.getElementById('dataInput').value;
  const feedback = document.getElementById('saveFeedback');
  if(!parseData(rawData).length){
    feedback.textContent = 'Tidak ada data untuk disimpan — isi kolom Data Historis dulu.';
    feedback.style.color = 'var(--rose)';
    return;
  }
  if(!checkSecurityCode('menyimpan data ini')) return;
  const entries = getSavedEntries().slice();
  const nameInput = document.getElementById('saveNameInput');
  const trimmed = nameInput.value.trim() || `Data ${entries.length + 1}`;
  const existingIdx = entries.findIndex(e => e.name === trimmed);
  const confirmMsg = existingIdx >= 0
    ? `Data "${trimmed}" sudah ada. Timpa dengan data baru ini?`
    : `Simpan data ini sebagai "${trimmed}"?`;
  if(!confirm(confirmMsg)) return;

  // Pembatas data: maksimal DATA_CAP_PER_PASARAN (120) baris per pasaran.
  // Kalau sudah/lebih dari itu, baris paling belakang (data paling lama)
  // yang dibuang duluan — baris terbaru di bagian atas tetap dipertahankan.
  const capResult = capDataToLimit(rawData, DATA_CAP_PER_PASARAN);
  const data = capResult.data;

  const savedAt = new Date().toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const newEntry = { name: trimmed, data, savedAt, settings: collectAllSettings() };
  if(existingIdx >= 0){ entries[existingIdx] = newEntry; } else { entries.push(newEntry); }

  const saveBtn = document.getElementById('saveDataBtn');
  const originalLabel = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="btnSpinner"></span>Menyimpan ke cloud...';
  feedback.style.color = 'var(--ink-dim)';
  feedback.textContent = '';

  let result;
  try{
    result = await setSavedEntries(entries);
  }catch(e){
    console.error('setSavedEntries gagal tak terduga:', e);
    result = { synced: false, reason: 'error', error: e };
  }

  renderSavedList();
  nameInput.value = trimmed;

  // Kalau ada baris yang kepotong gara-gara batas 120, sinkronkan juga
  // tampilan kotak Data Historis supaya sama persis dengan yang tersimpan.
  if(capResult.trimmed > 0){
    document.getElementById('dataInput').value = data;
    analyze();
  }

  saveBtn.disabled = false;
  saveBtn.textContent = originalLabel;

  const capNote = capResult.trimmed > 0
    ? ` (${capResult.trimmed} baris paling lama dibuang otomatis, maks ${DATA_CAP_PER_PASARAN} data/pasaran)`
    : '';

  if(result.synced){
    feedback.style.color = 'var(--teal)';
    feedback.textContent = existingIdx >= 0
      ? `Tersimpan (memperbarui "${trimmed}", termasuk semua pengaturan)${capNote} ✓ — tersinkron ke cloud, aman untuk keluar.`
      : `Tersimpan sebagai "${trimmed}" (termasuk semua pengaturan)${capNote} ✓ — tersinkron ke cloud, aman untuk keluar.`;
  } else if(result.reason === 'error'){
    feedback.style.color = 'var(--rose)';
    feedback.textContent = `Tersimpan lokal, tapi GAGAL sync ke cloud (cek koneksi internet) — data "${trimmed}" belum aman di semua perangkat.${capNote}`;
  } else {
    feedback.style.color = 'var(--amber)';
    feedback.textContent = `Tersimpan lokal — belum tersinkron ke cloud (autentikasi cloud gagal / offline).${capNote}`;
  }
  setTimeout(() => { feedback.textContent = ''; }, 5000);
});

// Muat data awal dari cloud, lalu dengarkan perubahan real-time (sync otomatis antar perangkat)
// Menunggu sign-in anonim selesai dulu, karena Rules mewajibkan auth != null
if(db){
  authReadyPromise.then(isAuthed => {
  if(!isAuthed){
    savedEntriesCache = loadSavedEntriesFromStorage();
    renderSavedList();
    return;
  }
  db.ref('savedData').once('value')
    .then(snap => {
      savedEntriesCache = snap.exists() ? snap.val() : loadSavedEntriesFromStorage();
      firebaseReady = true;
      renderSavedList();
      const statusEl = document.getElementById('cloudStatus');
      if(statusEl){ statusEl.textContent = '· ☁️ tersinkron'; statusEl.style.color = 'var(--teal)'; }
    })
    .catch(e => {
      console.error('Gagal ambil data cloud, pakai data lokal:', e);
      savedEntriesCache = loadSavedEntriesFromStorage();
      renderSavedList();
      const statusEl = document.getElementById('cloudStatus');
      if(statusEl){ statusEl.textContent = '· ⚠️ gagal konek cloud, pakai data lokal'; statusEl.style.color = 'var(--rose)'; }
    });

  db.ref('savedData').on('value', snap => {
    if(!firebaseReady) return; // hindari trigger ganda saat load pertama
    savedEntriesCache = snap.exists() ? snap.val() : [];
    cacheToLocalStorage(savedEntriesCache);
    renderSavedList();
  });
  }); // tutup authReadyPromise.then()
} else {
  savedEntriesCache = loadSavedEntriesFromStorage();
  renderSavedList();
  const statusEl = document.getElementById('cloudStatus');
  if(statusEl){ statusEl.textContent = '· ⚠️ cloud tidak tersedia, pakai data lokal'; statusEl.style.color = 'var(--rose)'; }
}

// Kalau proses konek cloud belum selesai juga setelah 8 detik (mis. koneksi sangat lambat),
// kasih status yang jujur — bukan biarkan "menghubungkan ke cloud..." menggantung tanpa kejelasan.
setTimeout(() => {
  const statusEl = document.getElementById('cloudStatus');
  if(statusEl && statusEl.textContent.includes('menghubungkan')){
    statusEl.textContent = '· koneksi lambat, menampilkan data lokal sementara';
    statusEl.style.color = 'var(--amber)';
  }
}, 8000);


// =========================================================
// DATA S1 DARI FIREBASE
// Jalur resmi: NEON DB -> GITHUB ACTIONS -> FIREBASE -> S1.
// S1 TIDAK memanggil /api/sync, /api/cron, /api/nomor, atau API S2
// untuk pengambilan data utama.
// =========================================================
const FIREBASE_DATA_PATH = 'savedData';
const FIREBASE_MARKET_KEY = 's1FirebaseMarket';
const FIREBASE_REFRESH_LABEL = 'Firebase';
let firebaseMarketEntries = [];
let firebaseMarketMap = {};
let firebaseDataReady = false;
let firebaseCountdownTimer = null;

const S1_JADWAL_PASARAN = {"TTM 13:00":{"nama":"TOTO MACAU 13:00","draws":[["13:00","13:15"]],"hari":null},"TTM 00:00":{"nama":"TOTO MACAU 00:00","draws":[["00:00","00:15"]],"hari":null},"TTM 16:00":{"nama":"TOTO MACAU 16:00","draws":[["16:00","16:15"]],"hari":null},"TTM 19:00":{"nama":"TOTO MACAU 19:00","draws":[["19:00","19:15"]],"hari":null},"TTM 22:00":{"nama":"TOTO MACAU 22:00","draws":[["22:00","22:15"]],"hari":null},"TTM 23:00":{"nama":"TOTO MACAU 23:00","draws":[["23:00","23:15"]],"hari":null},"HK":{"nama":"HONGKONG","draws":[["22:45","23:00"]],"hari":null},"HKE":{"nama":"HONGKONGEVE","draws":[["18:15","18:30"]],"hari":null},"HKL":{"nama":"HONGKONG LOTTO","draws":[["22:45","23:00"]],"hari":null},"SYD":{"nama":"SYDNEY","draws":[["13:30","13:50"]],"hari":null},"SDYL":{"nama":"SYDNEY LOTTO","draws":[["13:30","13:50"]],"hari":null},"SG":{"nama":"SINGAPORE","draws":[["17:30","17:45"]],"hari":["Kamis","Minggu","Rabu","Sabtu","Senin"]},"OR1":{"nama":"OREGON 1","draws":[["02:45","03:00"]],"hari":null},"OR2":{"nama":"OREGON 2","draws":[["05:45","06:00"]],"hari":null},"OR3":{"nama":"OREGON 3","draws":[["08:45","09:00"]],"hari":null},"OR4":{"nama":"OREGON 4","draws":[["11:45","12:05"]],"hari":null},"GGM":{"nama":"GEORGIA MID","draws":[["23:15","23:30"]],"hari":null},"GEOE":{"nama":"GEORGIA EVE","draws":[["05:45","06:00"]],"hari":null},"GEON":{"nama":"GEORGIA NGT","draws":[["10:20","10:35"]],"hari":null},"MRM":{"nama":"MARYLAND MID","draws":[["23:15","23:30"]],"hari":null},"MLE":{"nama":"MARYLAND EVE","draws":[["06:40","06:55"]],"hari":null},"OHM":{"nama":"OHIO MID","draws":[["23:15","23:30"]],"hari":null},"OHIE":{"nama":"OHIO EVE","draws":[["06:15","06:30"]],"hari":null},"ORL":{"nama":"ORLANDO","draws":[["00:30","00:40"]],"hari":null},"NJM":{"nama":"NEW JERSEY MID","draws":[["23:45","00:00"]],"hari":null},"NJE":{"nama":"NEW JERSEY EVE","draws":[["09:45","10:00"]],"hari":null},"MICM":{"nama":"MICHIGAN MID","draws":[["23:45","00:00"]],"hari":null},"MICE":{"nama":"MICHIGAN EVE","draws":[["06:15","06:30"]],"hari":null},"TRK":{"nama":"TURKI","draws":[["01:10","01:25"]],"hari":null},"INDM":{"nama":"INDIANA MID","draws":[["00:05","00:20"]],"hari":null},"INDE":{"nama":"INDIANA EVE","draws":[["09:35","10:05"]],"hari":null},"KTM":{"nama":"KENTUCKY MID","draws":[["00:05","00:20"]],"hari":null},"KTE":{"nama":"KENTUCKY EVE","draws":[["09:45","10:00"]],"hari":null},"TENM":{"nama":"TENNESSE MID","draws":[["00:05","00:20"]],"hari":["Jumat","Kamis","Minggu","Rabu","Sabtu","Selasa"]},"TENE":{"nama":"TENNESSE EVE","draws":[["06:00","06:20"]],"hari":null},"TENMD":{"nama":"TENNESSE MOR","draws":[["21:05","21:20"]],"hari":["Jumat","Kamis","Rabu","Sabtu","Selasa","Senin"]},"BLRS":{"nama":"BELARUS","draws":[["01:20","01:30"]],"hari":null},"TXD":{"nama":"TEXAS DAY","draws":[["00:15","00:30"]],"hari":["Jumat","Kamis","Minggu","Rabu","Sabtu","Selasa"]},"TXSE":{"nama":"TEXAS EVE","draws":[["05:45","06:00"]],"hari":["Jumat","Kamis","Minggu","Rabu","Sabtu","Selasa"]},"TXSN":{"nama":"TEXAS NGT","draws":[["09:55","10:05"]],"hari":["Jumat","Kamis","Minggu","Rabu","Sabtu","Selasa"]},"TXSM":{"nama":"TEXAS MOR","draws":[["21:45","22:00"]],"hari":["Jumat","Kamis","Rabu","Sabtu","Selasa","Senin"]},"FLRM":{"nama":"FLORIDA MID","draws":[["00:15","00:30"]],"hari":null},"FLRE":{"nama":"FLORIDA EVE","draws":[["08:30","08:45"]],"hari":null},"ILM":{"nama":"ILLINOIS MID","draws":[["00:25","00:40"]],"hari":null},"ILE":{"nama":"ILLINOIS EVE","draws":[["09:05","09:40"]],"hari":null},"MISM":{"nama":"MISSOURI MID","draws":[["00:30","00:45"]],"hari":null},"MISE":{"nama":"MISSOURI EVE","draws":[["08:40","09:00"]],"hari":null},"DELD":{"nama":"DELAWARE DAY","draws":[["00:40","01:00"]],"hari":null},"DLWN":{"nama":"DELAWARE NGT","draws":[["06:40","06:55"]],"hari":null},"VIRD":{"nama":"VIRGINIA DAY","draws":[["00:40","01:00"]],"hari":null},"VIRN":{"nama":"VIRGINIA NGT","draws":[["09:40","10:00"]],"hari":null},"WDM":{"nama":"WASHINGTON MID","draws":[["00:40","01:00"]],"hari":null},"WDE":{"nama":"WASHINGTON EVE","draws":[["06:40","06:55"]],"hari":null},"RM":{"nama":"ROMA","draws":[["02:00","02:10"]],"hari":null},"NYM":{"nama":"NEWYORK MID","draws":[["01:10","01:30"]],"hari":null},"NYE":{"nama":"NEW YORK EVE","draws":[["09:10","09:30"]],"hari":null},"HELS":{"nama":"HELSINKI","draws":[["02:25","02:35"]],"hari":null},"CRD":{"nama":"CAROLINE DAY","draws":[["01:45","02:00"]],"hari":null},"CRE":{"nama":"CAROLINE EVE","draws":[["10:05","10:20"]],"hari":null},"PNM":{"nama":"PANAMA","draws":[["03:00","03:10"]],"hari":null},"YSLM":{"nama":"YERUSALEM","draws":[["03:20","03:30"]],"hari":null},"POL":{"nama":"POLANDIA","draws":[["03:40","03:50"]],"hari":null},"NWC":{"nama":"NEWCASTLE","draws":[["05:00","05:10"]],"hari":null},"DET":{"nama":"DETROIT","draws":[["05:50","06:00"]],"hari":null},"HWI":{"nama":"HAWAII","draws":[["06:00","06:10"]],"hari":null},"GDC":{"nama":"GOLDCOAST","draws":[["06:30","06:40"]],"hari":null},"TKY":{"nama":"TOKYO","draws":[["07:30","07:40"]],"hari":null},"PP":{"nama":"PAPUA","draws":[["08:10","08:20"]],"hari":null},"MXC":{"nama":"MEXICO","draws":[["09:15","09:25"]],"hari":null},"SZ":{"nama":"SHENZHEN","draws":[["09:40","09:50"]],"hari":null},"SHG":{"nama":"SHANGHAI","draws":[["10:00","10:10"]],"hari":null},"TW":{"nama":"TAIWAN","draws":[["20:30","20:45"]],"hari":null},"TWM":{"nama":"TAIWANMOR","draws":[["10:15","10:30"]],"hari":null},"HCM":{"nama":"HOCHIMINH","draws":[["11:00","11:10"]],"hari":null},"MNL":{"nama":"MANILA","draws":[["11:15","11:30"]],"hari":null},"BSN":{"nama":"BUSAN","draws":[["12:00","12:10"]],"hari":null},"VTM":{"nama":"VIETNAM","draws":[["12:15","12:25"]],"hari":null},"MND":{"nama":"MANADO","draws":[["13:00","13:10"]],"hari":null},"BLI":{"nama":"BOLAI","draws":[["14:10","14:20"]],"hari":null},"HNO":{"nama":"HANOI","draws":[["14:25","14:35"]],"hari":null},"PH":{"nama":"PHILIPHINE","draws":[["15:05","15:15"]],"hari":null},"CHN":{"nama":"CHINA","draws":[["15:15","15:30"]],"hari":null},"BJI":{"nama":"BEIJING","draws":[["16:10","16:20"]],"hari":null},"KR":{"nama":"KOREA","draws":[["16:30","16:40"]],"hari":null},"KK":{"nama":"KINGKONG","draws":[["17:00","17:10"],["23:30","23:40"]],"hari":null},"JP":{"nama":"JAPAN","draws":[["17:00","17:20"]],"hari":null},"DXB":{"nama":"DUBAI","draws":[["00:15","00:25"]],"hari":null},"KBJ":{"nama":"KAMBOJA","draws":[["19:00","19:15"]],"hari":null},"JJ":{"nama":"JEJU","draws":[["19:30","19:40"]],"hari":null},"PEN":{"nama":"PENANG","draws":[["20:00","20:10"]],"hari":null},"PCSO":{"nama":"PCSO","draws":[["19:45","20:15"]],"hari":["Jumat","Kamis","Rabu","Sabtu","Selasa","Senin"]},"LDN":{"nama":"LONDON","draws":[["21:00","21:10"]],"hari":null},"BLG":{"nama":"BULGARIA","draws":[["23:30","23:40"]],"hari":null},"CD":{"nama":"CAMBODIA","draws":[["11:35","11:50"]],"hari":null},"BUE":{"nama":"BULLSEYE","draws":[["12:50","13:10"]],"hari":null}};

function firebaseSetBadge(text, good=true){
  const el = document.getElementById('firebaseDataBadge');
  if(!el) return;
  el.textContent = text;
  el.style.color = good ? 'var(--teal)' : 'var(--rose)';
}

function firebaseSelectedKode(){
  return document.getElementById('firebaseMarketSelect')?.value || '';
}

// Dua dropdown pasaran yang harus selalu sinkron: firebaseMarketSelect (Beranda)
// dan analisisPeriodeSelect (Analisis, label "Periode"). Helper ini mengembalikan
// keduanya sekaligus supaya tidak ada logika ganda yang bisa geser satu sama lain.
function firebaseMarketSelectEls(){
  return [document.getElementById('firebaseMarketSelect'), document.getElementById('analisisPeriodeSelect')]
    .filter(Boolean);
}

function firebaseSetSelectedKode(kode){
  if(!kode) return;
  firebaseMarketSelectEls().forEach(select => {
    const found = Array.from(select.options).find(o => o.value.toLowerCase() === String(kode).toLowerCase());
    if(found) select.value = found.value;
  });
}

function firebaseFormatDuration(totalSeconds){
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if(hours > 0) return `${String(hours).padStart(2,'0')}j ${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}d`;
  return `00j ${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}d`;
}

function firebaseFormatDropdownDuration(totalSeconds){
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const totalMinutes = Math.max(0, Math.floor(sec / 60));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2,'0')}j ${String(mins).padStart(2,'0')}m`;
}

function firebaseScheduleInfoForName(name){
  const target = String(name || '').trim().toLowerCase();
  if(!target) return null;
  const exactKey = Object.keys(S1_JADWAL_PASARAN).find(k => String(k).trim().toLowerCase() === target);
  if(exactKey) return { kode: exactKey, info: S1_JADWAL_PASARAN[exactKey] };
  const matchKey = Object.keys(S1_JADWAL_PASARAN).find(k => {
    const info = S1_JADWAL_PASARAN[k];
    return info && String(info.nama || '').trim().toLowerCase() === target;
  });
  return matchKey ? { kode: matchKey, info: S1_JADWAL_PASARAN[matchKey] } : null;
}

function firebaseRefreshMarketDropdown(){
  const selects = firebaseMarketSelectEls();
  if(!selects.length) return;
  const select = selects[0];

  const selected = firebaseSelectedKode();
  const items = firebaseMarketEntries
    .map(e => {
      const name = String(e?.name || '').trim();
      const found = firebaseScheduleInfoForName(name);
      const next = found ? firebaseNextDraw(found.kode) : null;
      return { name, found, next };
    })
    .filter(x => x.name);

  items.sort((a,b) => {
    const at = a.next ? a.next.ts : Number.POSITIVE_INFINITY;
    const bt = b.next ? b.next.ts : Number.POSITIVE_INFINITY;
    if(at !== bt) return at - bt;
    const ak = a.found ? a.found.kode : a.name;
    const bk = b.found ? b.found.kode : b.name;
    return ak.localeCompare(bk, 'id', {sensitivity:'base'});
  });

  const optionsHtml = '<option value="">— pilih pasaran —</option>' +
    items.map(item => {
      const namaPanjang = String(item.found?.info?.nama || item.name).trim();
      const label = item.next
        ? `${namaPanjang} · ${firebaseFormatDropdownDuration((item.next.ts - Date.now()) / 1000)}`
        : `${namaPanjang} · —`;
      const value = item.name.replace(/"/g,'&quot;');
      return `<option value="${value}" title="${namaPanjang}">${label}</option>`;
    }).join('');
  selects.forEach(sel => { sel.innerHTML = optionsHtml; });

  firebaseSetSelectedKode(selected);
  if(!select.value && items.length){
    selects.forEach(sel => { sel.value = items[0].name; });
  }
  if(select.value) localStorage.setItem(FIREBASE_MARKET_KEY, select.value);
}

function firebaseWibNow(){
  // Ambil tanggal/jam WIB secara eksplisit agar tidak tergantung timezone perangkat/browser.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date());
  const get = key => Number(parts.find(p => p.type === key)?.value || 0);
  return {
    year: get('year'), month: get('month') - 1, day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second')
  };
}

function firebaseWibToTimestamp(year, month, day, hh, mm){
  return Date.UTC(year, month, day, hh, mm, 0, 0) - 7 * 60 * 60 * 1000;
}

function firebaseHariAktif(info, wibDate){
  if(!info || !info.hari || !info.hari.length) return true;
  const hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][wibDate.getUTCDay()];
  return info.hari.includes(hari);
}

function firebaseNextDraw(kode){
  const info = S1_JADWAL_PASARAN[kode];
  if(!info || !Array.isArray(info.draws) || !info.draws.length) return null;
  const nowWib = firebaseWibNow();
  const y = nowWib.year, mo = nowWib.month, d = nowWib.day;
  let best = null;

  for(let dayOffset = 0; dayOffset <= 8; dayOffset++){
    const dayWib = new Date(Date.UTC(y, mo, d + dayOffset, 0, 0, 0, 0));
    if(!firebaseHariAktif(info, dayWib)) continue;
    for(const draw of info.draws){
      const m = String(draw[1] || '').match(/^(\d{1,2}):(\d{2})$/);
      if(!m) continue;
      const ts = firebaseWibToTimestamp(dayWib.getUTCFullYear(), dayWib.getUTCMonth(), dayWib.getUTCDate(), Number(m[1]), Number(m[2]));
      if(ts > Date.now() && (!best || ts < best.ts)) best = {ts, close:draw[0], result:draw[1]};
    }
  }
  return best;
}

function firebaseLatestRow(entry){
  if(!entry || typeof entry.data !== 'string') return null;
  const rows = entry.data.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for(const raw of rows){
    const parts = raw.split(/\t+/).map(x => x.trim());
    if(parts.length >= 3 && /^\d{2}-\d{2}-\d{4}$/.test(parts[0]) && /^\d{2,5}$/.test(parts[2])){
      return {tanggal:parts[0], periode:parts[1], nomor:parts[2], raw};
    }
  }
  return null;
}

function firebaseRenderCountdown(){
  const el = document.getElementById('firebaseCountdown');
  const statusEl = document.getElementById('firebaseScheduleStatus');
  const latestEl = document.getElementById('firebaseLatestResult');
  if(!el || !statusEl) return;

  const kode = firebaseSelectedKode();
  const info = S1_JADWAL_PASARAN[kode];
  if(!kode){
    el.textContent = '⏳ Menuju result: —';
    statusEl.textContent = 'Pilih pasaran.';
    if(latestEl) latestEl.textContent = 'Result terbaru: —';
    return;
  }
  if(!info){
    el.textContent = '⏳ Menuju result: —';
    statusEl.textContent = `${kode} · jam pasaran belum tersedia di jadwal S1.`;
  } else {
    const next = firebaseNextDraw(kode);
    if(next){
      const sec = Math.max(0, Math.floor((next.ts - Date.now()) / 1000));
      const target = new Date(next.ts + 7 * 60 * 60 * 1000);
      const hh = String(target.getUTCHours()).padStart(2,'0');
      const mm = String(target.getUTCMinutes()).padStart(2,'0');
      el.textContent = `⏳ Result ${hh}:${mm} WIB · ${firebaseFormatDuration(sec)}`;
      statusEl.textContent = `${info.nama} · Tutup ${info.draws.map(d => d[0]).join(' / ')} WIB · Result ${info.draws.map(d => d[1]).join(' / ')} WIB`;
    } else {
      el.textContent = '⏳ Menuju result: —';
      statusEl.textContent = `${info.nama} · jadwal berikutnya belum dapat dihitung.`;
    }
  }

  const entry = firebaseMarketMap[kode];
  const latest = firebaseLatestRow(entry);
  if(latestEl){
    latestEl.textContent = latest
      ? `Result terbaru: ${latest.nomor} · ${latest.periode} · ${latest.tanggal}`
      : 'Result terbaru: belum tersedia';
  }

  // Isi 4 kotak digit "Result Terakhir" di Beranda dari nomor result terbaru (rata kanan, sisa diisi '–')
  const nomorStr = latest ? String(latest.nomor).padStart(4, ' ').slice(-4) : '';
  for(let i = 0; i < 4; i++){
    const box = document.getElementById('homeResultDigit' + i);
    if(!box) continue;
    const ch = nomorStr[i];
    box.textContent = (ch && ch !== ' ') ? ch : '–';
  }
}

function firebasePopulateMarkets(){
  const old = localStorage.getItem(FIREBASE_MARKET_KEY) || '';
  const preferred = old || currentLoadedDataName || '';
  firebaseRefreshMarketDropdown();
  firebaseSetSelectedKode(preferred);
  const select = document.getElementById('firebaseMarketSelect');
  if(select && !select.value && firebaseMarketEntries.length) select.value = firebaseMarketEntries[0].name;
  if(select?.value) localStorage.setItem(FIREBASE_MARKET_KEY, select.value);
  firebaseRenderCountdown();
}

// ===================== LOADING OVERLAY (dipakai saat ganti pasaran) =====================
function showLoadingOverlay(text){
  const el = document.getElementById('loadingOverlay');
  if(!el) return;
  const txt = document.getElementById('loadingOverlayText');
  if(txt) txt.textContent = text || 'Memproses...';
  el.classList.add('show');
}
function hideLoadingOverlay(){
  const el = document.getElementById('loadingOverlay');
  if(el) el.classList.remove('show');
}

function firebaseLoadSelectedData({auto=false}={}){
  const kode = firebaseSelectedKode();
  if(!kode) return false;
  const entry = firebaseMarketMap[kode];
  if(!entry || typeof entry.data !== 'string' || !entry.data.trim()){
    firebaseSetBadge('Data kosong', false);
    const last = document.getElementById('firebaseLastUpdate');
    if(last) last.textContent = 'Data Firebase diterima: pasaran belum memiliki data.';
    firebaseRenderCountdown();
    return false;
  }

  // Tampilkan loading dulu, lalu kasih browser kesempatan menggambar overlay-nya (setTimeout 0ms)
  // SEBELUM proses berat (analyze + pipeline Formula X/Generate/Filter) jalan — proses ini semua
  // sinkron (blocking), jadi tanpa jeda ini overlay-nya tidak akan sempat kelihatan.
  showLoadingOverlay(auto ? 'Memuat pasaran terbaru...' : 'Memproses ganti pasaran...');
  setTimeout(() => {
    try{
      // PENTING: hanya baca. Tidak memanggil setSavedEntries(), API S2, /api/cron,
      // /api/sync, atau endpoint Neon apa pun.
      document.getElementById('dataInput').value = entry.data;
      currentLoadedDataName = kode;
      document.getElementById('saveNameInput').value = kode;
      renderFilterLoadedName();

      // Kalau Mode Auto/Semi Auto sedang aktif, Preset yang pegang kendali pengaturan — JANGAN
      // ditimpa lagi oleh "pengaturan bawaan pasaran" lama (entry.settings) di bawah, yang bisa
      // kosong/default kalau pasaran ini belum pernah disimpan manual (itu penyebab pengaturan
      // "kembali ke 0" tiap ganti pasaran). Cukup analyze() — hook Mode di dalamnya yang akan
      // melanjutkan pipeline pakai Preset Aktif.
      const _mode = (typeof getAppMode === 'function') ? getAppMode() : 'normal';
      if(_mode === 'auto' || _mode === 'semi'){
        analyze();
      } else {
        resetAllSettings();
        applyAllSettings(entry.settings);
      }

      firebaseSetBadge(auto ? 'LIVE · Firebase ✓' : 'Firebase ✓', true);
      const last = document.getElementById('firebaseLastUpdate');
      if(last) last.textContent = `Data Firebase diterima: ${new Date().toLocaleString('id-ID')} · ${parseData(entry.data).length} data`;
      firebaseRenderCountdown();
    } finally {
      hideLoadingOverlay();
    }
  }, 30);
  return true;
}

function firebaseReceiveMasterData(value, auto=false){
  const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
  firebaseMarketEntries = list.filter(e => e && typeof e === 'object' && e.name && typeof e.data === 'string');
  firebaseMarketMap = {};
  firebaseMarketEntries.forEach(e => { firebaseMarketMap[String(e.name)] = e; });
  firebasePopulateMarkets();
  firebaseDataReady = true;
  firebaseLoadSelectedData({auto});
}

function initFirebaseS1Data(){
  if(!db){
    firebaseSetBadge('Firebase tidak tersedia', false);
    return;
  }
  authReadyPromise.then(isAuthed => {
    if(!isAuthed){
      firebaseSetBadge('Auth gagal', false);
      return;
    }
    db.ref(FIREBASE_DATA_PATH).on('value', snap => {
      try{
        firebaseReceiveMasterData(snap.val(), firebaseDataReady);
      }catch(e){
        console.error('Gagal memproses data Firebase untuk S1:', e);
        firebaseSetBadge('Data error', false);
      }
    }, err => {
      console.error('Gagal membaca Firebase:', err);
      firebaseSetBadge('Gagal baca Firebase', false);
    });
  });
}

function firebaseRenderMarketDropdownOnOpen(){
  firebaseRefreshMarketDropdown();
}

const firebaseMarketSelectEl = document.getElementById('firebaseMarketSelect');
if(firebaseMarketSelectEl){
  // Native <select> tidak punya event "open" yang konsisten di semua browser.
  // Refresh saat focus/mousedown/touchstart agar urutan dan countdown selalu terbaru.
  ['focus','mousedown','touchstart'].forEach(evt => {
    firebaseMarketSelectEl.addEventListener(evt, () => firebaseRenderMarketDropdownOnOpen(), {passive:true});
  });
  firebaseMarketSelectEl.addEventListener('change', () => {
    const kode = firebaseSelectedKode();
    if(kode){
      firebaseSetSelectedKode(kode); // ikut ganti dropdown Periode di Analisis
      localStorage.setItem(FIREBASE_MARKET_KEY, kode);
    }
    firebaseLoadSelectedData({auto:false});
  });
}

// Dropdown "Periode" di halaman Analisis — pasaran yang sama persis dengan
// firebaseMarketSelect di Beranda, dua arah saling sinkron.
const analisisPeriodeSelectEl = document.getElementById('analisisPeriodeSelect');
if(analisisPeriodeSelectEl){
  ['focus','mousedown','touchstart'].forEach(evt => {
    analisisPeriodeSelectEl.addEventListener(evt, () => firebaseRenderMarketDropdownOnOpen(), {passive:true});
  });
  analisisPeriodeSelectEl.addEventListener('change', () => {
    const kode = analisisPeriodeSelectEl.value;
    if(kode){
      firebaseSetSelectedKode(kode); // ikut ganti dropdown pasaran di Beranda
      localStorage.setItem(FIREBASE_MARKET_KEY, kode);
    }
    firebaseLoadSelectedData({auto:false});
  });
}

firebaseCountdownTimer = setInterval(firebaseRenderCountdown, 1000);
initFirebaseS1Data();


// tampilan awal dikosongkan — tunggu user tempel data sendiri, kecuali ada link bagikan di URL
window.addEventListener('DOMContentLoaded', () => {
  restoreFromShareLink().then(restored => {
    if(restored) return;
    document.getElementById('dataInput').value = '';
    analyze();
  });
});


// ===== Floating menu: Input / Refresh / Repair / Update =====
let quickFabUnlocked = false; // sekali kode benar dimasukkan, tetap terbuka selama halaman belum di-reload
document.getElementById('quickFabToggle').addEventListener('click', () => {
  const panel = document.getElementById('quickFabPanel');
  if(panel.classList.contains('open')){
    panel.classList.remove('open');
    return;
  }
  if(!quickFabUnlocked){
    const code = prompt('Masukkan kode akses:');
    if(code === null) return; // dibatalkan, jangan buka
    if(code.trim() !== '13579'){
      alert('Kode salah.');
      return;
    }
    quickFabUnlocked = true;
  }
  panel.classList.add('open');
});

async function fxCallWorkerEndpoint(url, btnId, feedbackId, labelSukses){
  const btn = document.getElementById(btnId);
  const fb = document.getElementById(feedbackId);
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Memproses...';
  fb.style.color = 'var(--ink-dim)';
  fb.textContent = 'Menghubungi server...';
  try{
    const res = await fetch(url);
    const data = await res.json();
    if(data && data.ok && Array.isArray(data.summary)){
      const changed = data.summary.filter(s => !/sudah (rapi|update)[, ]/i.test(String(s)) && !/tidak (diubah|ada data baru)/i.test(String(s)));
      fb.style.color = 'var(--teal)';
      fb.textContent = changed.length
        ? `${labelSukses} — ${changed.length} pasaran ada perubahan.`
        : `${labelSukses} — semua pasaran sudah rapi/terbaru, tidak ada perubahan.`;
    } else {
      fb.style.color = '#ff6b6b';
      fb.textContent = 'Selesai, tapi respons server tidak sesuai dugaan.';
    }
  }catch(e){
    fb.style.color = '#ff6b6b';
    fb.textContent = 'Gagal menghubungi server: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = original;
}

document.getElementById('repairOrderBtn').addEventListener('click', () => {
  fxCallWorkerEndpoint('https://ag.bhga.workers.dev/api/fix-order', 'repairOrderBtn', 'repairFeedback', 'Repair selesai');
});

document.getElementById('syncNowBtn').addEventListener('click', () => {
  fxCallWorkerEndpoint('https://ag.bhga.workers.dev/api/sync-now', 'syncNowBtn', 'syncNowFeedback', 'Update selesai');
});

