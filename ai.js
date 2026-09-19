// ===================== AI (formula ke-8 Formula X) =====================
// Model kecil buatan sendiri, jalan langsung di browser (tanpa server): regresi softmax ONLINE, satu model
// per posisi target (A, C, K, E, ...). Inputnya riwayat angka, outputnya skor 10 digit per posisi; aplikasi
// mengambil FX_OUT_N (dropdown Out) digit teratas sebagai pool. Dimuat SETELAH formulax.js.
//
// Fitur (untuk memprediksi baris ke-k, HANYA memakai baris sebelum k):
//   - bias
//   - digit 2 baris terakhir, semua posisi (one-hot)
//   - frekuensi tiap digit di posisi target pada AI_WINDOW baris terakhir
//   - "sudah berapa baris tidak muncul" tiap digit di posisi target (recency)
//
// JALAN-MAJU (tanpa kebocoran data): prediksi untuk baris k dibuat dari model yang HANYA dilatih dengan
// baris 0..k-1. Karena itu Ps/Sr hasil backtest Formula X jujur — model tidak pernah "melihat" baris yang
// sedang diuji. Semua perhitungan deterministik (bobot awal nol, tanpa Math.random).
//
// Cara kerja cache: backtest memanggil fn() ribuan kali dengan jendela data yang makin pendek/panjang. Satu
// kali jalan-maju atas data terpanjang menyimpan prediksi untuk SEMUA k sekaligus, jadi pemanggilan berikutnya
// tinggal mengambil dari cache. Kalau data bertambah (baris baru), model dilanjutkan, bukan dilatih ulang.

const AI_WINDOW = 30;    // jendela frekuensi & recency (baris)
const AI_LR = 0.05;      // learning rate SGD
const AI_L2 = 1e-4;      // regularisasi L2
const AI_MAX_CACHES = 4; // jumlah dataset yang disimpan bersamaan
let AI_CACHES = [];

// Baris "1234" -> [1,2,3,4] (L digit pertama). Data tidak valid -> error, TIDAK ditebak/dilewati.
function aiParseRow(str, L){
  if(typeof str !== 'string' || str.length < L || /\D/.test(str.slice(0, L))){
    throw new Error('Data AI: nomor "' + str + '" tidak valid (butuh minimal ' + L + ' digit angka).');
  }
  const r = new Array(L);
  for(let q = 0; q < L; q++) r[q] = str.charCodeAt(q) - 48;
  return r;
}

function aiFeatureSize(L){ return 1 + 2 * L * 10 + 20; }

// Vektor fitur untuk memprediksi baris ke-k di posisi p (C = baris kronologis lama->baru, sudah berupa array digit).
function aiFeatures(C, k, L, p, x){
  x.fill(0);
  let o = 0;
  x[o++] = 1; // bias
  for(let lag = 1; lag <= 2; lag++){
    const r = C[k - lag];
    if(r){ for(let q = 0; q < L; q++) x[o + q * 10 + r[q]] = 1; }
    o += L * 10;
  }
  const start = Math.max(0, k - AI_WINDOW);
  const span = k - start;
  const cnt = new Array(10).fill(0);
  const last = new Array(10).fill(-1);
  for(let j = start; j < k; j++){ const d = C[j][p]; cnt[d]++; last[d] = j; }
  for(let d = 0; d < 10; d++){
    x[o + d] = span ? cnt[d] / span : 0;
    x[o + 10 + d] = last[d] < 0 ? 1 : Math.min(1, (k - 1 - last[d]) / AI_WINDOW);
  }
}

function aiSoftmax(W, x, F, probs){
  let mx = -Infinity;
  for(let c = 0; c < 10; c++){
    let s = 0;
    const base = c * F;
    for(let f = 0; f < F; f++) s += W[base + f] * x[f];
    probs[c] = s;
    if(s > mx) mx = s;
  }
  let sum = 0;
  for(let c = 0; c < 10; c++){ probs[c] = Math.exp(probs[c] - mx); sum += probs[c]; }
  for(let c = 0; c < 10; c++) probs[c] /= sum;
}

