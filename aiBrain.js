// ===================== AI BRAIN (mesin Mode Ai) =====================
// Mesin belajar untuk Mode Ai. TIDAK menyentuh DOM (bisa diuji di Node). Dimuat SEBELUM aiMode.js.
//
// Prinsip kerja (jujur, bukan "pasti benar"):
//  1. PAKAR (expert): setiap formula Formula X (NRL/ML/MB/IDX/BHG/PK, per posisi sumber) + pakar milik Ai sendiri
//     (frekuensi, jarak tak muncul, transisi antar-posisi, pola "digit draw lalu ikut lagi") masing-masing memberi
//     peluang untuk 10 digit di tiap posisi. Ada 1 pakar "ACAK MURNI" sebagai pembanding.
//  2. CAMPURAN BAYES per (pasaran, posisi): bobot tiap pakar naik/turun setiap ada hasil baru (belajar dari salah).
//     Bobot awal 50% ditaruh di ACAK MURNI: kalau tidak ada pakar yang terbukti lebih baik dari acak, Ai memang
//     akan mendekati acak dan JUJUR bilang "belum ada pola". Ada "fixed-share" supaya formula yang lama bagus lalu
//     gagal bisa cepat ditinggalkan.
//     PAKAR INTI (v2): NOREP (digit sama di posisi sama jarang ulang), FRQALL (frekuensi seluruh riwayat pasaran) dan
//     FRQNOREP (gabungan keduanya) — pola nyata di data 95 pasaran contoh. Pakar lain (formula Formula X dll) MULAI
//     NYARIS MATI dan baru hidup kalau lolos gerbang bukti lintas-pasaran (langkah 5): hasil uji, pakar-pakar itu
//     tidak lebih baik dari acak sehingga hanya menambah noise pada peringkat digit. Fixed-share diarahkan ke bobot
//     awal (prior), bukan dibagi rata, supaya pakar yang dimatikan tidak hidup lagi lewat berbagi bobot.
//     v3 menambah tiga pakar inti yang bobotnya dipelajari per pasaran: DELTA (pola perubahan digit), GAP (lama digit
//     tidak hadir di posisi itu) dan HYPE (digit yang sedang ramai di SEMUA pasaran pada 2 tanggal terakhir — sengaja
//     pendek, seminggu itu basi). HYPE butuh tanggal: aiMode memanggil setHypeMarkets(semua pasaran) dan mengirim
//     opts.dates ke learnMarket/predict; tanpa itu HYPE diam (distribusi acak), tidak menebak.
//  3. JALAN-MAJU: belajar mulai dari 10 data terlama, maju satu-satu. Prediksi baris t HANYA memakai baris < t,
//     jadi skor uji tidak bocor.
//  4. LAB EKSPERIMEN: berkala Ai mencoba menggabung 2 pakar (geometri / perkalian). Kombinasi baru hanya diterima
//     kalau untung di data latih DAN di data validasi (potongan waktu berbeda) — dan hanya memakai data masa lalu.
//  5. BELAJAR ANTAR PASARAN: skor tiap pakar dijumlah lintas semua pasaran; hanya pakar yang lolos uji signifikansi
//     (dikoreksi karena banyak pakar dicoba) yang mendapat bobot awal lebih besar di semua pasaran.
(function(root){
'use strict';

const T0 = 10;            // mulai belajar dari 10 data terlama
const EVAL_FROM = 30;     // uji jujur resmi dihitung mulai baris ini (setelah masa pemanasan)
const EPS = 1e-4;
const ETA = 1.0;          // kecepatan belajar bobot
const SHARE = 0.003;      // fixed-share (ke prior): peluang pindah pakar. Kecil karena sinyal di data ini sangat lemah
const DECAY = 0.97;       // peluruhan skor "keuntungan terkini"
const LAB_START = 40, LAB_EVERY = 20, MAX_COMBOS = 6, LAB_TOPK = 8, LAB_ADMIT = 2;
const LAB_MIN_T = 2.5;    // ambang uji-t kombinasi baru di tiap potongan waktu
const GATE_Z = 3.5;       // ambang z global (kira-kira p<0,01 setelah koreksi ~50 pakar)
const LN_UNI = Math.log(0.1);
// Prior dari 50% awal data contoh (95 pasaran): perubahan digit (t - t-1 mod 10) dan peluang muncul menurut lama absen (0..6+)
const DELTA_PRIOR = [0.0813, 0.102, 0.1071, 0.0993, 0.1007, 0.1039, 0.1058, 0.0983, 0.1021, 0.0996], DELTA_K = 10;
const GAP_PRIOR = [0.0833, 0.0985, 0.1043, 0.1041, 0.1065, 0.1023, 0.1011], GAP_K = 200;
const REP_PRIOR = 0.085, REP_K = 100; // laju "digit sama di posisi sama" ~8,5% (bukan 10%) — prior, lalu dikoreksi data pasaran itu sendiri

const MAPS = {
  NRL: null,
  ML:  [1,0,5,8,7,2,9,4,3,6],
  MB:  [8,7,6,9,5,4,2,1,0,3],
  IDX: [5,6,7,8,9,0,1,2,3,4]
};

function posLabels(L){ return L === 4 ? ['A','C','K','E'] : Array.from({length: L}, (_, i) => String(i + 1)); }

// ---------- Parsing ----------
// Teks pasaran format aplikasi: baris "tanggal<TAB>periode<TAB>nomor", terbaru di atas.
// Kembalikan array digit KRONOLOGIS (lama -> baru). Baris tidak valid dilewati (dihitung di skipped).
// "19-09-2026" -> "2026-09-19" (bisa diurutkan); tidak terbaca -> ''
function isoDate(s){
  const m = /^\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(String(s || ''));
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}
function parseMarketText(text){
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const nums = [], dts = [];
  let skipped = 0;
  lines.forEach(line => {
    const cols = line.split('\t');
    const n = cols[cols.length - 1].trim();
    if(/^\d{2,8}$/.test(n)){ nums.push(n); dts.push(isoDate(cols.length > 1 ? cols[0] : '')); } else skipped++;
  });
  // panjang dominan
  const cnt = {};
  nums.forEach(n => { cnt[n.length] = (cnt[n.length] || 0) + 1; });
  let L = 0, best = 0;
  Object.keys(cnt).forEach(k => { if(cnt[k] > best){ best = cnt[k]; L = +k; } });
  const keep = nums.map((n, i) => i).filter(i => nums[i].length === L);
  const rows = keep.map(i => nums[i]).reverse();   // lama -> baru
  const dates = keep.map(i => dts[i]).reverse();   // tanggal (yyyy-mm-dd, '' kalau tidak terbaca) sejajar dengan baris
  return { L, C: rows.map(n => n.split('').map(Number)), dates, skipped: skipped + (nums.length - rows.length) };
}
function parseNumberList(newestFirstStrings){
  const nums = (newestFirstStrings || []).filter(n => /^\d{2,8}$/.test(String(n)));
  const cnt = {}; nums.forEach(n => { cnt[n.length] = (cnt[n.length] || 0) + 1; });
  let L = 0, best = 0; Object.keys(cnt).forEach(k => { if(cnt[k] > best){ best = cnt[k]; L = +k; } });
  const rows = nums.filter(n => n.length === L).reverse();
  return { L, C: rows.map(n => String(n).split('').map(Number)), skipped: nums.length - rows.length };
}

// ---------- HYPE lintas pasaran (jendela pendek) ----------
// Digit yang sedang ramai muncul di SEMUA pasaran pada HYPE_DAYS tanggal terakhir SEBELUM baris yang diprediksi
// (bukan seminggu: itu basi). Untuk periode berikutnya (tanggalnya belum ada) dipakai HYPE_DAYS tanggal terakhir yang ada.
const HYPE_DAYS = 2, HYPE_K = 20;
let HYPE_IDX = {}, HYPE_CACHE = new Map();
function setHypeMarkets(ms){
  const idx = {};
  Object.keys(ms || {}).forEach(name => {
    const pm = ms[name]; if(!pm || !pm.dates) return;
    const g = idx[pm.L] || (idx[pm.L] = { cnt: {}, n: {}, dates: [] });
    pm.C.forEach((row, t) => {
      const dt = pm.dates[t]; if(!dt) return;
      if(!g.cnt[dt]){ g.cnt[dt] = new Int32Array(pm.L * 10); g.n[dt] = 0; }
      for(let p = 0; p < pm.L; p++) g.cnt[dt][p * 10 + row[p]]++;
      g.n[dt]++;
    });
  });
  Object.keys(idx).forEach(L => { idx[L].dates = Object.keys(idx[L].cnt).sort(); });
  HYPE_IDX = idx; HYPE_CACHE = new Map();
}
function nextDayIso(iso){
  if(!iso) return '';
  const d = new Date(iso + 'T00:00:00Z'); if(isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}
function hypeWindow(L, dateIso){
  const key = L + '|' + dateIso;
  if(HYPE_CACHE.has(key)) return HYPE_CACHE.get(key);
  const g = HYPE_IDX[L]; let res = null;
  if(g){
    const ds = g.dates; let hi = ds.length;
    if(dateIso){ let lo = 0; while(lo < hi){ const mid = (lo + hi) >> 1; if(ds[mid] < dateIso) lo = mid + 1; else hi = mid; } hi = lo; }
    const use = ds.slice(Math.max(0, hi - HYPE_DAYS), hi);
    if(use.length){
      const cnt = new Int32Array(L * 10); let n = 0;
      use.forEach(dt => { const c = g.cnt[dt]; for(let i = 0; i < L * 10; i++) cnt[i] += c[i]; n += g.n[dt]; });
      res = { cnt, n };
    }
  }
  HYPE_CACHE.set(key, res);
  return res;
}

// ---------- Registry pakar ----------
function makeRegistry(L, extRefs){
  const lab = posLabels(L);
  const ex = [{ id: 'NULL', fam: 'NULL', kind: 'null', name: 'Acak murni (pembanding)' }];
  ['NRL','ML','MB','IDX'].forEach(base => {
    [10, 30].forEach(ctrl => {
      for(let s = 0; s < L; s++) ex.push({ id: base + ctrl + '_' + lab[s], fam: base, kind: 'stat', base, ctrl, s, name: base + ' ' + lab[s] + ' (ctrl ' + ctrl + ')' });
    });
  });
  for(let s = 0; s < L; s++) ex.push({ id: 'BHG_' + lab[s], fam: 'BHG', kind: 'bhg', s, name: 'BHG ' + lab[s] });
  for(let s = 0; s < L; s++) ex.push({ id: 'PK_' + lab[s], fam: 'PK', kind: 'pk', s, name: 'PK ' + lab[s] });
  [5, 10, 30, 90].forEach(W => ex.push({ id: 'FRQ' + W, fam: 'OWN', kind: 'frq', W, name: 'Frekuensi ' + W + ' data terakhir' }));
  ex.push({ id: 'OVERDUE', fam: 'OWN', kind: 'overdue', name: 'Digit lama tak muncul' });
  for(let q = 0; q < L; q++) ex.push({ id: 'X_' + lab[q], fam: 'OWN', kind: 'xpos', q, name: 'Transisi dari posisi ' + lab[q] + ' draw lalu' });
  ex.push({ id: 'REPEAT', fam: 'OWN', kind: 'repeat', name: 'Digit draw lalu ikut lagi' });
  ex.push({ id: 'NOREP', fam: 'OWN', kind: 'norep', name: 'Digit sama di posisi sama jarang ulang' });
  ex.push({ id: 'FRQALL', fam: 'OWN', kind: 'frqall', name: 'Frekuensi seluruh riwayat pasaran' });
  ex.push({ id: 'FRQNOREP', fam: 'OWN', kind: 'frqnorep', name: 'Frekuensi pasaran x tanpa-ulang' });
  ex.push({ id: 'DELTA', fam: 'OWN', kind: 'delta', name: 'Pola perubahan digit (digit berikut = digit lalu + selisih yang sering)' });
  ex.push({ id: 'GAP', fam: 'OWN', kind: 'gap', name: 'Lama digit tidak hadir di posisi ini' });
  ex.push({ id: 'HYPE', fam: 'OWN', kind: 'hype', name: 'Digit yang sedang ramai di semua pasaran (2 tanggal terakhir)' });
  // Pakar SILANG PASARAN (hipotesis: hasil pasaran lain di HARI YANG SAMA berkaitan dengan pasaran
  // ini) — 1 pakar per (pasaran-referensi, posisi-di-pasaran-referensi-itu). Diuji & ditimbang
  // PERSIS sama seperti pakar lain — kalau memang tidak ada kaitannya, bobotnya akan tetap kecil.
  (extRefs || []).forEach(ref => {
    const refLab = posLabels(ref.L);
    for(let r = 0; r < ref.L; r++){
      ex.push({ id: 'XM_' + ref.name + '_' + refLab[r], fam: 'XMKT', kind: 'xmkt', ref: ref.name, r,
        name: 'Pasaran ' + ref.name + ' pos ' + refLab[r] + ' (hari sama)' });
    }
  });
  const idx = {}; ex.forEach((e, i) => { idx[e.id] = i; });
  return { L, lab, ex, idx };
}

// ---------- Peluang tiap pakar untuk baris ke-t (hanya memakai baris < t) ----------
// Hasil: Float64Array(E0 * L * 10), indeks ((e*L)+p)*10 + digit
function baseP(C, t, reg, ctx){
  const L = reg.L, E0 = reg.ex.length;
  const out = new Float64Array(E0 * L * 10);
  const v = new Float64Array(10);
  const put = (e, p) => { out.set(v, (e * L + p) * 10); };
  const uni = () => { for(let d = 0; d < 10; d++) v[d] = 0.1; };
  const norm = () => { let s = 0; for(let d = 0; d < 10; d++) s += v[d]; for(let d = 0; d < 10; d++) v[d] /= s; };
  for(let e = 0; e < E0; e++){
    const x = reg.ex[e];
    if(x.kind === 'null'){ uni(); for(let p = 0; p < L; p++) put(e, p); continue; }
    if(x.kind === 'stat'){
      if(t < 3) uni(); else {
        const mp = MAPS[x.base], m = d => mp ? mp[d] : d;
        const lo = Math.max(0, t - x.ctrl), cnt = new Array(10).fill(0);
        let tot = 0;
        for(let j = lo; j < t - 1; j++){ cnt[(m(C[j + 1][x.s]) - m(C[j][x.s]) + 10) % 10]++; tot++; }
        const last = m(C[t - 1][x.s]);
        for(let d = 0; d < 10; d++) v[d] = (cnt[(d - last + 10) % 10] + 1) / (tot + 10);
      }
      for(let p = 0; p < L; p++) put(e, p);
      continue;
    }
    if(x.kind === 'bhg'){
      if(t < 19) uni(); else {
        const d0 = C[t - 1][x.s], inPool = new Array(10).fill(false);
        for(let i = 1; i <= 4; i++) inPool[(d0 + i) % 10] = true;
        inPool[d0] = true;
        for(let i = 1; i <= 3; i++) inPool[((d0 - i) % 10 + 10) % 10] = true;
        for(let d = 0; d < 10; d++) v[d] = inPool[d] ? 0.85 / 8 : 0.15 / 2;
      }
      for(let p = 0; p < L; p++) put(e, p);
      continue;
    }
    if(x.kind === 'pk'){
      if(t < 19) uni(); else {
        const lo = Math.max(0, t - 29), anchor = C[t - 1][x.s], cnt = new Array(10).fill(0);
        let tot = 0;
        for(let j = lo + 1; j < t; j++){
          if(C[j].indexOf(anchor) >= 0){ cnt[C[j - 1][x.s]]++; tot++; }
        }
        for(let d = 0; d < 10; d++) v[d] = (cnt[d] + 0.5) / (tot + 5);
      }
      for(let p = 0; p < L; p++) put(e, p);
      continue;
    }
    for(let p = 0; p < L; p++){
      if(x.kind === 'frq'){
        const lo = Math.max(0, t - x.W), cnt = new Array(10).fill(0);
        for(let j = lo; j < t; j++) cnt[C[j][p]]++;
        for(let d = 0; d < 10; d++) v[d] = (cnt[d] + 1) / ((t - lo) + 10);
      } else if(x.kind === 'overdue'){
        const last = new Array(10).fill(-1);
        for(let j = 0; j < t; j++) last[C[j][p]] = j;
        for(let d = 0; d < 10; d++){ const gap = last[d] < 0 ? 30 : Math.min(30, t - 1 - last[d]); v[d] = 1 + gap / 15; }
        norm();
      } else if(x.kind === 'xpos'){
        if(t < 2) uni(); else {
          const cnt = Array.from({ length: 10 }, () => new Array(10).fill(0));
          for(let j = 1; j < t; j++) cnt[C[j - 1][x.q]][C[j][p]]++;
          const a = C[t - 1][x.q]; let s = 0;
          for(let d = 0; d < 10; d++) s += cnt[a][d];
          for(let d = 0; d < 10; d++) v[d] = (cnt[a][d] + 1) / (s + 10);
        }
      } else if(x.kind === 'norep' || x.kind === 'frqall' || x.kind === 'frqnorep'){
        if(t < 2) uni(); else {
          const d0 = C[t - 1][p], cnt = new Array(10).fill(0);
          for(let j = 0; j < t; j++) cnt[C[j][p]]++;
          if(x.kind === 'frqall'){
            for(let d = 0; d < 10; d++) v[d] = (cnt[d] + 1) / (t + 10);
          } else {
            // laju digit-sama-di-posisi-sama dari riwayat pasaran ini, ditarik ke prior (REP_K data)
            let reps = 0; for(let j = 1; j < t; j++) if(C[j][p] === C[j - 1][p]) reps++;
            const r = Math.min(0.25, Math.max(0.01, (reps + REP_K * REP_PRIOR) / ((t - 1) + REP_K)));
            if(x.kind === 'norep'){
              for(let d = 0; d < 10; d++) v[d] = d === d0 ? r : (1 - r) / 9;
            } else {
              for(let d = 0; d < 10; d++) v[d] = ((cnt[d] + 1) / (t + 10)) * (d === d0 ? r / 0.1 : (1 - r) / 0.9);
              norm();
            }
          }
        }
      } else if(x.kind === 'delta'){
        if(t < 3) uni(); else {
          const c = DELTA_PRIOR.map(q => q * DELTA_K), d0 = C[t - 1][p];
          for(let j = 1; j < t; j++) c[((C[j][p] - C[j - 1][p]) % 10 + 10) % 10]++;
          for(let d = 0; d < 10; d++) v[d] = c[((d - d0) % 10 + 10) % 10];
          norm();
        }
      } else if(x.kind === 'gap'){
        if(t < 25) uni(); else {
          // laju muncul per lama-absen dipelajari dari riwayat pasaran ini, ditarik ke prior (GAP_K data)
          const hit = new Array(7).fill(0), tot = new Array(7).fill(0), gap = new Array(10).fill(0);
          for(let j = 0; j < t; j++){
            if(j >= 20) for(let d = 0; d < 10; d++){ const g = Math.min(gap[d], 6); tot[g]++; if(C[j][p] === d) hit[g]++; }
            for(let d = 0; d < 10; d++) gap[d] = C[j][p] === d ? 0 : gap[d] + 1;
          }
          for(let d = 0; d < 10; d++){ const g = Math.min(gap[d], 6); v[d] = (hit[g] + GAP_K * GAP_PRIOR[g]) / (tot[g] + GAP_K); }
          norm();
        }
      } else if(x.kind === 'hype'){
        const hasRow = t < C.length, ds = ctx && ctx._dates;
        // baris lama: tanggal barisnya sendiri; periode berikutnya: sehari setelah baris terakhir pasaran itu. Tanggal tak terbaca -> tidak dipakai (bukan ditebak)
        const dt = !ds ? '' : (hasRow ? ds[t] : nextDayIso(ds[C.length - 1]));
        const w = (!ctx || !dt) ? null : hypeWindow(ctx.L, dt);   // baris lama tanpa tanggal -> tidak dipakai (bukan ditebak)
        if(!w || w.n < 5) uni(); else for(let d = 0; d < 10; d++) v[d] = (w.cnt[p * 10 + d] + HYPE_K * 0.1) / (w.n + HYPE_K);
      } else if(x.kind === 'xmkt'){
        // Digit pasaran LAIN (x.ref) di posisi x.r, pada TANGGAL YANG SAMA — refArr[j] disiapkan
        // pemanggil (aiMode), sejajar dengan baris C. -1 berarti pasaran referensi tidak ada data hari itu.
        const refArr = ctx && ctx.refSeries && ctx.refSeries[x.ref] && ctx.refSeries[x.ref][x.r];
        const today = refArr ? refArr[t] : -1;
        if(!refArr || today == null || today < 0) uni();
        else {
          const cnt = Array.from({ length: 10 }, () => new Array(10).fill(0));
          let any = false;
          for(let j = 0; j < t; j++){
            const rd = refArr[j];
            if(rd == null || rd < 0) continue;
            cnt[rd][C[j][p]]++; any = true;
          }
          if(!any) uni();
          else {
            let s = 0; for(let d = 0; d < 10; d++) s += cnt[today][d];
            for(let d = 0; d < 10; d++) v[d] = (cnt[today][d] + 1) / (s + 10);
          }
        }
      } else if(x.kind === 'repeat'){
        if(t < 2) uni(); else {
          const setPrev = new Set(C[t - 1]), k = setPrev.size;
          let hits = 0, n = 0;
          for(let j = 1; j < t; j++){ if(C[j - 1].indexOf(C[j][p]) >= 0) hits++; n++; }
          const r = (hits + (k / 10) * 10) / (n + 10);
          for(let d = 0; d < 10; d++) v[d] = setPrev.has(d) ? r / k : (k >= 10 ? 0.1 : (1 - r) / (10 - k));
        }
      }
      put(e, p);
    }
  }
  return out;
}

// ---------- Distribusi tiap pakar (dasar + kombinasi) untuk posisi p ----------
function posDists(bp, reg, p, combos){
  const L = reg.L, E0 = reg.ex.length, res = [];
  for(let e = 0; e < E0; e++) res.push(bp.subarray((e * L + p) * 10, (e * L + p) * 10 + 10));
  (combos || []).forEach(cb => {
    const a = res[reg.idx[cb.a]], b = res[reg.idx[cb.b]], v = new Float64Array(10);
    let s = 0;
    for(let d = 0; d < 10; d++){ v[d] = cb.op === 'geo' ? Math.sqrt(a[d] * b[d]) : a[d] * b[d]; s += v[d]; }
    for(let d = 0; d < 10; d++) v[d] /= s;
    res.push(v);
  });
  return res;
}

function softmaxInto(lw, w){
  let mx = -Infinity; for(let i = 0; i < lw.length; i++) if(lw[i] > mx) mx = lw[i];
  let s = 0; for(let i = 0; i < lw.length; i++){ w[i] = Math.exp(lw[i] - mx); s += w[i]; }
  for(let i = 0; i < lw.length; i++) w[i] /= s;
  return w;
}
function mixP(w, dists, allowed){
  const P = new Float64Array(10); let ws = 0;
  for(let e = 0; e < dists.length; e++){
    if(allowed && !allowed[e]) continue;
    ws += w[e];
    for(let d = 0; d < 10; d++) P[d] += w[e] * dists[e][d];
  }
  if(ws <= 0) return Float64Array.from({ length: 10 }, () => 0.1);
  for(let d = 0; d < 10; d++) P[d] /= ws;
  return P;
}
function rankOf(P, y){
  let r = 0;
  for(let d = 0; d < 10; d++) if(d !== y && (P[d] > P[y] || (P[d] === P[y] && d < y))) r++;
  return r;
}

// ---------- State ----------
// Pakar INTI mulai dengan bobot normal; pakar lain mulai NYARIS MATI (OFF_TILT, dalam log) sampai lolos gerbang lintas-pasaran
// (globalReport -> tiltFromReport -> tilt). Kalau id ada di tilt, nilai tilt dipakai apa adanya.
const CORE = { NOREP: 1, FRQALL: 1, FRQNOREP: 1, DELTA: 1, GAP: 1, HYPE: 1 };
const OFF_TILT = -8;
function priorTilt(id, tilt){ if(tilt && tilt[id] != null) return tilt[id]; return CORE[id] ? 0 : OFF_TILT; }
function initLw(reg, tilt){
  const E = reg.ex.length, lw = new Array(E);
  const wOther = 0.5 / (E - 1);
  let s = 0; const w = new Array(E);
  for(let i = 0; i < E; i++){
    w[i] = i === 0 ? 0.5 : wOther * Math.exp(priorTilt(reg.ex[i].id, tilt));
    s += w[i];
  }
  for(let i = 0; i < E; i++) lw[i] = Math.log(w[i] / s);
  return lw;
}
function newState(name, L, tilt, extRefs){
  extRefs = extRefs || [];
  const reg = makeRegistry(L, extRefs), E = reg.ex.length;
  const st = { v: 3, name, L, t: T0, head: '', tail: '', reg, tilt: tilt || null, extRefs, refSeries: {},
    lw: [], adv: [], combos: [], ranks: [], cumS: [], cumS2: [], cumN: 0, labLog: [], recP: [] };
  for(let p = 0; p < L; p++){
    st.lw.push(initLw(reg, tilt));
    st.adv.push(new Array(E).fill(0));
    st.combos.push([]);
    st.ranks.push([]);
    st.recP.push([]);
    st.cumS.push(new Array(E).fill(0));
    st.cumS2.push(new Array(E).fill(0));
  }
  return st;
}
function rowKey(r){ return r.join(''); }

// Distribusi prior untuk fixed-share: bobot awal (initLw) tiap pakar dasar; kombinasi lab memakai rata-rata pakar dasar aktif.
function sharePrior(st, E){
  if(st._prior && st._prior.length === E) return st._prior;
  const E0 = st.reg.ex.length, lw0 = initLw(st.reg, st.tilt), pr = new Float64Array(E);
  let sum = 0, m = 0, k = 0;
  for(let e = 0; e < E0; e++){ pr[e] = Math.exp(lw0[e]); if(e > 0){ m += pr[e]; k++; } }
  const combo = k ? m / k : 0;
  for(let e = E0; e < E; e++) pr[e] = combo;
  for(let e = 0; e < E; e++) sum += pr[e];
  for(let e = 0; e < E; e++) pr[e] /= sum;
  st._prior = pr;
  return pr;
}
function stepPos(st, bp, p, y){
  const reg = st.reg, dists = posDists(bp, reg, p, st.combos[p]), E = dists.length;
  const lw = st.lw[p], w = softmaxInto(lw, new Float64Array(E));
  const P = mixP(w, dists, null);
  const r = rankOf(P, y);
  const rp = st.recP[p]; rp.push(Array.from(P, x => Math.min(1295, Math.round(x * 1000)))); if(rp.length > REC_K) rp.shift();
  const E0 = reg.ex.length, adv = st.adv[p];
  for(let e = 0; e < E; e++){
    const ll = Math.log(Math.max(dists[e][y], EPS));
    lw[e] += ETA * ll;
    const dl = ll - LN_UNI;
    adv[e] = DECAY * adv[e] + (1 - DECAY) * dl;
    if(e < E0){ st.cumS[p][e] += dl; st.cumS2[p][e] += dl * dl; }
  }
  softmaxInto(lw, w);
  const pr = sharePrior(st, E);
  for(let e = 0; e < E; e++){ w[e] = (1 - SHARE) * w[e] + SHARE * pr[e]; lw[e] = Math.log(w[e]); }
  return r;
}

function processStep(st, C, t){
  // ctx menggabungkan state (untuk _dates/HYPE) dan refSeries (untuk XMKT)
  const ctx = Object.assign({ refSeries: st.refSeries || {} }, st);
  const bp = baseP(C, t, st.reg, ctx);
  for(let p = 0; p < st.L; p++) st.ranks[p].push(stepPos(st, bp, p, C[t][p]));
  st.cumN++;
  st.t = t + 1;
  if(st.t >= LAB_START && st.t % LAB_EVERY === 0) runLab(st, C, st.t);
}

// ---------- Lab eksperimen: gabung 2 pakar, terima hanya kalau untung di latih DAN validasi ----------
function runLab(st, C, tau){
  const reg = st.reg, L = st.L, E0 = reg.ex.length;
  if(tau - T0 < 30) return { tried: 0, admitted: 0 };
  const store = [];
  const ctx = Object.assign({ refSeries: st.refSeries || {} }, st);
  for(let t = T0; t < tau; t++) store.push(baseP(C, t, reg, ctx));
  const split = T0 + Math.floor((tau - T0) * 0.6);
  let triedAll = 0, admittedAll = 0;
  for(let p = 0; p < L; p++){
    const dllBase = (e, t) => Math.log(Math.max(store[t - T0][(e * L + p) * 10 + C[t][p]], EPS)) - LN_UNI;
    const sc = [];
    for(let e = 1; e < E0; e++){
      let a = 0, b = 0;
      for(let t = T0; t < split; t++) a += dllBase(e, t);
      for(let t = split; t < tau; t++) b += dllBase(e, t);
      sc.push({ e, score: a / (split - T0) + b / (tau - split) });
    }
    sc.sort((x, y) => y.score - x.score);
    const top = sc.slice(0, LAB_TOPK).map(x => x.e);
    const found = [];
    let tried = 0;
    for(let i = 0; i < top.length; i++){
      for(let j = i + 1; j < top.length; j++){
        ['geo', 'prod'].forEach(op => {
          const id = 'C:' + reg.ex[top[i]].id + (op === 'geo' ? '~' : '*') + reg.ex[top[j]].id;
          if(st.combos[p].some(c => c.id === id)) return;
          tried++;
          let a = 0, a2 = 0, b = 0, b2 = 0;
          for(let t = T0; t < tau; t++){
            let s = 0, num = 0;
            for(let d = 0; d < 10; d++){
              const qa = store[t - T0][(top[i] * L + p) * 10 + d], qb = store[t - T0][(top[j] * L + p) * 10 + d];
              const val = op === 'geo' ? Math.sqrt(qa * qb) : qa * qb;
              s += val; if(d === C[t][p]) num = val;
            }
            const dl = Math.log(Math.max(num / s, EPS)) - LN_UNI;
            if(t < split){ a += dl; a2 += dl * dl; } else { b += dl; b2 += dl * dl; }
          }
          // uji-t per potongan waktu: harus untung NYATA (bukan kebetulan) di data latih DAN validasi
          const nA = split - T0, nB = tau - split;
          const mA = a / nA, mB = b / nB;
          const tA = mA / Math.sqrt(Math.max(a2 / nA - mA * mA, 1e-12) / nA);
          const tB = mB / Math.sqrt(Math.max(b2 / nB - mB * mB, 1e-12) / nB);
          if(tA >= LAB_MIN_T && tB >= LAB_MIN_T) found.push({ id, a: reg.ex[top[i]].id, b: reg.ex[top[j]].id, op, score: Math.min(tA, tB) });
        });
      }
    }
    found.sort((x, y) => y.score - x.score);
    const take = found.slice(0, LAB_ADMIT);
    take.forEach(c => {
      st.combos[p].push({ id: c.id, a: c.a, b: c.b, op: c.op });
      st.lw[p].push(Math.log(1 / (st.lw[p].length + 1)));
      st.adv[p].push(0);
    });
    // batasi jumlah kombinasi: buang yang bobotnya terendah
    while(st.combos[p].length > MAX_COMBOS){
      let worst = 0, wv = Infinity;
      for(let k = 0; k < st.combos[p].length; k++){
        const lv = st.lw[p][E0 + k]; if(lv < wv){ wv = lv; worst = k; }
      }
      st.combos[p].splice(worst, 1); st.lw[p].splice(E0 + worst, 1); st.adv[p].splice(E0 + worst, 1);
    }
    triedAll += tried; admittedAll += take.length;
  }
  st.labLog.push({ t: tau, tried: triedAll, admitted: admittedAll });
  if(st.labLog.length > 30) st.labLog.shift();
  return { tried: triedAll, admitted: admittedAll };
}

// ---------- Belajar satu pasaran (dan lanjutan kalau ada data baru) ----------
function stateMatches(st, C){
  if(!st || C.length < st.t) return false;
  if(st.head !== C.slice(0, T0).map(rowKey).join('|')) return false;
  return st.t === 0 || rowKey(C[st.t - 1]) === st.tail;
}
function learnMarket(name, C, L, opts){
  opts = opts || {};
  let st = opts.state;
  const extRefs = opts.extRefs || [];
  const extRefsChanged = st && JSON.stringify(st.extRefs || []) !== JSON.stringify(extRefs);
  if(!stateMatches(st, C) || st.L !== L || extRefsChanged || (('tilt' in opts) && JSON.stringify(opts.tilt || null) !== JSON.stringify(st.tilt || null))){
    st = newState(name, L, opts.tilt, extRefs);
    st.head = C.slice(0, T0).map(rowKey).join('|');
  }
  if(opts.dates) st._dates = opts.dates;   // tanggal sejajar baris (untuk pakar HYPE)
  st.refSeries = opts.refSeries || {};     // selalu pakai yang terbaru dari pemanggil (untuk XMKT)
  if(C.length <= T0) { st.tail = C.length ? rowKey(C[C.length - 1]) : ''; return st; }
  for(let t = st.t; t < C.length; t++) processStep(st, C, t);
  st.tail = rowKey(C[C.length - 1]);
  return st;
}
function forceLab(st, C){ return runLab(st, C, C.length); }

// ---------- Prediksi & pilihan digit ----------
// opts: { out: n | [n per posisi], pin: {p:[digit]}, ban: {p:[digit]}, famOff: {FAM:true} }
function predict(st, C, opts){
  opts = opts || {};
  const reg = st.reg, L = st.L, E0 = reg.ex.length, t = C.length;
  if(opts.dates) st._dates = opts.dates;
  const ctx = Object.assign({ refSeries: st.refSeries || {} }, st);
  const bp = baseP(C, t, reg, ctx), res = [];
  for(let p = 0; p < L; p++){
    const dists = posDists(bp, reg, p, st.combos[p]), E = dists.length;
    const w = softmaxInto(st.lw[p], new Float64Array(E));
    let allowed = null;
    if(opts.famOff){
      allowed = new Array(E).fill(true);
      for(let e = 0; e < E0; e++) if(reg.ex[e].fam !== 'NULL' && opts.famOff[reg.ex[e].fam]) allowed[e] = false;
      if(opts.famOff.COMBO) for(let e = E0; e < E; e++) allowed[e] = false;
    }
    const P = mixP(w, dists, allowed);
    const n = Array.isArray(opts.out) ? opts.out[p] : (opts.out || 8);
    const pin = (opts.pin && opts.pin[p]) || [], ban = (opts.ban && opts.ban[p]) || [];
    const order = [0,1,2,3,4,5,6,7,8,9].filter(d => ban.indexOf(d) < 0)
      .sort((a, b) => (pin.indexOf(b) >= 0) - (pin.indexOf(a) >= 0) || (P[b] - P[a]) || (a - b));
    const chosen = order.slice(0, n);
    let mass = 0; chosen.forEach(d => { mass += P[d]; });
    res.push({ p, label: reg.lab[p], out: n, digits: chosen.slice().sort((a, b) => a - b), P: Array.from(P),
      mass, chance: n / 10, edge: mass - n / 10, wNull: w[0] });
  }
  return res;
}

// Penjelasan: pakar berbobot terbesar untuk posisi p
function explain(st, p, C){
  const reg = st.reg, E0 = reg.ex.length, E = st.lw[p].length;
  const w = softmaxInto(st.lw[p], new Float64Array(E));
  const rows = [];
  for(let e = 0; e < E; e++){
    const name = e < E0 ? reg.ex[e].name : st.combos[p][e - E0].id;
    rows.push({ id: e < E0 ? reg.ex[e].id : st.combos[p][e - E0].id, name, w: w[e], adv: st.adv[p][e], combo: e >= E0 });
  }
  rows.sort((a, b) => b.w - a.w);
  return { label: reg.lab[p], wNull: w[0], top: rows.slice(0, 5), best: rows.filter(r => r.id !== 'NULL').sort((a, b) => b.adv - a.adv).slice(0, 3),
    combos: st.combos[p].length, lab: st.labLog.slice(-3) };
}

// ---------- Uji jujur ----------
function erfc(x){ // pendekatan Abramowitz-Stegun 7.1.26
  const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}
function pOneSided(z){ return 0.5 * erfc(z / Math.SQRT2); }
function evalState(st, out, from){
  from = from == null ? EVAL_FROM : from;
  const q = out / 10, res = [];
  for(let p = 0; p < st.L; p++){
    let n = 0, hits = 0, hitsA = 0, nA = 0, hitsB = 0, nB = 0;
    const R = st.ranks[p], total = R.length - Math.max(0, from - T0);
    for(let i = Math.max(0, from - T0); i < R.length; i++){
      n++; if(R[i] < out) hits++;
    }
    const half = Math.floor(n / 2);
    for(let i = Math.max(0, from - T0), k = 0; i < R.length; i++, k++){
      if(k < half){ nA++; if(R[i] < out) hitsA++; } else { nB++; if(R[i] < out) hitsB++; }
    }
    const sd = Math.sqrt(n * q * (1 - q));
    const z = n > 0 ? (hits - n * q) / sd : 0;
    res.push({ p, label: st.reg.lab[p], n, hits, pct: n ? hits / n * 100 : 0, chance: q * 100, z, pval: pOneSided(z),
      pctA: nA ? hitsA / nA * 100 : 0, pctB: nB ? hitsB / nB * 100 : 0, total });
  }
  return res;
}
function evalAll(states, out){
  let n = 0, hits = 0, sig = 0, trials = 0, sigBonf = 0;
  const q = out / 10, per = [];
  states.forEach(st => {
    evalState(st, out).forEach(r => {
      n += r.n; hits += r.hits; trials++;
      if(r.z > 1.645) sig++;
      per.push({ name: st.name, label: r.label, z: r.z, pct: r.pct, n: r.n, pval: r.pval });
    });
  });
  const z = n ? (hits - n * q) / Math.sqrt(n * q * (1 - q)) : 0;
  const thr = 0.05 / Math.max(1, trials);
  per.forEach(r => { if(r.pval < thr) sigBonf++; });
  per.sort((a, b) => b.z - a.z);
  return { n, hits, pct: n ? hits / n * 100 : 0, chance: q * 100, z, pval: pOneSided(z), trials,
    sig, sigExpected: trials * 0.05, sigBonf, top: per.slice(0, 5) };
}

// ---------- Belajar semua pasaran + gerbang global ----------
function globalReport(states){
  const acc = {};
  states.forEach(st => {
    st.reg.ex.forEach((x, e) => {
      if(e === 0) return;
      for(let p = 0; p < st.L; p++){
        const a = acc[x.id] || (acc[x.id] = { id: x.id, name: x.name, n: 0, s: 0, s2: 0 });
        a.n += st.cumN; a.s += st.cumS[p][e]; a.s2 += st.cumS2[p][e];
      }
    });
  });
  const list = Object.keys(acc).map(k => {
    const a = acc[k], mean = a.s / a.n, varr = Math.max(a.s2 / a.n - mean * mean, 1e-12);
    const z = mean / Math.sqrt(varr / a.n);
    return { id: a.id, name: a.name, n: a.n, mean, z, pass: z >= GATE_Z };
  });
  list.sort((a, b) => b.z - a.z);
  return list;
}
function tiltFromReport(list){
  const tilt = {}; let any = false;
  list.forEach(r => { if(r.pass){ tilt[r.id] = 2; any = true; } });
  return any ? tilt : null;
}

// ---------- ANGKA FILTER (isi kotak "Filter Pangkas Kombinasi" di Generator) ----------
// Filter di Generator bekerja di atas kombinasi hasil POOL (cartesian tiap posisi), jadi angka filter dipilih
// supaya kombinasi yang kemungkinan besar keluar TIDAK ikut terpangkas. Semantik filter PERSIS sama dengan
// applyFilters() di generator.js (khusus 4D):
//   Ai AC / Ai CK / Ai KE : salah satu dari 2 digit pasangan (AC=digit 1-2, CK=2-3, KE=3-4) ada di himpunan
//   Angka Ikut            : salah satu dari semua digit angka ada di himpunan
//   Jumlah / Selisih      : salah satu dari 3 nilai per pasangan AC/CK/KE ((a+b)%10 / |a-b|) ada di himpunan
//   Shio                  : salah satu dari shio AC/CK/KE (angka 2 digit % 12, 0 -> 12) ada di himpunan
//
// Dua tingkat:
//  (a) filterNumbers()  : MODEL saja — dipilih dari peluang digit per posisi hasil predict() (dibatasi ke digit pool,
//      posisi dianggap independen). Murah, dipakai tampilan cepat. BELUM diuji ke belakang.
//  (b) filterLearn()    : BELAJAR — tiap filter punya beberapa PAKAR pemilih angka (MODEL, COVER15, COVER30, FREQ30) +
//      pembanding ACAK; bobotnya naik/turun tiap ada hasil nyata (jalan-maju: baris t hanya memakai data < t), lalu
//      dipilih lewat pemungutan suara berbobot. Sekaligus melapor UJI JUJUR: persen kena vs porsi kombinasi pool yang
//      ikut lolos filter (peluang lolos kalau tebakan digit pool acak) + z. Bahan uji: peluang campuran Bayes yang DISIMPAN SEBELUM hasil diketahui (st.recP, REC_K baris terakhir).
const REC_K = 60;                 // banyak baris terakhir yang peluang prediksinya disimpan (bahan uji filter)
const FT_ETA = 0.5, FT_SHARE = 0.01;   // kecepatan belajar bobot pakar filter, fixed-share ke prior
const FT_EXPERTS = [
  { id: 'NULL', name: 'Acak (pembanding)' },
  { id: 'MODEL', name: 'Model digit Ai' },
  { id: 'COVER15', name: 'Cover 15 baris' },
  { id: 'COVER30', name: 'Cover 30 baris' },
  { id: 'FREQ30', name: 'Frekuensi 30 baris' }
];
const D10 = [0,1,2,3,4,5,6,7,8,9], S12 = [1,2,3,4,5,6,7,8,9,10,11,12];

function combosOf(vals, k){
  const res = [];
  (function h(s, c){
    if(c.length === k){ res.push(c.slice()); return; }
    for(let i = s; i < vals.length; i++){ c.push(vals[i]); h(i + 1, c); c.pop(); }
  })(0, []);
  return res;
}
function coverMass(entries, sm){
  let m = 0;
  for(let i = 0; i < entries.length; i++) if(entries[i][0] & sm) m += entries[i][1];
  return m;
}
// entries: [[topeng-bit, bobot]]; freq (opsional): { nilai: frekuensi } untuk tie-break (frekuensi gabungan lebih tinggi menang)
function bestCoverSet(entries, vals, n, freq){
  n = Math.max(1, Math.min(vals.length, n | 0));
  let best = null;
  combosOf(vals, n).forEach(c => {
    let sm = 0, fs = 0; c.forEach(v => { sm |= (1 << v); if(freq) fs += freq[v] || 0; });
    const mass = coverMass(entries, sm);
    if(!best || mass > best.mass + 1e-12 || (freq && Math.abs(mass - best.mass) <= 1e-12 && fs > best.fs)) best = { set: c, mass, sm, fs };
  });
  return best;
}
function shioOfNum(n){ const r = n % 12; return r === 0 ? 12 : r; }
// Distribusi gabungan 4 posisi -> peta { topeng-bit: peluang } untuk tiap jenis filter
function jointMaskMaps(D){
  const M = { AC: new Map(), CK: new Map(), KE: new Map(), JUMLAH: new Map(), SELISIH: new Map(), SHIO: new Map() };
  const add = (m, k, v) => { m.set(k, (m.get(k) || 0) + v); };
  for(let a = 0; a < 10; a++){ if(!(D[0][a] > 0)) continue;
    for(let c = 0; c < 10; c++){ const pac = D[0][a] * D[1][c]; if(!(pac > 0)) continue;
      for(let k = 0; k < 10; k++){ const pack = pac * D[2][k]; if(!(pack > 0)) continue;
        for(let e = 0; e < 10; e++){
          const pr = pack * D[3][e]; if(!(pr > 0)) continue;
          add(M.AC, (1 << a) | (1 << c), pr);
          add(M.CK, (1 << c) | (1 << k), pr);
          add(M.KE, (1 << k) | (1 << e), pr);
          add(M.JUMLAH, (1 << ((a + c) % 10)) | (1 << ((c + k) % 10)) | (1 << ((k + e) % 10)), pr);
          add(M.SELISIH, (1 << Math.abs(a - c)) | (1 << Math.abs(c - k)) | (1 << Math.abs(k - e)), pr);
          add(M.SHIO, (1 << shioOfNum(a * 10 + c)) | (1 << shioOfNum(c * 10 + k)) | (1 << shioOfNum(k * 10 + e)), pr);
        }
      }
    }
  }
  const out = {}; Object.keys(M).forEach(k => { out[k] = Array.from(M[k].entries()); });
  return out;
}
// (a) MODEL saja. counts: { AC, CK, KE, jumlah, selisih, shio, ikut } = banyak nilai per filter.
// withBase: hitung juga `chance` = peluang lolos himpunan yang sama kalau digit pool dipilih acak merata.
function filterModelSets(pr, counts, withBase){
  counts = counts || {};
  const L = pr ? pr.length : 0;
  if(!L) return { L: 0, items: [] };
  const model = [], uni = [];
  pr.forEach(x => {
    const m = new Float64Array(10), u = new Float64Array(10);
    let s = 0; x.digits.forEach(d => { m[d] = x.P[d]; s += m[d]; });
    x.digits.forEach(d => { m[d] = s > 0 ? m[d] / s : 1 / x.digits.length; u[d] = 1 / x.digits.length; });
    model.push(m); uni.push(u);
  });
  const items = [];
  // Angka Ikut (semua digit angka): rumus tertutup, berlaku untuk panjang berapa pun
  {
    const n = Math.max(1, Math.min(10, (counts.ikut | 0) || 4));
    const cov = (D, set) => { let q = 1; for(let p = 0; p < L; p++){ let m = 0; set.forEach(d => { m += D[p][d]; }); q *= (1 - m); } return 1 - q; };
    let best = null;
    combosOf(D10, n).forEach(c => { const v = cov(model, c); if(!best || v > best.v + 1e-12) best = { set: c, v }; });
    items.push({ id: 'IKUT', label: 'Angka Ikut', digits: best.set.slice(), p: best.v, chance: withBase ? cov(uni, best.set) : null });
  }
  if(L === 4){
    const EM = jointMaskMaps(model), EU = withBase ? jointMaskMaps(uni) : null;
    const pick = (id, label, vals, n) => {
      const b = bestCoverSet(EM[id], vals, n);
      items.push({ id, label, digits: b.set.slice(), p: b.mass, chance: EU ? coverMass(EU[id], b.sm) : null });
    };
    pick('AC', 'Ai AC', D10, counts.AC || 5);
    pick('CK', 'Ai CK', D10, counts.CK || 5);
    pick('KE', 'Ai KE', D10, counts.KE || 5);
    pick('JUMLAH', 'Jumlah', D10, counts.jumlah || 5);
    pick('SELISIH', 'Selisih', D10, counts.selisih || 5);
    pick('SHIO', 'Shio', S12, counts.shio || 5);
  }
  const order = ['AC', 'CK', 'KE', 'IKUT', 'JUMLAH', 'SELISIH', 'SHIO'];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { L, items };
}
function filterNumbers(pr, counts){ return filterModelSets(pr, counts, true); }

// ---------- (b) belajar + uji jalan-maju ----------
function filterSpecs(L, counts){
  counts = counts || {};
  const bit = v => 1 << v;
  const mk = (id, label, vals, n, mask) => ({ id, label, vals, n: Math.max(1, Math.min(vals.length, n | 0)), mask });
  const pr2 = (r, i, j) => bit(r[i]) | bit(r[j]);
  const specs = [];
  if(L === 4){
    specs.push(mk('AC', 'Ai AC', D10, counts.AC || 5, r => pr2(r, 0, 1)));
    specs.push(mk('CK', 'Ai CK', D10, counts.CK || 5, r => pr2(r, 1, 2)));
    specs.push(mk('KE', 'Ai KE', D10, counts.KE || 5, r => pr2(r, 2, 3)));
  }
  specs.push(mk('IKUT', 'Angka Ikut', D10, Math.min(10, (counts.ikut | 0) || 4), r => { let m = 0; r.forEach(d => { m |= bit(d); }); return m; }));
  if(L === 4){
    specs.push(mk('JUMLAH', 'Jumlah', D10, counts.jumlah || 5, r => bit((r[0] + r[1]) % 10) | bit((r[1] + r[2]) % 10) | bit((r[2] + r[3]) % 10)));
    specs.push(mk('SELISIH', 'Selisih', D10, counts.selisih || 5, r => bit(Math.abs(r[0] - r[1])) | bit(Math.abs(r[1] - r[2])) | bit(Math.abs(r[2] - r[3]))));
    specs.push(mk('SHIO', 'Shio', S12, counts.shio || 5, r => bit(shioOfNum(r[0] * 10 + r[1])) | bit(shioOfNum(r[1] * 10 + r[2])) | bit(shioOfNum(r[2] * 10 + r[3]))));
  }
  return specs;
}
// Pembanding jujur: peluang sebuah himpunan LOLOS kalau hasilnya digit acak merata dari pool posisi itu (= porsi kombinasi
// pool yang bertahan setelah difilter). Himpunan yang hanya "meloloskan banyak kombinasi" (mis. Selisih kecil yang memang
// lebih sering) tidak dihitung sebagai keunggulan — filter berguna hanya kalau kena lebih sering daripada porsi yang ia loloskan.
function makeSurvival(pr){
  const L = pr.length, uni = pr.map(x => { const u = new Float64Array(10); x.digits.forEach(d => { u[d] = 1 / x.digits.length; }); return u; });
  const EU = L === 4 ? jointMaskMaps(uni) : null;
  return (id, set) => {
    if(id === 'IKUT'){ let q = 1; for(let p = 0; p < L; p++){ let m = 0; set.forEach(d => { m += uni[p][d]; }); q *= (1 - m); } return 1 - q; }
    return coverMass(EU[id], setMask(set));
  };
}
function tally(masks, vals){ const f = {}; vals.forEach(v => { f[v] = 0; }); masks.forEach(m => vals.forEach(v => { if(m & (1 << v)) f[v]++; })); return f; }
function coverPick(masks, vals, n){
  const agg = new Map(); masks.forEach(m => agg.set(m, (agg.get(m) || 0) + 1));
  return bestCoverSet(Array.from(agg.entries()), vals, n, tally(masks, vals)).set;
}
function freqPick(masks, vals, n){
  const f = tally(masks, vals);
  return vals.slice().sort((a, b) => f[b] - f[a] || a - b).slice(0, n).sort((a, b) => a - b);
}
function setMask(set){ let m = 0; set.forEach(v => { m |= (1 << v); }); return m; }
// pemungutan suara berbobot: tiap pakar (bukan ACAK) memberi bobotnya ke nilai-nilai yang dipilihnya
function voteSet(sets, w, vals, n, freq){
  const sc = {}; vals.forEach(v => { sc[v] = 0; });
  for(let e = 1; e < sets.length; e++) sets[e].forEach(v => { sc[v] += w[e]; });
  return vals.slice().sort((a, b) => (sc[b] - sc[a]) || ((freq[b] || 0) - (freq[a] || 0)) || (a - b)).slice(0, n).sort((a, b) => a - b);
}
// pool digit tiap posisi pada baris ke-idx catatan recP (tanpa pin/ban) dari peluang yang disimpan
function poolsFromRec(st, idx, outArg){
  const res = [];
  for(let p = 0; p < st.L; p++){
    const row = st.recP[p][idx], P = row.map(v => v / 1000);
    const n = Array.isArray(outArg) ? outArg[p] : (outArg || 8);
    const digits = D10.slice().sort((a, b) => (P[b] - P[a]) || (a - b)).slice(0, n).sort((a, b) => a - b);
    res.push({ digits, P });
  }
  return res;
}
function zOfAcc(a){
  const z = a.sv > 1e-9 ? (a.h - a.sc) / Math.sqrt(a.sv) : 0;
  return { rows: a.n, hits: a.h, pct: a.n ? a.h / a.n * 100 : 0, chance: a.n ? a.sc / a.n * 100 : 0, z, pval: pOneSided(z) };
}
// st harus SUDAH belajar sampai baris terakhir C (st.t === C.length) dan punya st.recP.
// outArg = OUT pool (angka / array per posisi) yang dipakai saat menguji; opts.pr = hasil predict() untuk draw berikutnya (MODEL);
// opts.K = banyak baris uji (default REC_K). Mengembalikan null kalau bahan uji belum cukup.
function filterLearn(st, C, counts, outArg, opts){
  opts = opts || {};
  const L = st.L, N = C.length, recLen = (st.recP && st.recP[0]) ? st.recP[0].length : 0;
  if(!recLen || st.t !== N || !opts.pr) return null;
  const K = Math.min(opts.K || REC_K, recLen);
  if(K < 10) return null;
  const specs = filterSpecs(L, counts), NE = FT_EXPERTS.length;
  const masks = specs.map(s => C.map(r => s.mask(r)));
  const prior = new Float64Array(NE); prior[0] = 0.5; for(let e = 1; e < NE; e++) prior[e] = 0.5 / (NE - 1);
  const lws = specs.map(() => Array.from(prior, x => Math.log(x)));
  const acc = specs.map(() => Array.from({ length: NE + 1 }, () => ({ h: 0, n: 0, sc: 0, sv: 0 })));   // 1..NE-1 = pakar, NE = campuran (Ai)
  const histOf = (fi, t) => masks[fi].slice(Math.max(0, t - 30), t);
  const setsOf = (fi, t, modelSet) => {
    const s = specs[fi], h30 = histOf(fi, t);
    return [null, modelSet, coverPick(h30.slice(-15), s.vals, s.n), coverPick(h30, s.vals, s.n), freqPick(h30, s.vals, s.n)];
  };
  const bump = (a, h, c) => { a.h += h; a.n++; a.sc += c; a.sv += c * (1 - c); };
  for(let i = 0; i < K; i++){
    const t = N - K + i;
    const prT = poolsFromRec(st, recLen - K + i, outArg);
    const ms = filterModelSets(prT, counts, false).items, surv = makeSurvival(prT);
    specs.forEach((s, fi) => {
      const sets = setsOf(fi, t, ms.find(x => x.id === s.id).digits);
      const lw = lws[fi], w = softmaxInto(lw, new Float64Array(NE));
      const mix = voteSet(sets, w, s.vals, s.n, tally(histOf(fi, t), s.vals));
      const actual = masks[fi][t];
      const hit = set => (actual & setMask(set)) ? 1 : 0;
      for(let e = 1; e < NE; e++){ const h = hit(sets[e]), c = surv(s.id, sets[e]); bump(acc[fi][e], h, c); lw[e] += FT_ETA * (h - c); }
      bump(acc[fi][NE], hit(mix), surv(s.id, mix));
      softmaxInto(lw, w);
      for(let e = 0; e < NE; e++){ w[e] = (1 - FT_SHARE) * w[e] + FT_SHARE * prior[e]; lw[e] = Math.log(w[e]); }
    });
  }
  const fm = filterModelSets(opts.pr, counts, true).items;
  const items = specs.map((s, fi) => {
    const mi = fm.find(x => x.id === s.id);
    const sets = setsOf(fi, N, mi.digits);
    const w = softmaxInto(lws[fi], new Float64Array(NE));
    const digits = voteSet(sets, w, s.vals, s.n, tally(histOf(fi, N), s.vals));
    const test = zOfAcc(acc[fi][NE]);
    const experts = [];
    for(let e = 1; e < NE; e++) experts.push(Object.assign({ id: FT_EXPERTS[e].id, name: FT_EXPERTS[e].name, w: w[e], set: sets[e] }, zOfAcc(acc[fi][e])));
    const ex = experts.slice().sort((a, b) => b.pct - a.pct || b.w - a.w)[0];
    return { id: s.id, label: s.label, n: s.n, digits, p: test.pct / 100, chance: test.chance / 100, test, experts, best: ex, wNull: w[0], useless: test.chance > 98.5 };
  });
  const trials = items.length;
  return { L, K, items, trials, sig: items.filter(x => x.test.z > 1.645).length, sigExpected: trials * 0.05,
    sigBonf: items.filter(x => x.test.pval < 0.05 / trials).length };
}

function serialize(st){
  const r4 = a => a.map(x => Math.round(x * 1e4) / 1e4);
  return { v: 3, name: st.name, L: st.L, t: st.t, head: st.head, tail: st.tail, tilt: st.tilt, extRefs: st.extRefs || [],
    lw: st.lw.map(r4), adv: st.adv.map(r4), combos: st.combos, ranks: st.ranks.map(a => a.join('')),
    cumS: st.cumS.map(r4), cumS2: st.cumS2.map(r4), cumN: st.cumN, labLog: st.labLog,
    recP: (st.recP || []).map(a => a.map(r => r.map(v => ('0' + v.toString(36)).slice(-2)).join('')).join('|')) };
}
function deserialize(o){
  if(!o || o.v !== 3) return null; // versi lama (daftar pakar berbeda) tidak kompatibel -> null, aiMode belajar ulang
  const st = newState(o.name, o.L, o.tilt, o.extRefs || []);
  Object.assign(st, { t: o.t, head: o.head, tail: o.tail, lw: o.lw, adv: o.adv, combos: o.combos, ranks: o.ranks.map(x => String(x).split('').map(Number)),
    cumS: o.cumS, cumS2: o.cumS2, cumN: o.cumN, labLog: o.labLog || [] });
  // recP (bahan uji filter) opsional: state lama tanpa recP tetap terbaca, aiMode yang memutuskan belajar ulang kalau perlu
  if(Array.isArray(o.recP) && o.recP.length === o.L) st.recP = o.recP.map(sx => String(sx).split('|').filter(Boolean).map(r => Array.from({ length: 10 }, (_, i) => parseInt(r.substr(i * 2, 2), 36) || 0)));
  return st;
}

// ---------- Zona Aman Streak (lapis TAMBAHAN — hanya untuk REKOMENDASI EKSEKUSI, tidak mengubah
// cara bobot pakar/mixture Bayes di atas belajar sama sekali; metode yang sudah ada tetap utuh) ----------
// Fase BELAJAR: pool kejadian streak dari SEMUA pasaran yang sudah dimuat (lebih banyak sampel).
// Fase EKSEKUSI: hanya pakai streak BERJALAN pasaran yang sedang aktif (tidak dicampur pasaran lain).
const STREAK_MIN_N = 30;      // minimal kejadian di level-streak itu supaya z-nya dipercaya (bukan kebetulan)
const STREAK_Z_SAFE = 1.645;  // ambang z dianggap "zona aman" (p<0,05 satu-sisi)

// hitArr: array boolean kronologis (true=kena). Keluarkan daftar {streak, survived} — 'survived' = draw
// SETELAH mencapai streak itu ternyata kena juga (streak berlanjut), bukan mengulang draw yg sama.
function streakEvents(hitArr){
  const ev = []; let s = 0;
  for(let i = 0; i < hitArr.length; i++){
    if(s > 0) ev.push({ streak: s, survived: !!hitArr[i] });
    s = hitArr[i] ? s + 1 : 0;
  }
  return ev;
}
// Pool dari banyak state (lintas pasaran) → zona aman PER POSISI (label) dan GABUNGAN (semua posisi
// hit bareng di draw yang sama). out = jumlah digit dipakai (mis. 8 dari 10).
function computeStreakZones(states, out){
  const q = out / 10;
  const perLabel = {}, combinedBy = {};
  states.forEach(st => {
    const L = st.L, labels = st.reg.lab, hitMat = [];
    for(let p = 0; p < L; p++){
      const R = st.ranks[p], hit = R.map(r => r < out);
      hitMat.push(hit);
      const bucket = perLabel[labels[p]] || (perLabel[labels[p]] = {});
      streakEvents(hit).forEach(e => {
        const b = bucket[e.streak] || (bucket[e.streak] = { n: 0, surv: 0 });
        b.n++; if(e.survived) b.surv++;
      });
    }
    const n = hitMat[0] ? hitMat[0].length : 0, allHit = [];
    for(let i = 0; i < n; i++) allHit.push(hitMat.every(row => row[i]));
    streakEvents(allHit).forEach(e => {
      const b = combinedBy[e.streak] || (combinedBy[e.streak] = { n: 0, surv: 0 });
      b.n++; if(e.survived) b.surv++;
    });
  });
  function toZones(byStreak, p0){
    return Object.keys(byStreak).map(Number).sort((a, b) => a - b).map(s => {
      const b = byStreak[s], rate = b.n ? b.surv / b.n : 0;
      const z = b.n ? (b.surv - b.n * p0) / Math.sqrt(b.n * p0 * (1 - p0)) : 0;
      return { streak: s, n: b.n, survRate: rate, z, pval: pOneSided(z), safe: b.n >= STREAK_MIN_N && z >= STREAK_Z_SAFE };
    });
  }
  const perLabelZones = {};
  Object.keys(perLabel).forEach(lab => { perLabelZones[lab] = toZones(perLabel[lab], q); });
  // peluang dasar gabungan = perkalian peluang tiap posisi (perkiraan, asumsi independen antar posisi)
  const Lsample = states.length ? states[0].L : 1, qComb = Math.pow(q, Lsample);
  return { perLabel: perLabelZones, combined: toZones(combinedBy, qComb), out, nMarkets: states.length, at: Date.now() };
}
// Streak yang SEDANG berjalan sekarang untuk SATU pasaran aktif (tidak dicampur pasaran lain).
function currentStreaks(st, out){
  const res = {};
  for(let p = 0; p < st.L; p++){
    const R = st.ranks[p]; let s = 0;
    for(let i = R.length - 1; i >= 0; i--){ if(R[i] < out) s++; else break; }
    res[st.reg.lab[p]] = s;
  }
  return res;
}
// Keputusan eksekusi: cek per-posisi dulu, kalau tidak semua posisi masuk zona aman, cek gabungan;
// kalau tetap tidak ada yang aman → mode ZIGZAG (sinyal ke pemanggil: jangan pakai 1 pola tetap).
function pickExecution(st, zones, out){
  const cur = currentStreaks(st, out), labels = st.reg.lab, perPos = {}; let safeCount = 0;
  labels.forEach(lab => {
    const s = cur[lab], zr = (zones.perLabel[lab] || []).find(r => r.streak === s);
    const safe = !!(zr && zr.safe);
    perPos[lab] = { streak: s, safe, z: zr ? zr.z : null, n: zr ? zr.n : 0 };
    if(safe) safeCount++;
  });
  const streakApprox = Math.min.apply(null, labels.map(l => cur[l]));
  const combZ = zones.combined.find(r => r.streak === streakApprox), combinedSafe = !!(combZ && combZ.safe);
  const mode = safeCount === labels.length ? 'AMAN_PER_POSISI' : (combinedSafe ? 'AMAN_GABUNGAN' : 'ZIGZAG');
  return { perPos, combinedSafe, combinedZ: combZ ? combZ.z : null, mode, streakApprox };
}

const API = { T0, EVAL_FROM, GATE_Z, posLabels, parseMarketText, parseNumberList, setHypeMarkets, makeRegistry, baseP, newState,
  learnMarket, forceLab, predict, explain, evalState, evalAll, globalReport, tiltFromReport, serialize, deserialize, pOneSided, filterNumbers, filterLearn, REC_K,
  computeStreakZones, currentStreaks, pickExecution };
if(typeof module !== 'undefined' && module.exports) module.exports = API;
root.AiBrain = API;
})(typeof window !== 'undefined' ? window : globalThis);