// Satu langkah latih (SGD) untuk posisi p: fitur dari baris < t, label = digit baris t.
function aiTrainStep(state, C, t, L, p){
  const F = state.F, W = state.W[p], x = state.x, probs = state.probs;
  aiFeatures(C, t, L, p, x);
  aiSoftmax(W, x, F, probs);
  const y = C[t][p];
  for(let c = 0; c < 10; c++){
    const g = probs[c] - (c === y ? 1 : 0);
    const base = c * F;
    for(let f = 0; f < F; f++) W[base + f] -= AI_LR * (g * x[f] + AI_L2 * W[base + f]);
  }
}

// Peringkat 10 digit (string) untuk posisi p dari fitur baris ke-k. Seri -> digit lebih kecil dulu (deterministik).
function aiRank(state, C, k, L, p){
  aiFeatures(C, k, L, p, state.x);
  aiSoftmax(state.W[p], state.x, state.F, state.probs);
  const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const pr = state.probs.slice();
  idx.sort((a, b) => (pr[b] - pr[a]) || (a - b));
  return idx.map(String);
}

// Lanjutkan jalan-maju sampai prediksi untuk k = cache.n tersedia (cache.k = k terakhir yang sudah dihitung).
function aiAdvance(cache){
  const { C, L, state } = cache;
  for(let k = cache.k + 1; k <= C.length; k++){
    if(k - 1 >= 1){ for(let p = 0; p < L; p++) aiTrainStep(state, C, k - 1, L, p); } // latih dengan target baris k-1 (fitur < k-1)
    const ranked = [];
    for(let p = 0; p < L; p++) ranked.push(aiRank(state, C, k, L, p));
    cache.preds[k] = ranked;
    cache.k = k;
  }
}

function aiNewCache(windowNewestFirst, L){
  const n = windowNewestFirst.length;
  const raw = new Array(n), C = new Array(n);
  for(let j = 0; j < n; j++){
    raw[j] = windowNewestFirst[n - 1 - j];
    C[j] = aiParseRow(raw[j], L);
  }
  const F = aiFeatureSize(L);
  const state = {
    F, x: new Float64Array(F), probs: new Float64Array(10),
    W: Array.from({ length: L }, () => new Float64Array(10 * F))
  };
  const cache = { L, raw, C, state, preds: [], k: 0 };
  aiAdvance(cache);
  AI_CACHES.push(cache);
  if(AI_CACHES.length > AI_MAX_CACHES) AI_CACHES.shift();
  return cache;
}

// Cache dianggap cocok kalau baris-baris sampelnya (ujung + 7 titik tersebar) sama dengan jendela yang diminta.
function aiCacheMatches(cache, windowNewestFirst, L){
  if(cache.L !== L) return false;
  const k = windowNewestFirst.length;
  const m = Math.min(k, cache.raw.length);
  const probes = [0, m - 1];
  for(let i = 1; i <= 7; i++) probes.push(Math.floor((m - 1) * i / 8));
  return probes.every(j => cache.raw[j] === windowNewestFirst[k - 1 - j]);
}

function aiExtendCache(cache, windowNewestFirst){
  const k = windowNewestFirst.length;
  for(let j = cache.raw.length; j < k; j++){
    const s = windowNewestFirst[k - 1 - j];
    cache.raw.push(s);
    cache.C.push(aiParseRow(s, cache.L));
  }
  aiAdvance(cache);
}

// Peringkat digit per posisi (array L berisi 10 digit) untuk memprediksi baris SETELAH jendela ini.
// windowNewestFirst = data sebelum baris target, urutan terbaru -> lama (sama seperti formula lain).
function aiRankedForWindow(windowNewestFirst, L){
  const k = windowNewestFirst.length;
  if(k < FX_AI_MIN_ROWS) throw new Error('Data AI belum cukup (minimal ' + FX_AI_MIN_ROWS + ', tersedia ' + k + ').');
  let cache = AI_CACHES.find(c => aiCacheMatches(c, windowNewestFirst, L));
  if(!cache) cache = aiNewCache(windowNewestFirst, L);
  else if(k > cache.raw.length) aiExtendCache(cache, windowNewestFirst);
  return cache.preds[k];
}

// Dipakai fn formula 'AI' di fxBuildFormulaList: pool per posisi target = FX_OUT_N digit teratas modelnya sendiri.
function aiPoolsFromWindow(windowNewestFirst, L){
  return aiRankedForWindow(windowNewestFirst, L).map(r => r.slice(0, FX_OUT_N));
}

// Buang semua model tersimpan (mis. untuk uji atau kalau data historis diganti total).
function aiResetCache(){ AI_CACHES = []; }
