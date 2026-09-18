// ===================== FORMULA =====================
// Formula X, Jumlah & Selisih, Ai Ai (Angka Ikut 4D + Ai Bulanan), Shio 234, dan analyze()
// (fungsi inti yang merender ulang ke-4 panel ini setiap kali data historis diproses).

// ---------- Tabel kode Mistik Lama / Mistik Baru / Index ----------
const DIGIT_MAPS = {
  normal: null,
  mistikLama: {0:1,1:0,2:5,3:8,4:7,5:2,6:9,7:4,8:3,9:6},
  mistikBaru: {0:8,1:7,2:6,3:9,4:5,5:4,6:2,7:1,8:0,9:3},
  index:      {0:5,1:6,2:7,3:8,4:9,5:0,6:1,7:2,8:3,9:4}
};

// Parse data historis dengan informasi lengkap (tanggal, periode, nomor)
function parseHistoryDataFull(raw){
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
        raw: trimmed
      });
    } else {
      out.push({ tanggal: null, periode: null, nomor: trimmed, raw: trimmed });
    }
  });
  return out;
}

// ---------- Formula X: state ----------
let FX_RECOMMENDATIONS = null; // { posLabel: [{key,label,source,pct,hit,total}, ...] } terurut dari akurasi tertinggi
let FX_SELECTED = {};          // posLabel -> INDEX urutan radio yang dipilih (0 = persentase tertinggi),
                                // BUKAN key/nama formula lagi — supaya preset ikut "posisi ke berapa" di
                                // daftar rekomendasi, bukan ikut nama varian (lihat fxSelectedKey di bawah
                                // & presetApplyExtraNow di main.js).
let FX_TOUCHED = {};           // posLabel -> true kalau radio pernah digeser MANUAL oleh user (dipakai Gen 2 untuk tahu beda
                                // antara "masih default" vs "sudah dipilih sendiri") — direset tiap computeFormulaX()/ganti data.
let TOP_POSISI_SELECTED = {};  // posLabel -> 'kuat' | 'sedang' (radio Top Posisi)
let FX_FORMULAS_CACHE = null;  // { formulas, controlN } — daftar formula terakhir dipakai computeFormulaX(), dipakai ulang oleh fxApplyToGenerator()
let FX_OUT_N = 8;              // OUT= jumlah digit kandidat per pool (dulu tetap 8, sekarang bisa 4-9 lewat dropdown #fxOutN)
let FX_HISTORY_DATA = [];      // array [{nomor, periode, tanggal}, ...] — data lengkap dengan periode untuk tabel backtest
// Identitas tombol toggle Auto%/Posisi%/Streak% yang SEDANG AKTIF (exclusive, cuma satu atau
// tidak ada sama sekali) — 'auto' | 'posisi' | 'streak' | null (null = tidak ada/"manual").
// Ikut tersimpan & dimuat lewat preset (lihat presetCollectExtra/presetApplyExtraNow di main.js)
// dan dibaca oleh fxAutoLockGen1FromPreset()/fxSelectedFollowsPreset() di automode.js untuk
// menentukan metode mana yang dipakai mengunci Gen 1 saat preset dimuat ulang — MENGGANTIKAN
// dropdown lama "Pilih Sumber GEN1" (autoGen1SourceSelect) yang sudah dihapus.
let FX_OPT_ACTIVE_METHOD = null;

// Ambil KEY formula aktual dari INDEX yang tersimpan di FX_SELECTED untuk suatu posisi. Fallback
// ke index 0 (persentase tertinggi) kalau index-nya sudah tidak valid lagi untuk data saat ini
// (mis. daftar rekomendasi pasaran baru lebih pendek). Dipakai di semua tempat yang butuh nama
// formula asli (formulaByKey, dsb) — FX_SELECTED sendiri cuma menyimpan urutan/posisi.
function fxSelectedKey(label){
  const recs = FX_RECOMMENDATIONS && FX_RECOMMENDATIONS[label];
  if(!recs || !recs.length) return null;
  const idx = FX_SELECTED[label];
  const rec = (typeof idx === 'number' && recs[idx]) ? recs[idx] : recs[0];
  return rec ? rec.key : null;
}

function applyDigitMap(numStr, map){
  if(!map) return numStr;
  return numStr.split('').map(ch => String(map[parseInt(ch,10)])).join('');
}

// Hitung perilaku naik/turun/tetap + peluang digit berikutnya untuk SATU mode (NORMAL/MISTIK LAMA/MISTIK BARU/INDEX)
// Dipakai ulang oleh Formula X: rankedPerPos[sourceIdx] = pool 8 digit teratas berdasar riwayat delta posisi sourceIdx itu sendiri.
function computeModeAnalysis(used, targetLen, map){
  const mapped = used.map(n => applyDigitMap(n, map));
  const chrono = mapped.slice().reverse(); // terlama -> terbaru

  const lastDigits = [];
  for(let p = 0; p < targetLen; p++) lastDigits.push(parseInt(mapped[0][p], 10));

  // PER POSISI: setiap posisi (A/C/K/E) punya tabel delta sendiri, tidak digabung dengan posisi lain.
  const deltaCountsPerPos = Array.from({length: targetLen}, () => new Array(10).fill(0));
  let globalNaik = 0, globalTurun = 0, globalTetap = 0;
  for(let i = 0; i < chrono.length - 1; i++){
    for(let p = 0; p < targetLen; p++){
      const prevD = parseInt(chrono[i][p], 10);
      const nextD = parseInt(chrono[i+1][p], 10);
      const modDelta = (nextD - prevD + 10) % 10;
      deltaCountsPerPos[p][modDelta]++;
      const raw = nextD - prevD;
      if(raw > 0) globalNaik++; else if(raw < 0) globalTurun++; else globalTetap++;
    }
  }
  const totalGlobalTrans = Math.max((chrono.length - 1) * targetLen, 1);
  const globalStats = {
    naikPct: globalNaik / totalGlobalTrans * 100,
    turunPct: globalTurun / totalGlobalTrans * 100,
    tetapPct: globalTetap / totalGlobalTrans * 100
  };

  const transitionWeights = [];
  for(let p = 0; p < targetLen; p++){
    const weights = {};
    for(let d = 0; d <= 9; d++){
      const neededDelta = (d - lastDigits[p] + 10) % 10;
      weights[String(d)] = deltaCountsPerPos[p][neededDelta]; // hanya pakai riwayat delta posisi p sendiri
    }
    transitionWeights.push(weights);
  }

  const rankedPerPos = transitionWeights.map(weights => {
    const totalW = Object.values(weights).reduce((a,b) => a+b, 0) || 1;
    return Object.entries(weights)
      .map(([d, c]) => ({ d, c, pct: (c/totalW*100) }))
      .sort((a,b) => b.c - a.c);
  });

  const kandidatUtama = rankedPerPos.map(r => r[0].d).join('');
  const kandidatAlt = rankedPerPos.map(r => (r[1] || r[0]).d).join('');
  const pctUtama = rankedPerPos.reduce((a, r) => a + r[0].pct, 0) / rankedPerPos.length;
  const pctAlt = rankedPerPos.reduce((a, r) => a + (r[1] || r[0]).pct, 0) / rankedPerPos.length;
  const top8Pools = rankedPerPos.map(r => r.slice(0, FX_OUT_N).map(x => x.d));

  return { lastDigits, transitionWeights, globalStats, rankedPerPos, kandidatUtama, kandidatAlt, pctUtama, pctAlt, top8Pools };
}

// ---------- Formula X ----------
// 5 formula dasar: 4 formula statistik (delta riwayat posisi sumber) + 1 formula BHG (Naik4Turun3, dari digit terakhir langsung).
const FX_BASES = [
  { code:'NRL', map: DIGIT_MAPS.normal,     kind:'stat' },
  { code:'ML',  map: DIGIT_MAPS.mistikLama, kind:'stat' },
  { code:'MB',  map: DIGIT_MAPS.mistikBaru, kind:'stat' },
  { code:'IDX', map: DIGIT_MAPS.index,      kind:'stat' },
  { code:'BHG', map: null,                  kind:'bhg'  },
  { code:'PK',  map: null,                  kind:'pk'   }
];

function mod10(x){ return ((x % 10) + 10) % 10; }

// BHG / Naik4Turun3: dari 1 digit terakhir, ambil sebagian naik + digit itu sendiri + sisanya turun = OUT kandidat.
// Standar OUT=8 -> 4 naik + digit itu sendiri + 3 turun (perilaku lama tetap sama).
function naik4turun3(d){
  const outN = FX_OUT_N;
  const turunCount = Math.floor((outN - 1) / 2);
  const naikCount = outN - 1 - turunCount;
  const naik = Array.from({length: naikCount}, (_, i) => mod10(d + i + 1));
  const turun = Array.from({length: turunCount}, (_, i) => mod10(d - i - 1));
  return [...naik, d, ...turun].map(String);
}

// Pool OUT-digit teratas untuk SETIAP posisi sumber (dipakai lintas posisi target), dari 1 window data (newest-first).
function statPoolsAllSources(windowNewestFirst, map, targetLen){
  if(windowNewestFirst.length < 1) return Array.from({length: targetLen}, () => []);
  return computeModeAnalysis(windowNewestFirst, targetLen, map).rankedPerPos.map(r => r.slice(0, FX_OUT_N).map(x => x.d));
}
function bhgPoolsAllSources(windowNewestFirst, targetLen){
  const last = windowNewestFirst[0].split('').map(ch => parseInt(ch, 10));
  return last.slice(0, targetLen).map(d => naik4turun3(d));
}

// PK / Pola Kemunculan: untuk tiap posisi sumber, ambil digit terakhirnya sebagai "anchor".
// Telusuri riwayat (dari terbaru ke terlama) — tiap kali angka historis MENGANDUNG digit anchor
// di posisi manapun (bukan cuma posisi sumbernya), catat digit apa yang muncul di posisi sumber
// itu pada draw BERIKUTNYA (draw yang lebih lama satu langkah). Kumpulkan semua catatan itu,
// ranking berdasar frekuensi terbanyak → jadi pool 8 kandidat.
function pkPoolsAllSources(windowNewestFirst, targetLen){
  const pools = [];
  for(let sIdx = 0; sIdx < targetLen; sIdx++){
    const anchor = parseInt(windowNewestFirst[0][sIdx], 10);
    const counts = new Array(10).fill(0);
    for(let i = 0; i < windowNewestFirst.length - 1; i++){
      const containsAnchor = windowNewestFirst[i].split('').some(ch => parseInt(ch, 10) === anchor);
      if(containsAnchor){
        const nextDigit = parseInt(windowNewestFirst[i + 1][sIdx], 10);
        counts[nextDigit]++;
      }
    }
    const ranked = counts.map((c, d) => ({ d: String(d), c })).sort((a, b) => b.c - a.c);
    pools.push(ranked.slice(0, FX_OUT_N).map(r => r.d));
  }
  return pools;
}

// PK dan BHG tidak punya dropdown kontrol sendiri: jendela datanya otomatis, minimal 19 data (kalau kurang, formula ini
// dianggap belum bisa dipakai / tidak tampil di hasil), maksimal membaca 29 data terbaru.
const FX_BHG_PK_MIN = 19;
const FX_BHG_PK_MAX = 29;

// Susun daftar varian formula: tiap base x tiap posisi-sumber = 1 varian. fn(windowNewestFirst) -> pool per posisi target (sama untuk semua posisi, diambil dari 1 posisi sumber).
// controlN = jendela data untuk formula statistik (NRL/ML/MB/IDX). PK/BHG memakai FX_BHG_PK_MIN..FX_BHG_PK_MAX otomatis.
function fxBuildFormulaList(posLabels, controlN){
  const targetLen = posLabels.length;
  const list = [];
  FX_BASES.forEach(base => {
    posLabels.forEach((sourceLabel, sIdx) => {
      list.push({
        key: base.code + '_' + sourceLabel,
        label: base.code,
        source: sourceLabel,
        kind: base.kind,
        fn: (windowNewestFirst) => {
          if(base.kind === 'stat'){
            const pool = statPoolsAllSources(windowNewestFirst.slice(0, controlN), base.map, targetLen)[sIdx];
            return posLabels.map(() => pool);
          }
          // PK/BHG: butuh minimal FX_BHG_PK_MIN data, baca maksimal FX_BHG_PK_MAX data terbaru.
          if(windowNewestFirst.length < FX_BHG_PK_MIN) throw new Error('Data PK/BHG belum cukup (minimal 19).');
          const win = windowNewestFirst.slice(0, FX_BHG_PK_MAX);
          const pool = base.kind === 'bhg'
            ? bhgPoolsAllSources(win, targetLen)[sIdx]
            : pkPoolsAllSources(win, targetLen)[sIdx];
          return posLabels.map(() => pool);
        }
      });
    });
  });
  return list;
}

// Uji akurasi tren: geser mundur dari data terbaru, tiap langkah pakai window sebelumnya untuk menebak 1 data berikutnya, sampai N transisi terkumpul.
function fxTrendAccuracy(formula, chronoNum, controlN, trendN, posIdx){
  const minNeeded = (formula.kind === 'bhg' || formula.kind === 'pk') ? FX_BHG_PK_MIN : Math.min(controlN, 1);
  let hit = 0, total = 0;
  for(let i = chronoNum.length - 1; i >= 1 && total < trendN; i--){
    const available = chronoNum.slice(0, i);
    if(available.length < minNeeded) break;
    const windowNewestFirst = available.slice().reverse();
    let pools;
    try{ pools = formula.fn(windowNewestFirst); }catch(e){ break; }
    const target = chronoNum[i];
    if(pools[posIdx] && pools[posIdx].includes(target[posIdx])) hit++;
    total++;
  }
  return { hit, total, pct: total > 0 ? (hit / total * 100) : 0 };
}

// ---------- Optimasi N (Jendela Tren & Kontrol) — bandingkan beberapa kandidat, pilih yang terbaik ----------
const FX_N_CANDIDATES = [3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];

// Batas bawah interval kepercayaan Wilson (95%) — "menghukum" akurasi dari sampel kecil yang kebetulan tinggi,
// beda dari persentase mentah (hit/total) yang gampang bias kalau totalnya sedikit.
function wilsonLowerBound(hit, total, z){
  z = z || 1.96;
  if(total === 0) return 0;
  const phat = hit / total;
  const denom = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denom;
}

// ---------- OPTIMIZER "Posisi%" ----------
// Langsung cari kombinasi formula terbaik lintas posisi A/C/K/E — CNTRL dan Tren TETAP dipakai
// apa adanya dari dropdown yang aktif sekarang (tidak ikut dicari sama sekali).
// Jumlah kandidat teratas per posisi yang dikombinasikan — dulu tetap 6, sekarang bisa dipilih
// lewat dropdown "BCT :" (#fxTopN, pilihan 6-12, default 6) di atas tombol Hitung Ulang.
function fxGetPosisiTopN(){
  const el = document.getElementById('fxTopN');
  const n = el ? parseInt(el.value, 10) : 6;
  return (Number.isFinite(n) && n > 0) ? n : 6;
}

// Hitung "Akurasi Keseluruhan" (gabungan — wajib benar BERSAMAAN di semua posisi pada baris yang
// sama) untuk satu kombinasi formula tertentu. Logikanya identik dengan renderFxBacktestTable,
// tapi dilepas dari FX_SELECTED supaya bisa dipakai menguji kombinasi yang belum tentu aktif di radio.
function fxJointAccuracy(selFn, posLabels, chronoNum, controlN){
  const minNeeded = Math.max(...selFn.map(f => (f.kind === 'bhg' || f.kind === 'pk') ? FX_BHG_PK_MIN : (controlN === Infinity ? 1 : controlN)));
  let success = 0, total = 0;
  for(let i = minNeeded; i < chronoNum.length; i++){
    const windowNewestFirst = chronoNum.slice(0, i).slice().reverse();
    const target = chronoNum[i];
    let ok = true;
    for(let p = 0; p < posLabels.length; p++){
      let pools;
      try{ pools = selFn[p].fn(windowNewestFirst); }catch(e){ pools = null; }
      if(!(pools && pools[p] && pools[p].includes(target[p]))){ ok = false; break; }
    }
    if(ok) success++;
    total++;
  }
  return { success, total, pct: total > 0 ? (success / total * 100) : 0 };
}

// ---------- STREAK% — cari kombinasi formula dengan SUKSES BERUNTUN terpanjang dari baris
// TERBARU mundur ke belakang (BUKAN akurasi total/Wilson — murni Control N apa adanya dari
// dropdown, tanpa optimasi Tren N sama sekali, sejalan dengan cara kerja tabel backtest). ----------
//
// ATURAN INTI (beda total dari Posisi%/Auto%): kalau baris PALING ATAS (paling baru) sudah
// GAGAL, streak formula itu = 0 — walau baris ke-2 dst di bawahnya sukses panjang, TETAP
// diabaikan/tidak dihitung. Jadi ini bukan "streak terpanjang di manapun dalam riwayat",
// tapi "sudah berapa lama sukses TANPA PUTUS sampai sekarang".
const FX_STREAK_MIN = 3;      // di bawah ini dianggap tidak layak/tidak valid
const FX_STREAK_HARD_CAP = 100; // batas mutlak (dipakai kalau Tren N = "semua"/tak terhingga, supaya tidak looping ribuan baris)

// Streak individual 1 formula di 1 posisi — dipakai untuk menyaring kandidat top-N tiap posisi
// sebelum dikombinasikan (sama seperti fxTrendAccuracy dipakai menyaring FX_POSISI_TOP_N).
// maxStreak = batas atas hitung mundur, diambil dari Tren N yang sedang aktif di dropdown.
function fxStreakAccuracy(formula, chronoNum, controlN, posIdx, maxStreak){
  const minNeeded = (formula.kind === 'bhg' || formula.kind === 'pk') ? FX_BHG_PK_MIN : Math.min(controlN, 1);
  let streak = 0;
  for(let i = chronoNum.length - 1; i >= 1 && streak < maxStreak; i--){
    const available = chronoNum.slice(0, i);
    if(available.length < minNeeded) break;
    const windowNewestFirst = available.slice().reverse();
    let pools;
    try{ pools = formula.fn(windowNewestFirst); }catch(e){ break; }
    const target = chronoNum[i];
    const hit = !!(pools[posIdx] && pools[posIdx].includes(target[posIdx]));
    if(!hit) break; // baris ini (atau baris paling atas kalau i = chronoNum.length-1) GAGAL -> stop
    streak++;
  }
  return streak;
}

// Streak GABUNGAN (joint) — baris dihitung sukses hanya kalau SEMUA posisi OK bareng di baris
// yang sama. Logikanya identik dengan fxJointAccuracy, tapi berhenti di GAGAL pertama (dari
// baris terbaru) alih-alih menjumlah semua transisi. Dipakai untuk menilai 1 kombinasi lengkap
// (A+C+K+E) yang sudah dipilih dari hasil pencarian kombinasi di bawah.
function fxJointStreak(selFn, posLabels, chronoNum, controlN, maxStreak){
  const minNeeded = Math.max(...selFn.map(f => (f.kind === 'bhg' || f.kind === 'pk') ? FX_BHG_PK_MIN : (controlN === Infinity ? 1 : controlN)));
  let streak = 0;
  for(let i = chronoNum.length - 1; i >= minNeeded && streak < maxStreak; i--){
    const windowNewestFirst = chronoNum.slice(0, i).slice().reverse();
    const target = chronoNum[i];
    let ok = true;
    for(let p = 0; p < posLabels.length; p++){
      let pools;
      try{ pools = selFn[p].fn(windowNewestFirst); }catch(e){ pools = null; }
      if(!(pools && pools[p] && pools[p].includes(target[p]))){ ok = false; break; }
    }
    if(!ok) break; // baris ini GAGAL -> stop, streak final
    streak++;
  }
  return streak;
}

// Cari kombinasi formula (lintas posisi) dengan Streak Gabungan terpanjang. Pola pencarian SAMA
// PERSIS seperti fxSearchBestPosisiCombo (Posisi%): ambil TOP-N kandidat tiap posisi dulu (di
// sini disaring pakai streak individual, bukan akurasi), baru coba SEMUA kombinasi lintas posisi
// dan pilih yang Streak Gabungan-nya paling panjang — karena streak individual tinggi per posisi
// TIDAK menjamin streak gabungan tinggi (harus OK bersamaan di baris yang sama).
//
// CNTRL dan Tren N dipakai APA ADANYA dari dropdown yang sedang aktif (persis seperti tombol
// Posisi%) — TIDAK ada pencarian/optimasi N di sini, dan TIDAK melibatkan Wilson sama sekali.
// Tren N di sini berperan sebagai batas atas ("maksimal cari sampai berapa baris ke belakang"),
// bukan sebagai jumlah sampel akurasi seperti pada Posisi%/Auto%.
function fxSearchBestStreakCombo(used, posLabels, controlN, trendN){
  const chronoNum = used.slice().reverse();
  const maxStreak = (trendN === Infinity) ? FX_STREAK_HARD_CAP : Math.min(trendN, FX_STREAK_HARD_CAP);
  const formulas = fxBuildFormulaList(posLabels, controlN);
  const topByLabel = {};
  posLabels.forEach((label, idx) => {
    const arr = [];
    formulas.forEach(f => {
      const streak = fxStreakAccuracy(f, chronoNum, controlN, idx, maxStreak);
      arr.push({ key: f.key, fn: f.fn, kind: f.kind, streak });
    });
    arr.sort((a, b) => b.streak - a.streak); // DESCENDING — streak individual terpanjang duluan
    topByLabel[label] = arr.slice(0, fxGetPosisiTopN());
  });
  if(posLabels.some(label => !topByLabel[label].length)) return null;

  let best = null; // { picks: {label:key}, streak, maxStreak }
  const allCombos = []; // dikumpulkan buat Tabel Kombinasi ACKE (semua kombinasi yang dicoba, belum diurut)
  (function recurse(idx, picks){
    if(idx === posLabels.length){
      const selFn = posLabels.map(label => picks[label]);
      const streak = fxJointStreak(selFn, posLabels, chronoNum, controlN, maxStreak);
      // Sekalian hitung Pss% (akurasi keseluruhan gabungan) untuk baris ini — Tabel Kombinasi
      // ACKE sekarang selalu tampilkan Status & Pss% bersamaan, apa pun tombol yang dipencet.
      const r = fxJointAccuracy(selFn, posLabels, chronoNum, controlN);
      const pickedKeys = {};
      posLabels.forEach((label, i) => { pickedKeys[label] = selFn[i].key; });
      allCombos.push({ picks: pickedKeys, streak, pct: r.pct, success: r.success, total: r.total });
      if(!best || streak > best.streak){
        best = { picks: pickedKeys, streak, maxStreak, pct: r.pct, success: r.success, total: r.total };
      }
      return;
    }
    const label = posLabels[idx];
    topByLabel[label].forEach(cand => {
      picks[label] = cand;
      recurse(idx + 1, picks);
    });
  })(0, {});
  if(best){
    allCombos.sort((a, b) => b.streak - a.streak); // DESCENDING — dipakai Tabel Kombinasi ACKE
    best.all = allCombos;
  }
  return best;
}

// Tahap 2: di Tren pemenang (Tahap 1), ambil TOP-N (BCT) formula tiap posisi (akurasi individual
// tertinggi), lalu coba SEMUA kombinasi lintas posisi (6^jumlah posisi) — pilih kombinasi dengan
// Akurasi Keseluruhan paling tinggi. Akurasi individual tinggi per posisi TIDAK menjamin Akurasi
// Keseluruhan tinggi (posisi-posisi itu harus benar BERSAMAAN di baris yang sama), makanya perlu
// dicoba satu-satu kombinasinya, bukan cuma ambil rank #1 tiap posisi secara independen.
function fxSearchBestPosisiCombo(used, posLabels, controlN, trendN){
  const chronoNum = used.slice().reverse();
  const formulas = fxBuildFormulaList(posLabels, controlN);
  const topByLabel = {};
  posLabels.forEach((label, idx) => {
    const arr = [];
    formulas.forEach(f => {
      const r = fxTrendAccuracy(f, chronoNum, controlN, trendN, idx);
      if(r.total > 0) arr.push({ key: f.key, fn: f.fn, kind: f.kind, pct: r.pct });
    });
    arr.sort((a, b) => b.pct - a.pct);
    topByLabel[label] = arr.slice(0, fxGetPosisiTopN());
  });
  if(posLabels.some(label => !topByLabel[label].length)) return null;

  // maxStreak dipakai untuk hitung kolom Status (streak gabungan) tiap baris, sama seperti
  // batas yang dipakai fxSearchBestStreakCombo — supaya nilai Status di sini konsisten dengan
  // nilai Status kalau nanti user pencet tombol Streak% pada kombinasi yang sama.
  const maxStreakForRows = (trendN === Infinity) ? FX_STREAK_HARD_CAP : Math.min(trendN, FX_STREAK_HARD_CAP);

  let best = null; // { picks: {label:key}, pct, success, total }
  const allCombos = []; // dikumpulkan buat Tabel Kombinasi ACKE (semua kombinasi yang dicoba, belum diurut)
  (function recurse(idx, picks){
    if(idx === posLabels.length){
      const selFn = posLabels.map(label => picks[label]);
      const r = fxJointAccuracy(selFn, posLabels, chronoNum, controlN);
      // Sekalian hitung Status (streak gabungan) untuk baris ini — Tabel Kombinasi ACKE sekarang
      // selalu tampilkan Pss% & Status bersamaan, apa pun tombol yang dipencet.
      const streak = fxJointStreak(selFn, posLabels, chronoNum, controlN, maxStreakForRows);
      const pickedKeys = {};
      posLabels.forEach((label, i) => { pickedKeys[label] = selFn[i].key; });
      allCombos.push({ picks: pickedKeys, pct: r.pct, success: r.success, total: r.total, streak });
      if(!best || r.pct > best.pct){
        best = { picks: pickedKeys, pct: r.pct, success: r.success, total: r.total, streak };
      }
      return;
    }
    const label = posLabels[idx];
    topByLabel[label].forEach(cand => {
      picks[label] = cand;
      recurse(idx + 1, picks);
    });
  })(0, {});
  if(best){
    allCombos.sort((a, b) => b.pct - a.pct); // DESCENDING — dipakai Tabel Kombinasi ACKE
    best.all = allCombos;
  }
  return best;
}

// ── Pemilihan kandidat GEN 1 dari Tabel Kombinasi ACKE (dipakai tombol 🚀Auto% & 📊Posisi%) ──
// `rows` harus sudah terurut DESCENDING berdasarkan pct (persis allCombos di atas). Aturan:
//   1) Mulai dari tingkat Pss% TERTINGGI. Satu "tingkat" = satu nilai Pss% yang sama (dibulatkan
//      1 desimal, sama seperti yang tertampil) — berapa pun jumlah baris kandidat di tingkat itu,
//      tetap dihitung SATU tingkat.
//   2) Kalau tingkat itu punya minimal 1 baris dengan Status (streak) > 0, ambil baris dengan
//      Status TERTINGGI di tingkat itu sebagai kandidat.
//   3) Kalau SEMUA baris di tingkat itu Status-nya 0x, turun ke tingkat Pss% berikutnya (lebih
//      rendah) dan ulangi — maksimal 5 tingkat dicoba dari yang tertinggi.
//   4) Kalau sampai 5 tingkat tidak ketemu satupun baris Status>0, return null — JANGAN diam-diam
//      fallback ke Pss% tertinggi. Pemanggil wajib menampilkan pesan gagal ke user (lihat
//      FX_GEN1_NO_CANDIDATE_MSG) dan TIDAK mengubah FX_SELECTED/Gen 1 yang sedang aktif.
const FX_GEN1_MAX_TINGKAT = 5;
const FX_GEN1_NO_CANDIDATE_MSG = 'Silakan ganti Tren, ctrl, dan out, karena setingan yang anda pilih tidak memenuhi syarat';
function fxPickGen1Candidate(rows){
  if(!rows || !rows.length) return null;
  const roundPct = r => Math.round(r.pct * 10) / 10;
  let i = 0, tingkat = 0;
  while(i < rows.length && tingkat < FX_GEN1_MAX_TINGKAT){
    const groupPct = roundPct(rows[i]);
    let j = i;
    let bestInGroup = null;
    while(j < rows.length && roundPct(rows[j]) === groupPct){
      if((rows[j].streak || 0) > 0 && (!bestInGroup || rows[j].streak > bestInGroup.streak)){
        bestInGroup = rows[j];
      }
      j++;
    }
    if(bestInGroup) return bestInGroup;
    i = j;
    tingkat++;
  }
  return null;
}
// lalu kembalikan pasangan dengan skor rata-rata tertinggi antar posisi.
function fxSearchBestN(used, posLabels, scoreFn){
  const chronoNum = used.slice().reverse();
  let best = null;
  FX_N_CANDIDATES.forEach(controlN => {
    const formulas = fxBuildFormulaList(posLabels, controlN);
    FX_N_CANDIDATES.forEach(trendN => {
      let sumScore = 0, posCounted = 0;
      posLabels.forEach((label, idx) => {
        let bestScore = -1;
        formulas.forEach(f => {
          const r = scoreFn(f, chronoNum, controlN, trendN, idx);
          if(r.total > 0){
            const score = wilsonLowerBound(r.hit, r.total);
            if(score > bestScore) bestScore = score;
          }
        });
        if(bestScore >= 0){ sumScore += bestScore; posCounted++; }
      });
      if(posCounted === posLabels.length){
        const avgScore = sumScore / posCounted;
        if(!best || avgScore > best.avgScore) best = { controlN, trendN, avgScore };
      }
    });
  });
  return best;
}

// ---------- Versi DIBALIK (untuk Gen 2 Auto%) — cari yang PALING BURUK, bukan paling akurat ----------
// Dipakai HANYA oleh Gen 2 Auto% (lihat fxAutoLockGen2FromAutoPercent di automode.js). Sengaja
// dipisah total dari fxSearchBestN/fxSearchBestPosisiCombo di atas (tidak menimpa apa pun),
// dan TIDAK PERNAH menyentuh dropdown Kontrol N/Tren N/Out N atau radio Formula X yang tampil
// di layar — murni dihitung diam-diam pakai FX_OUT_N yang sedang aktif sekarang sebagai acuan
// ranking (sama seperti fxSearchBestN yang juga tidak pernah mengubah Out N).
//
// CUKUP WILSON SAJA (tidak ada tahap Posisi%/kombinasi gabungan lagi) — satu kriteria dipakai
// untuk dua hal: (1) cari Control N/Tren N, (2) ranking formula per posisi (independen per
// posisi, lihat fxRankWorstWilsonPerPosition di bawah).
//
// Kandidat N DIBATASI khusus untuk Gen2 Auto% ini saja: hanya yang < 60 (60 ke atas TIDAK
// dipakai) — dipisah dari FX_N_CANDIDATES aslinya (dipakai apa adanya oleh Gen1/tombol Formula X,
// tidak ikut dibatasi).
const FX_N_CANDIDATES_GEN2_WORST = FX_N_CANDIDATES.filter(n => n < 60);

// Wilson dibalik: skor per posisi diambil dari formula PALING RENDAH (bukan paling tinggi),
// lalu pasangan Control N/Tren N yang dipilih adalah yang skor rata-ratanya PALING RENDAH.
function fxSearchWorstN(used, posLabels){
  const chronoNum = used.slice().reverse();
  let worst = null;
  FX_N_CANDIDATES_GEN2_WORST.forEach(controlN => {
    const formulas = fxBuildFormulaList(posLabels, controlN);
    FX_N_CANDIDATES_GEN2_WORST.forEach(trendN => {
      let sumScore = 0, posCounted = 0;
      posLabels.forEach((label, idx) => {
        let worstScore = Infinity;
        formulas.forEach(f => {
          const r = fxTrendAccuracy(f, chronoNum, controlN, trendN, idx);
          if(r.total > 0){
            const score = wilsonLowerBound(r.hit, r.total);
            if(score < worstScore) worstScore = score;
          }
        });
        if(worstScore < Infinity){ sumScore += worstScore; posCounted++; }
      });
      if(posCounted === posLabels.length){
        const avgScore = sumScore / posCounted;
        if(!worst || avgScore < worst.avgScore) worst = { controlN, trendN, avgScore };
      }
    });
  });
  return worst;
}

// Ranking per posisi (INDEPENDEN — tidak ada lagi kombinasi gabungan lintas posisi/Posisi%)
// berdasarkan skor WILSON paling rendah tiap formula di posisi itu. `count` formula ber-skor
// Wilson terendah dikembalikan sebagai peringkat terburuk ke-1..ke-`count` per posisi, lalu
// tinggal dipasangkan langsung ke Gen2A/2B/2C (peringkat 1 -> A, 2 -> B, 3 -> C) di
// fxAutoLockGen2FromAutoPercent (automode.js) — tanpa pencarian kombinasi apa pun lagi.
function fxRankWorstWilsonPerPosition(used, posLabels, controlN, trendN, count){
  const chronoNum = used.slice().reverse();
  const formulas = fxBuildFormulaList(posLabels, controlN);
  const rankedByLabel = {};
  posLabels.forEach((label, idx) => {
    const arr = [];
    formulas.forEach(f => {
      const r = fxTrendAccuracy(f, chronoNum, controlN, trendN, idx);
      if(r.total > 0) arr.push({ key: f.key, score: wilsonLowerBound(r.hit, r.total) });
    });
    arr.sort((a, b) => a.score - b.score); // ASCENDING — skor Wilson paling rendah duluan
    rankedByLabel[label] = arr;
  });
  if(posLabels.some(label => !rankedByLabel[label].length)) return [];

  const result = [];
  for(let rank = 0; rank < count; rank++){
    const picks = {};
    posLabels.forEach(label => {
      const list = rankedByLabel[label];
      const cand = list[rank] || list[list.length - 1]; // daftar lebih pendek dari rank -> pakai yang paling akhir
      picks[label] = cand.key;
    });
    result.push({ picks });
  }
  return result;
}

function fxApplyOptimizedN(result, label){
  const status = document.getElementById('fxStatus');
  if(!result){
    status.style.color = 'var(--rose)';
    status.textContent = 'Data historis belum cukup untuk mengoptimalkan N.';
    return;
  }
  document.getElementById('fxControlN').value = String(result.controlN);
  document.getElementById('fxTrendN').value = String(result.trendN);
  computeFormulaX(lastHistoryNumbers, lastPosLabels);
  status.style.color = 'var(--teal)';
  status.textContent = `${label}: Kontrol N=${result.controlN}, Jendela Tren N=${result.trendN} — ` + status.textContent;
}

// Tampilkan spinner dulu, baru jalankan komputasi berat lewat setTimeout — supaya browser sempat
// menggambar animasinya sebelum thread JS sibuk (kalau langsung dijalankan, animasinya tidak akan terlihat).
function fxRunOptimizer(label, computeFn){
  const loading = document.getElementById('fxOptLoading');
  const loadingText = document.getElementById('fxOptLoadingText');
  const buttons = [
    document.getElementById('fxOptWilsonBtn'),
    document.getElementById('fxOptWalkBtn'),
    document.getElementById('fxOptStreakBtn'),
    document.getElementById('fxRecalcBtn')
  ];
  buttons.forEach(b => b.disabled = true);
  loadingText.textContent = `Menghitung kombinasi N (${label})...`;
  loading.style.display = 'flex';
  setTimeout(() => {
    try{
      computeFn();
    } finally {
      loading.style.display = 'none';
      buttons.forEach(b => b.disabled = false);
    }
  }, 30);
}

// Radio "Sumber Data" (Formula X):
// - Data Default  = baca ULANG kotak Data Historis (#dataInput) langsung, sama seperti analyze() —
//   jadi selalu ikut pasaran/periode yang lagi aktif di kotak itu, tidak pernah "nyangkut" ke data lama.
// - Data Terbaru  = ambil dari tabel Histori All Periode (allPeriodeHistoryList, lihat historyall.js
//   — gabungan SEMUA pasaran dari Firebase, terbaru di index 0). Dipakai APA ADANYA, semua baris lintas
//   pasaran dicampur, TIDAK difilter ke pasaran yang aktif (sesuai keputusan user).
// Menimpa lastHistoryNumbers/lastPosLabels supaya render lain (tabel backtest, Angka Hasil Tren, dst)
// ikut konsisten.
function fxRefreshHistoryIfTerbaru(){
  const statusEl = document.getElementById('fxDataSourceStatus');
  const useTerbaru = (document.querySelector('input[name="fxDataSource"]:checked') || {}).value === 'terbaru';
  let tokens;
  if(useTerbaru){
    const rows = (typeof allPeriodeHistoryList !== 'undefined' && Array.isArray(allPeriodeHistoryList)) ? allPeriodeHistoryList : [];
    tokens = rows.map(r => String((r && r.nomor) || '').replace(/[^0-9]/g, '')).filter(Boolean);
    // Simpan data lengkap dengan periode
    window.FX_HISTORY_DATA = rows.map(r => ({
      nomor: String((r && r.nomor) || '').replace(/[^0-9]/g, ''),
      periode: r && r.periode ? r.periode : '',
      tanggal: r && r.tanggal ? r.tanggal : ''
    })).filter(d => d.nomor);
  } else {
    const raw = document.getElementById('dataInput').value;
    const parsed = parseDataWithMonth(raw);
    tokens = parsed.tokens;
    // Simpan data lengkap dengan periode dari dataInput
    window.FX_HISTORY_DATA = parseHistoryDataFull(raw).map(d => ({
      nomor: d.nomor,
      periode: d.periode || '',
      tanggal: d.tanggal || ''
    })).filter(d => d.nomor && d.nomor.length === (parsed.tokens[0] ? parsed.tokens[0].length : 4));
  }
  if(!tokens.length){
    if(statusEl) statusEl.textContent = useTerbaru
      ? '⚠️ Tabel Histori All Periode masih kosong, pakai data sebelumnya.'
      : '⚠️ Kotak Data Historis kosong/tidak terbaca, pakai data sebelumnya.';
    return; // sumbernya kosong/tidak valid — biarkan snapshot lama, jangan ditimpa
  }
  const targetLen = pickTargetLength(tokens);
  const used = tokens.filter(t => t.length === targetLen);
  if(!used.length) return;
  const posLabels = targetLen === 4
    ? ['A','C','K','E']
    : targetLen === 3
      ? ['C','K','E']
      : ['K','E'];
  lastHistoryNumbers = used;
  lastPosLabels = posLabels;
  if(statusEl) statusEl.textContent = useTerbaru
    ? `📡 Data Terbaru (Histori All Periode, semua pasaran) — ${used.length} angka.`
    : `📄 Data Default (Data Historis) — ${used.length} angka.`;
}

// Klik radio langsung memicu refresh + hitung ulang (tidak perlu klik "Hitung Ulang" secara manual).
document.querySelectorAll('input[name="fxDataSource"]').forEach(radio => {
  radio.addEventListener('change', () => {
    fxRefreshHistoryIfTerbaru();
    if(lastHistoryNumbers.length && lastPosLabels) computeFormulaX(lastHistoryNumbers, lastPosLabels);
  });
});

// Inti optimizer "Auto%" (Wilson -> Posisi%), dilepas dari handler tombol supaya bisa dipanggil
// ulang dari luar (mis. Mode Auto, lihat fxAutoLockGen1FromPreset di automode.js) tanpa lewat
// klik tombol/spinner. Mengasumsikan lastHistoryNumbers/lastPosLabels sudah segar saat dipanggil.
// Return true kalau berhasil set FX_SELECTED, false kalau data belum cukup.
function fxRunAutoPercentCore(silent){
  const status = document.getElementById('fxStatus');

  // Tahap 1: cari CNTRL+Tren terbaik pakai skor Wilson (persis logika lama tombol Wilson Score).
  const best = fxSearchBestN(lastHistoryNumbers, lastPosLabels, fxTrendAccuracy);
  if(!best){
    status.style.color = 'var(--rose)';
    status.textContent = 'Data historis belum cukup untuk mengoptimalkan N.';
    return false;
  }
  fxApplyOptimizedN(best, 'Wilson Score'); // set dropdown CNTRL/Tren + computeFormulaX ulang

  // Tahap 2: begitu Tahap 1 selesai, lanjut cari kombinasi top-N (BCT) posisi (persis logika tombol
  // Posisi%) — tapi CNTRL/Tren-nya dari hasil Wilson di Tahap 1, bukan dari dropdown lama.
  const combo = fxSearchBestPosisiCombo(lastHistoryNumbers, lastPosLabels, best.controlN, best.trendN);
  if(!combo){
    status.style.color = 'var(--rose)';
    status.textContent = `Kontrol N=${best.controlN}, Tren N=${best.trendN} — kombinasi posisi gagal dihitung.`;
    return false;
  }

  FX_LAST_COMBO_TABLE = combo.all ? { mode: 'pct', rows: combo.all, posLabels: lastPosLabels.slice() } : null;

  const chosen = fxPickGen1Candidate(combo.all);
  if(!chosen){
    renderFxComboTable();
    status.style.color = 'var(--rose)';
    status.textContent = FX_GEN1_NO_CANDIDATE_MSG;
    if(!silent) alert(FX_GEN1_NO_CANDIDATE_MSG);
    return false;
  }

  lastPosLabels.forEach(label => {
    const idx = (FX_RECOMMENDATIONS[label] || []).findIndex(r => r.key === chosen.picks[label]);
    if(idx >= 0){ FX_SELECTED[label] = idx; FX_TOUCHED[label] = true; }
  });
  renderFormulaX(lastPosLabels);
  renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers);
  renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
  fxApplyToGenerator(true);
  if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
  if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);

  renderFxComboTable();

  status.style.color = 'var(--teal)';
  status.textContent = `Auto%: Kontrol N=${best.controlN}, Tren N=${best.trendN} — Pss% ${chosen.pct.toFixed(1)}% (${chosen.success}/${chosen.total}), Status ${chosen.streak}x.`;
  return true;
}

// ── Inti optimizer "Posisi%" — dilepas dari handler tombol (persis pola fxRunAutoPercentCore)
// supaya bisa dipanggil ulang dari luar (fxAutoLockGen1FromPreset di automode.js) sesuai
// identitas tombol yang tersimpan di preset, tanpa lewat klik tombol/spinner. Mengasumsikan
// lastHistoryNumbers/lastPosLabels sudah segar saat dipanggil. Return true kalau berhasil
// set FX_SELECTED, false kalau data belum cukup/kandidat tidak ketemu.
function fxRunPosisiPercentCore(silent){
  const status = document.getElementById('fxStatus');
  const controlNRaw = document.getElementById('fxControlN').value;
  const trendNRaw = document.getElementById('fxTrendN').value;
  const controlN = controlNRaw === 'all' ? Infinity : parseInt(controlNRaw, 10);
  const trendN = trendNRaw === 'all' ? Infinity : parseInt(trendNRaw, 10);

  // Langsung cari kombinasi top-N (BCT) per posisi dengan Akurasi Keseluruhan tertinggi — CNTRL &
  // Tren dipakai apa adanya dari dropdown, sama sekali tidak diubah/dicari.
  const combo = fxSearchBestPosisiCombo(lastHistoryNumbers, lastPosLabels, controlN, trendN);
  if(!combo){
    status.style.color = 'var(--rose)';
    status.textContent = 'Data historis belum cukup untuk mencari kombinasi posisi terbaik.';
    return false;
  }

  FX_LAST_COMBO_TABLE = combo.all ? { mode: 'pct', rows: combo.all, posLabels: lastPosLabels.slice() } : null;

  const chosen = fxPickGen1Candidate(combo.all);
  if(!chosen){
    renderFxComboTable();
    status.style.color = 'var(--rose)';
    status.textContent = FX_GEN1_NO_CANDIDATE_MSG;
    if(!silent) alert(FX_GEN1_NO_CANDIDATE_MSG);
    return false;
  }

  // Arahkan radio tiap posisi ke formula pemenang kombinasi (bukan cuma rank #1 independen).
  lastPosLabels.forEach(label => {
    const idx = (FX_RECOMMENDATIONS[label] || []).findIndex(r => r.key === chosen.picks[label]);
    if(idx >= 0){ FX_SELECTED[label] = idx; FX_TOUCHED[label] = true; }
  });
  renderFormulaX(lastPosLabels);
  renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers);
  renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
  fxApplyToGenerator(true);
  if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
  if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);

  renderFxComboTable();

  status.style.color = 'var(--teal)';
  status.textContent = `Posisi%: Pss% ${chosen.pct.toFixed(1)}% (${chosen.success}/${chosen.total}), Status ${chosen.streak}x.`;
  return true;
}

// ── Inti optimizer "Streak%" — cari kombinasi formula dengan SUKSES BERUNTUN terpanjang dari
// baris TERBARU (lihat fxSearchBestStreakCombo di atas untuk aturan lengkap: baris teratas GAGAL
// = streak 0, tidak peduli seberapa panjang streak di baris-baris bawahnya). Dilepas dari handler
// tombol (persis pola fxRunAutoPercentCore/fxRunPosisiPercentCore) supaya bisa dipanggil ulang
// dari fxAutoLockGen1FromPreset() sesuai identitas tombol yang tersimpan di preset. Return true
// kalau berhasil set FX_SELECTED dari kombinasi Streak yang valid, false kalau tidak
// (data belum cukup ATAU tidak ada kombinasi yang lolos ambang FX_STREAK_MIN — pada kasus kedua
// FX_SELECTED tetap dialihkan ke rank #1 akurasi tertinggi seperti perilaku tombol asli, tapi
// return value-nya false supaya pemanggil tahu ini bukan hasil Streak% yang valid). ──
function fxRunStreakPercentCore(silent){
  const status = document.getElementById('fxStatus');
  const controlNRaw = document.getElementById('fxControlN').value;
  const trendNRaw = document.getElementById('fxTrendN').value;
  const controlN = controlNRaw === 'all' ? Infinity : parseInt(controlNRaw, 10);
  const trendN = trendNRaw === 'all' ? Infinity : parseInt(trendNRaw, 10);
  const controlNDisplay = controlN === Infinity ? 'semua' : controlN;
  const trendNDisplay = trendN === Infinity ? 'semua' : trendN;

  const combo = fxSearchBestStreakCombo(lastHistoryNumbers, lastPosLabels, controlN, trendN);
  if(!combo){
    FX_LAST_STREAK_RESULT = null;
    FX_LAST_COMBO_TABLE = null;
    renderFxComboTable();
    status.style.color = 'var(--rose)';
    status.textContent = 'Data historis belum cukup untuk mencari kombinasi Streak.';
    renderFxStreakStatus();
    return false;
  }

  // Tetap tampilkan Tabel Kombinasi ACKE (semua kombinasi yang dicoba) walau nanti di bawah
  // ternyata tidak ada yang lolos ambang FX_STREAK_MIN — biar user tetap bisa lihat & pilih
  // manual dari tabel kalau mau, meski radio otomatis dialihkan ke akurasi tertinggi.
  FX_LAST_COMBO_TABLE = combo.all ? { mode: 'streak', rows: combo.all, posLabels: lastPosLabels.slice() } : null;

  if(combo.streak < FX_STREAK_MIN){
    // Tidak ada kombinasi dengan baris teratas yang sedang sukses beruntun (minimal
    // FX_STREAK_MIN) — sesuai aturan, JANGAN pasang kombinasi ini. Jatuhkan ke rank #1
    // akurasi tertinggi tiap posisi (persis default computeFormulaX/Hitung Ulang), lalu
    // beri tahu user secara eksplisit lewat alert + status + kotak di bawah ANGKA HASIL TREN.
    lastPosLabels.forEach(label => {
      FX_SELECTED[label] = (FX_RECOMMENDATIONS[label] || []).length ? 0 : null;
      FX_TOUCHED[label] = false;
    });
    FX_LAST_STREAK_RESULT = { notFound: true, controlNDisplay, trendNDisplay };
    renderFormulaX(lastPosLabels);
    renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers); // ini juga memanggil renderFxStreakStatus()
    renderTopPosisi(lastPosLabels, lastHistoryNumbers);
    renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
    fxApplyToGenerator(true);
    if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
    if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
    renderFxComboTable();

    status.style.color = 'var(--rose)';
    status.textContent = `Streak%: tidak ada kombinasi valid (belum ada yang sukses beruntun \u2265${FX_STREAK_MIN}x dari baris terbaru) \u2014 dialihkan ke akurasi tertinggi.`;
    if(!silent) alert(`Tidak ada formula/kombinasi yang valid untuk Streak% (minimal ${FX_STREAK_MIN}x sukses beruntun dari baris terbaru).\n\nDialihkan otomatis ke pilihan akurasi tertinggi per posisi.`);
    return false;
  }

  FX_LAST_STREAK_RESULT = { combo, controlNDisplay, trendNDisplay, posLabels: lastPosLabels.slice() };
  lastPosLabels.forEach(label => {
    const idx = (FX_RECOMMENDATIONS[label] || []).findIndex(r => r.key === combo.picks[label]);
    if(idx >= 0){ FX_SELECTED[label] = idx; FX_TOUCHED[label] = true; }
  });
  renderFormulaX(lastPosLabels);
  renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers); // ini juga memanggil renderFxStreakStatus()
  renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
  fxApplyToGenerator(true);
  if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
  if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
  renderFxComboTable();

  status.style.color = 'var(--teal)';
  status.textContent = `Streak%: sukses beruntun ${combo.streak}x dari baris terbaru (gabungan semua posisi).`;
  return true;
}

// ── Toggle tombol Auto%/Posisi%/Streak% — state exclusive (mirip radio), MENGGANTIKAN dropdown
// lama "Pilih Sumber GEN1" (autoGen1SourceSelect, sudah dihapus dari index.html). Tombol yang
// aktif ADALAH identitas metode yang dipakai sistem baca Gen 1 (lihat fxAutoLockGen1FromPreset()
// di automode.js) — identitas ini ikut tersimpan/dimuat lewat preset (presetCollectExtra/
// presetApplyExtraNow di main.js), field fxOptActiveMethod. ──
const FX_OPT_BUTTONS = {
  auto:   document.getElementById('fxOptWilsonBtn'),
  posisi: document.getElementById('fxOptWalkBtn'),
  streak: document.getElementById('fxOptStreakBtn')
};
const FX_OPT_LABELS = { auto: 'Auto%', posisi: 'Posisi%', streak: 'Streak%' };

// Sinkronkan tampilan class "active" ke 3 tombol sesuai FX_OPT_ACTIVE_METHOD saat ini — dipanggil
// baik dari klik tombol maupun setelah preset dimuat (presetApplyExtraNow).
function fxRenderOptToggleUI(){
  Object.keys(FX_OPT_BUTTONS).forEach(method => {
    const btn = FX_OPT_BUTTONS[method];
    if(btn) btn.classList.toggle('active', FX_OPT_ACTIVE_METHOD === method);
  });
}

function fxRunOptMethodCore(method, silent){
  if(method === 'auto')   return fxRunAutoPercentCore(silent);
  if(method === 'posisi') return fxRunPosisiPercentCore(silent);
  if(method === 'streak') return fxRunStreakPercentCore(silent);
  return false;
}

// Klik tombol: kalau tombol yang sama sedang aktif -> nonaktifkan (balik ke "manual", tidak ada
// yang aktif). Kalau tombol lain/belum ada yang aktif -> jadikan tombol ini satu-satunya yang
// aktif, lalu tetap jalankan komputasinya sekali sekarang juga (feedback instan, sama seperti
// perilaku tombol sebelum ada toggle).
function fxHandleOptButtonClick(method){
  fxRefreshHistoryIfTerbaru();
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  FX_OPT_ACTIVE_METHOD = (FX_OPT_ACTIVE_METHOD === method) ? null : method;
  fxRenderOptToggleUI();
  if(FX_OPT_ACTIVE_METHOD === null) return; // baru dinonaktifkan — tidak perlu hitung ulang
  fxRunOptimizer(FX_OPT_LABELS[method], () => { fxRunOptMethodCore(method); });
}

document.getElementById('fxOptWilsonBtn').addEventListener('click', () => fxHandleOptButtonClick('auto'));
document.getElementById('fxOptWalkBtn').addEventListener('click', () => fxHandleOptButtonClick('posisi'));
document.getElementById('fxOptStreakBtn').addEventListener('click', () => fxHandleOptButtonClick('streak'));

function computeFormulaX(used, posLabels){
  // Data/pengaturan baru — hasil pencarian Streak% sebelumnya (kalau ada) sudah tidak relevan
  // lagi (dihitung dari data lama), jadi status di bawah ANGKA HASIL TREN dikosongkan dulu di
  // sini. Kalau user pakai Streak% lagi setelah ini, kotaknya akan terisi ulang otomatis.
  FX_LAST_STREAK_RESULT = null;
  // Sama halnya, Tabel Kombinasi ACKE (hasil Auto%/Posisi%/Streak% sebelumnya) juga sudah tidak
  // relevan lagi begitu data/pengaturan berubah — kosongkan, tunggu user pencet salah satu
  // tombol lagi.
  FX_LAST_COMBO_TABLE = null;
  FX_OUT_N = parseInt(document.getElementById('fxOutN').value, 10) || 8;
  const controlNRaw = document.getElementById('fxControlN').value;
  const trendNRaw = document.getElementById('fxTrendN').value;
  const controlN = controlNRaw === 'all' ? Infinity : parseInt(controlNRaw, 10);
  const trendN = trendNRaw === 'all' ? Infinity : parseInt(trendNRaw, 10);
  const chronoNum = used.slice().reverse(); // urut lama -> baru
  const formulas = fxBuildFormulaList(posLabels, controlN);
  FX_FORMULAS_CACHE = { formulas, controlN };

  const recs = {};
  posLabels.forEach((label, idx) => {
    const arr = [];
    formulas.forEach(f => {
      const r = fxTrendAccuracy(f, chronoNum, controlN, trendN, idx);
      if(r.total > 0) arr.push({ key: f.key, label: f.label, source: f.source, hit: r.hit, total: r.total, pct: r.pct });
    });
    arr.sort((a, b) => b.pct - a.pct);
    recs[label] = arr;
  });
  FX_RECOMMENDATIONS = recs;

  // Selalu arahkan pilihan (radio) ke urutan/index dengan akurasi tertinggi (index 0) tiap kali
  // dihitung ulang / dioptimalkan (Hitung Ulang, Auto%, Posisi%) — tidak mempertahankan pilihan lama.
  posLabels.forEach(label => {
    FX_SELECTED[label] = recs[label].length ? 0 : null;
    FX_TOUCHED[label] = false; // reset penanda "sudah dipilih manual" tiap hitung ulang
  });

  renderFormulaX(posLabels);
  renderFxTrendNumbers(posLabels, used);
  renderTopPosisi(posLabels, used);
  renderFxBacktestTable(posLabels, used);

  const status = document.getElementById('fxStatus');
  const anyData = posLabels.some(l => recs[l].length > 0);
  const trendNDisplay = trendN === Infinity ? 'seluruh' : trendN;
  const controlNDisplay = controlN === Infinity ? 'seluruh' : controlN;
  if(anyData){
    status.style.color = 'var(--teal)';
    status.textContent = `Akurasi dihitung dari maksimal ${trendNDisplay} transisi terakhir per varian (kontrol ${controlNDisplay}, PK/BHG otomatis ${FX_BHG_PK_MIN}-${FX_BHG_PK_MAX}).`;
  } else {
    status.style.color = 'var(--rose)';
    status.textContent = 'Data historis belum cukup untuk menghitung tren Formula X.';
  }

  // Otomatis isi Generator & Kombinasi Acak begitu pilihan (radio) diarahkan ke varian teratas — tanpa perlu klik "ANGKA TOP".
  fxApplyToGenerator(true);
  renderFxComboTable();
}

function renderFormulaX(posLabels){
  const grid = document.getElementById('fxCols');
  if(!FX_RECOMMENDATIONS){ grid.innerHTML = ''; return; }
  const wrap = document.createElement('div');
  wrap.className = 'fxGrid';
  posLabels.forEach(label => {
    const col = document.createElement('div');
    col.className = 'fxCol';
    const h3 = document.createElement('h3');
    h3.textContent = 'Posisi ' + label;
    col.appendChild(h3);
    const list = document.createElement('div');
    list.className = 'fxOptList';
    (FX_RECOMMENDATIONS[label] || []).forEach((opt, i) => {
      const row = document.createElement('label');
      row.className = 'fxOpt' + (i < 3 ? ' top3' : '');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'fxpos_' + label;
      radio.value = opt.key;
      radio.checked = (i === FX_SELECTED[label]);
      radio.addEventListener('change', () => {
        FX_SELECTED[label] = i; // simpan INDEX urutan (posisi radio), bukan key/nama formula
        FX_TOUCHED[label] = true; // tandai posisi ini sudah dipilih manual -> Gen 2 ikut radio mulai sekarang
        renderFxTrendNumbers(posLabels, lastHistoryNumbers);
        renderFxBacktestTable(posLabels, lastHistoryNumbers);
        fxApplyToGenerator(true);
        // Refresh live preview Gen 1 & Gen 2 (yang belum dikunci) supaya ikut berubah
        // sesuai varian yang baru dipilih — sebelumnya panel ini tidak pernah diminta
        // render ulang saat radio Formula X diganti.
        if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
        if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
        renderFxComboTable(); // radio digeser manual -> highlight baris tabel kombinasi ikut update
      });
      row.appendChild(radio);
      const txt = document.createElement('span');
      txt.className = 'lbl';
      txt.textContent = opt.label + ' (' + opt.source + ')';
      row.appendChild(txt);
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = opt.pct.toFixed(1) + '%';
      row.appendChild(pct);
      list.appendChild(row);
    });
    if(!(FX_RECOMMENDATIONS[label] || []).length){
      list.innerHTML = '<p class="emptynote" style="padding:8px 0;">Data belum cukup.</p>';
    }
    col.appendChild(list);
    wrap.appendChild(col);
  });
  grid.innerHTML = '';
  grid.appendChild(wrap);
}

// Tampilkan 3 varian teratas tiap posisi sebagai pool 8 digit langsung (bukan persentase) — "ANGKA HASIL TREN".
// Varian yang sedang dipilih lewat radio (FX_SELECTED) selalu ikut tampil di sini: kalau dia belum termasuk
// 3 teratas, dia menggantikan urutan terakhir supaya angka yang lagi dipakai selalu kelihatan di daftar ini.
// Hasil pencarian Streak% TERAKHIR (null kalau belum pernah dijalankan, atau sudah tidak berlaku lagi
// karena data/posisi berubah) — dipakai renderFxStreakStatus() untuk menampilkan status pencarian di
// bawah "ANGKA HASIL TREN". Direset ke null tiap kali computeFormulaX() jalan (data/pengaturan baru),
// supaya status lama tidak nyangkut menampilkan hasil yang sudah tidak relevan.
let FX_LAST_STREAK_RESULT = null; // { combo, controlN, trendN, posLabels, notFound }

// Hasil terakhir Auto%/Posisi%/Streak% dalam bentuk SEMUA kombinasi (bukan cuma 1 yang terbaik),
// dipakai render Tabel Kombinasi ACKE (#fxComboTableBody). null = belum pernah dipencet /
// sudah tidak relevan lagi (lihat reset di computeFormulaX()).
// { mode: 'pct' | 'streak', rows: [{picks,pct,success,total}] atau [{picks,streak}] (sudah terurut DESC), posLabels }
let FX_LAST_COMBO_TABLE = null;

// Render status pencarian Streak% (kombinasi + panjang streak, atau pesan "tidak ditemukan") tepat
// di bawah "ANGKA HASIL TREN" (#fxStreakStatusBox). Dipanggil ulang tiap kali renderFxTrendNumbers()
// jalan, supaya status tetap tampil konsisten walau user pindah tab/scroll, bukan cuma sesaat setelah
// klik tombol Streak%.
function renderFxStreakStatus(){
  const box = document.getElementById('fxStreakStatusBox');
  if(!box) return;
  const r = FX_LAST_STREAK_RESULT;
  if(!r){ box.innerHTML = ''; return; }

  if(r.notFound){
    box.innerHTML = `<div class="hint" style="border:1px solid var(--rose); border-radius:8px; padding:8px 10px; color:var(--rose);">
      🔥 <b>Streak%</b>: tidak ada kombinasi yang sukses beruntun \u2265${FX_STREAK_MIN}x dari baris terbaru (Kontrol N=${r.controlNDisplay}, Tren N=${r.trendNDisplay}) — dialihkan ke akurasi tertinggi.
    </div>`;
    return;
  }

  const picksTxt = r.posLabels.map(label => {
    const opt = (FX_RECOMMENDATIONS[label] || []).find(o => o.key === r.combo.picks[label]);
    return label + '=' + (opt ? opt.label : r.combo.picks[label]);
  }).join(' · ');

  box.innerHTML = `<div class="hint" style="border:1px solid var(--teal); border-radius:8px; padding:8px 10px; color:var(--teal);">
    🔥 <b>Streak%</b>: sukses beruntun <b>${r.combo.streak}x</b> dari baris terbaru (Kontrol N=${r.controlNDisplay}, Tren N=${r.trendNDisplay}, gabungan semua posisi).<br>
    <span style="opacity:.85;">Kombinasi: ${picksTxt}</span>
  </div>`;
}

// ---------- TABEL KOMBINASI ACKE — daftar SEMUA kombinasi hasil Auto%/Posisi%/Streak% (bukan
// cuma 1 yang terbaik), supaya user bisa lihat & pilih kombinasi lain secara manual. ----------

// Nama kombinasi 1 baris, format "LABEL|SOURCE|+LABEL|SOURCE|..." sesuai urutan posLabels (A→C→K→E).
function fxComboRowName(picks, posLabels){
  if(!FX_FORMULAS_CACHE) return posLabels.map(label => picks[label]).join('+');
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });
  return posLabels.map(label => {
    const f = formulaByKey[picks[label]];
    return f ? (f.label + '|' + f.source + '|') : picks[label];
  }).join('+');
}

// Baris tabel dianggap "aktif" (highlight) kalau picks-nya PERSIS sama dengan radio yang lagi
// terpilih sekarang di semua posisi — dicek langsung dari fxSelectedKey(), bukan disimpan di
// variabel terpisah, supaya selalu sinkron sama radio Posisi ACKE (termasuk kalau radio diubah
// manual di luar tabel ini).
function fxComboRowIsActive(picks, posLabels){
  return posLabels.every(label => fxSelectedKey(label) === picks[label]);
}

// Tampilkan "Angka Hasil" — pool digit tiap posisi (A/C/K/E) dari kombinasi yang SEDANG AKTIF
// di radio Posisi ACKE, apa pun jalannya (klik 🚀Auto%/📊Posisi%/🔥Streak%, klik baris Tabel
// Kombinasi, atau geser radio manual). Menggantikan hint statis lama di #fxComboResultBox —
// dipanggil dari dalam renderFxComboTable() supaya selalu ikut ter-refresh otomatis.
function renderFxComboResult(){
  const box = document.getElementById('fxComboResultBox');
  if(!box) return;
  if(!lastPosLabels || !lastPosLabels.length || !FX_RECOMMENDATIONS || !FX_FORMULAS_CACHE || !lastHistoryNumbers || !lastHistoryNumbers.length){
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });

  const items = lastPosLabels.map((label, idx) => {
    const key = fxSelectedKey(label);
    const f = key ? formulaByKey[key] : null;
    let pool = [];
    if(f){ try{ pool = f.fn(lastHistoryNumbers)[idx] || []; }catch(e){ pool = []; } }
    return { label, digits: pool.join('') };
  });
  if(!items.some(it => it.digits)){
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  const rowsHtml = items.map(it => `<span class="fxComboResultItem"><b>${it.label}:</b>${it.digits || '-'}</span>`).join('');
  box.innerHTML = `<div class="fxComboResultTitle">Angka Hasil</div><div class="fxComboResultGrid">${rowsHtml}</div>`;
  box.style.display = 'block';
}

// Tampilkan status "0x:.. 1x:.. 2x:.. dst" — banyaknya kombinasi (dari SELURUH kombinasi yang
// dicoba fxSearchBestStreakCombo, bukan cuma yang ditampilkan di Tabel Kombinasi ACKE) untuk
// tiap panjang Streak Gabungan. Khusus mode Streak% — kosong/hidden untuk mode Auto%/Posisi%.
function renderFxStreakDist(){
  const box = document.getElementById('fxStreakDistBox');
  if(!box) return;
  const t = FX_LAST_COMBO_TABLE;
  if(!t || t.mode !== 'streak' || !t.rows || !t.rows.length){
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  const counts = {};
  let maxStreak = 0;
  t.rows.forEach(r => {
    counts[r.streak] = (counts[r.streak] || 0) + 1;
    if(r.streak > maxStreak) maxStreak = r.streak;
  });

  const parts = [];
  for(let s = 0; s <= maxStreak; s++){
    const c = counts[s] || 0;
    parts.push(c > 0
      ? `<span class="fxStreakDistItem" data-streak="${s}" title="Klik: generate ${c} kombinasi ${s}x, gabung jadi 1 daftar angka"><b>${s}x</b>:${c}</span>`
      : `<span class="fxStreakDistItem disabled"><b>${s}x</b>:${c}</span>`);
  }

  box.innerHTML = `<div class="fxStreakDistTitle">Status Streak Seluruh Kombinasi (Total ${t.rows.length}) — klik salah satu untuk generate</div><div class="fxStreakDistBody">${parts.join('. ')}.</div>`;
  box.style.display = 'block';

  box.querySelectorAll('.fxStreakDistItem[data-streak]').forEach(el => {
    el.addEventListener('click', () => fxGenerateFromStreakGroup(parseInt(el.dataset.streak, 10)));
  });
}

// Ambil pool digit per posisi (A/C/K/E) untuk 1 baris kombinasi tertentu (picks), TANPA menyentuh
// radio Posisi ACKE yang sedang aktif — dipakai fxGenerateFromStreakGroup supaya bisa hitung pool
// banyak kombinasi sekaligus tanpa mengubah pilihan formula yang sedang ditampilkan user.
function fxPoolsFromPicks(picks, posLabels){
  if(!FX_FORMULAS_CACHE) return posLabels.map(() => []);
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });
  return posLabels.map((label, idx) => {
    const f = formulaByKey[picks[label]];
    if(!f) return [];
    try{ return f.fn(lastHistoryNumbers)[idx] || []; } catch(e){ return []; }
  });
}

// Klik salah satu angka di "Status Streak Seluruh Kombinasi" (misal "5x:13") = ambil SEMUA baris
// Tabel Kombinasi ACKE yang streak-nya sama persis dengan itu, generate tiap kombinasi SECARA
// TERPISAH (cartesian product pool-nya sendiri), lalu gabungkan (union, tanpa duplikat) jadi satu
// daftar angka akhir yang dikirim ke Filter Pangkas Kombinasi — sama seperti pola "Kirim ke Filter"
// Auto Generator, TIDAK mengubah radio Posisi ACKE yang lagi aktif.
function fxGenerateFromStreakGroup(streakVal){
  const t = FX_LAST_COMBO_TABLE;
  if(!t || t.mode !== 'streak' || !t.rows || !t.rows.length){
    alert('Belum ada Tabel Kombinasi Streak% untuk digenerate.');
    return;
  }
  if(!FX_FORMULAS_CACHE || !lastHistoryNumbers.length){
    alert('Hitung Formula X dulu (isi Data Historis lalu Hitung Frekuensi).');
    return;
  }
  const group = t.rows.filter(r => r.streak === streakVal);
  if(!group.length){
    alert('Tidak ada kombinasi dengan streak ' + streakVal + 'x.');
    return;
  }

  const merged = new Set();
  let usedRows = 0;
  group.forEach(r => {
    const pools = fxPoolsFromPicks(r.picks, t.posLabels);
    if(pools.some(p => !p.length)) return; // lewati kombinasi yang pool-nya tidak lengkap
    cartesianProduct(pools).forEach(n => merged.add(n));
    usedRows++;
  });

  if(!merged.size){
    alert('Gagal generate — pool digit tiap posisi belum lengkap untuk kombinasi streak ' + streakVal + 'x.');
    return;
  }

  const hasilList = [...merged];
  filterCustomSource = hasilList; // daftar JADI (gabungan banyak kombinasi) -> Filter pakai ini apa adanya

  // ── Bersihkan dulu: input Generator atas (bulkOut — tidak relevan lagi karena hasilList ini
  // daftar angka jadi, bukan pool per posisi) & hasil Streak lama. fxClearStreakGen1List() sudah
  // otomatis skip kotak fxGen1Preview/fxGen1Count kalau Gen 1 sedang terkunci (itu tampilan
  // kuncian asli, bukan streak).
  const bulkOutEl = document.getElementById('bulkOut');
  if(bulkOutEl) bulkOutEl.value = '';
  fxClearStreakGen1List();

  const combineOutEl = document.getElementById('combineOut');
  const combineCountEl = document.getElementById('combineCountOut');
  if(combineOutEl) combineOutEl.value = hasilList.join('*') + '*';
  if(combineCountEl) combineCountEl.textContent = hasilList.length;

  // ── Simpan hasil Streak ini supaya tombol MANUAL GENERATE bisa membacanya nanti. ──
  fxStreakGen1List = hasilList;

  // Kotak output GEN 1 (di card Auto Generator) HANYA diisi kalau Gen 1 sedang TIDAK terkunci.
  // Kalau sedang terkunci, isi kuncian yang asli tetap ditampilkan apa adanya — angka Streak ini
  // tetap tersimpan di fxStreakGen1List dan otomatis aktif begitu Gen 1 di-unlock (tombol
  // berubah jadi MANUAL GENERATE).
  const gen1PreviewEl = document.getElementById('fxGen1Preview');
  const gen1CountEl = document.getElementById('fxGen1Count');
  let statusNote;
  if(typeof fxGen1Locked !== 'undefined' && fxGen1Locked){
    statusNote = 'Gen 1 sedang terkunci — angka Streak disimpan, baru aktif otomatis kalau Gen 1 di-unlock (tombol MANUAL GENERATE).';
  } else {
    if(gen1PreviewEl) gen1PreviewEl.textContent = hasilList.slice(0, 16).join('*') + (hasilList.length > 16 ? '*…' : '*');
    if(gen1CountEl) gen1CountEl.textContent = hasilList.length + ' kombinasi (dari Status Streak, tanpa lock)';
    statusNote = 'Siap dibaca tombol MANUAL GENERATE.';
  }

  const genWrap = document.getElementById('genWrap');
  if(genWrap) genWrap.style.display = 'block';
  const filterCard = document.getElementById('filterCard');
  if(filterCard) filterCard.style.display = 'block';

  // ── Pindah tampilan ke halaman Generator — sama seperti yang dipakai pipeline Mode Auto/Semi
  // Auto (automode.js) setelah Generate+Filter selesai, supaya user langsung lihat hasilnya
  // tanpa perlu pindah tab manual. ──
  if(typeof window.goPage === 'function') window.goPage('generator');

  if(document.getElementById('filterCard') && document.getElementById('filterCard').style.display === 'block' && typeof resetFilters === 'function'){
    // resetFilters() akan panggil applyFilters() yang otomatis pakai filterCustomSource di atas
    resetFilters();
  }

  const status = document.getElementById('fxStatus');
  if(status) status.textContent = `Digenerate ${usedRows} kombinasi dengan streak ${streakVal}x → digabung jadi ${hasilList.length} angka unik. Sudah terkirim ke Filter Pangkas Kombinasi. ${statusNote}`;
}

function renderFxComboTable(){
  renderFxComboResult();
  renderFxStreakDist();
  const wrap = document.getElementById('fxComboWrap');
  const body = document.getElementById('fxComboTableBody');
  const head2 = document.getElementById('fxComboCol2Head');
  const head3 = document.getElementById('fxComboCol3Head');
  if(!wrap || !body || !head2 || !head3) return;

  const t = FX_LAST_COMBO_TABLE;
  if(!t || !t.rows || !t.rows.length){
    body.innerHTML = '<tr><td colspan="3" class="emptynote" style="padding:10px 8px;">Belum ada data — klik 🚀Auto%, 📊Posisi%, atau 🔥Streak% di atas dulu.</td></tr>';
    head2.textContent = 'Status';
    head3.textContent = 'Pss%';
    return;
  }

  // Kedua metrik (Status = streak gabungan, Pss% = posisi% gabungan) SELALU dihitung bareng di
  // setiap baris (lihat fxSearchBestStreakCombo/fxSearchBestPosisiCombo) — yang beda cuma urutan
  // tampil kolomnya, mengikuti tombol terakhir yang dipencet:
  // 🔥 Streak% -> Status dulu, baru Pss%.  🚀 Auto% / 📊 Posisi% -> Pss% dulu, baru Status.
  const streakFirst = t.mode === 'streak';
  head2.textContent = streakFirst ? 'Status' : 'Pss%';
  head3.textContent = streakFirst ? 'Pss%' : 'Status';

  const rows = t.rows;
  const TOP_N = 25, BOTTOM_N = 25;
  const top = rows.slice(0, TOP_N);
  const bottomCount = Math.max(0, Math.min(BOTTOM_N, rows.length - top.length));
  const bottom = bottomCount > 0 ? rows.slice(rows.length - bottomCount) : [];
  const hiddenCount = rows.length - top.length - bottom.length;

  const rowHtml = r => {
    const name = fxComboRowName(r.picks, t.posLabels);
    const statusVal = (r.streak || 0) + 'x';
    const pssVal = (typeof r.pct === 'number' ? r.pct.toFixed(1) : '0.0') + '%';
    const col2 = streakFirst ? statusVal : pssVal;
    const col3 = streakFirst ? pssVal : statusVal;
    const active = fxComboRowIsActive(r.picks, t.posLabels);
    return `<tr class="fxComboRow${active ? ' selected' : ''}" data-picks='${JSON.stringify(r.picks)}'><td>${name}</td><td>${col2}</td><td>${col3}</td></tr>`;
  };

  let html = top.map(rowHtml).join('');
  if(hiddenCount > 0){
    html += `<tr class="fxComboSep"><td colspan="3">⋯ ${hiddenCount} kombinasi lainnya disembunyikan ⋯</td></tr>`;
  }
  html += bottom.map(rowHtml).join('');
  body.innerHTML = html;

  body.querySelectorAll('tr.fxComboRow').forEach(tr => {
    tr.addEventListener('click', () => {
      const picks = JSON.parse(tr.dataset.picks);
      fxApplyComboRowClick(picks);
    });
  });
}

// Klik 1 baris di Tabel Kombinasi ACKE = SAMA PERSIS seperti klik tombol Posisi%/Streak% lalu
// otomatis terarahkan ke kombinasi itu: geser radio tiap posisi ke formula yang dipilih baris
// ini, lalu ikuti alur render normal (termasuk isi Generator 1/2 yang belum dikunci). TIDAK ada
// state pilihan terpisah — radio Posisi ACKE itu sendiri yang jadi sumber kebenaran.
function fxApplyComboRowClick(picks){
  if(!lastPosLabels || !FX_RECOMMENDATIONS) return;
  lastPosLabels.forEach(label => {
    if(!(label in picks)) return;
    const idx = (FX_RECOMMENDATIONS[label] || []).findIndex(r => r.key === picks[label]);
    if(idx >= 0){ FX_SELECTED[label] = idx; FX_TOUCHED[label] = true; }
  });
  renderFormulaX(lastPosLabels);
  renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers);
  renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
  fxApplyToGenerator(true);
  if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
  if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
  renderFxComboTable(); // refresh highlight baris yang lagi aktif
}

function renderFxTrendNumbers(posLabels, used){
  const grid = document.getElementById('fxTrendCols');
  if(!FX_RECOMMENDATIONS || !FX_FORMULAS_CACHE){ grid.innerHTML = ''; renderFxStreakStatus(); return; }
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });

  const wrap = document.createElement('div');
  wrap.className = 'fxGrid';
  posLabels.forEach((label, idx) => {
    const col = document.createElement('div');
    col.className = 'fxCol';
    const h3 = document.createElement('h3');
    h3.textContent = 'Posisi ' + label;
    col.appendChild(h3);
    const list = document.createElement('div');
    list.className = 'fxTrendList';

    const recs = FX_RECOMMENDATIONS[label] || [];
    const selectedKey = fxSelectedKey(label);
    let shown = recs.slice(0, 3);
    if(selectedKey && !shown.some(o => o.key === selectedKey)){
      const selOpt = recs.find(o => o.key === selectedKey);
      if(selOpt) shown = shown.length ? shown.slice(0, -1).concat(selOpt) : [selOpt];
    }

    shown.forEach(opt => {
      const f = formulaByKey[opt.key];
      let pool = [];
      if(f){
        try{ pool = f.fn(used)[idx] || []; }catch(e){ pool = []; }
      }
      const row = document.createElement('div');
      row.className = 'fxTrendRow' + (opt.key === selectedKey ? ' selected' : '');
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = opt.label + ' (' + opt.source + ')';
      const digits = document.createElement('span');
      digits.className = 'digits';
      digits.textContent = pool.join('');
      row.appendChild(lbl);
      row.appendChild(digits);
      list.appendChild(row);
    });
    if(!shown.length){
      list.innerHTML = '<p class="emptynote" style="padding:6px 0;">Data belum cukup.</p>';
    }
    col.appendChild(list);
    wrap.appendChild(col);
  });
  grid.innerHTML = '';
  grid.appendChild(wrap);
  renderFxStreakStatus();
}

// ---------- TOP POSISI: gabungan 3 sumber tren teratas -> Kuat (ada di 3-3nya) / Sedang (selebihnya) ----------
function computeTopPosisiDigits(label, idx, used){
  if(!FX_RECOMMENDATIONS || !FX_FORMULAS_CACHE) return { kuat: [], sedang: [] };
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });
  const top3 = (FX_RECOMMENDATIONS[label] || []).slice(0, 3);
  const sets = top3.map(opt => {
    const f = formulaByKey[opt.key];
    let pool = [];
    if(f){ try{ pool = f.fn(used)[idx] || []; }catch(e){ pool = []; } }
    return new Set(pool);
  });
  const allDigits = new Set();
  sets.forEach(s => s.forEach(d => allDigits.add(d)));
  const sortNum = arr => arr.slice().sort((a, b) => Number(a) - Number(b));
  const kuat = sortNum([...allDigits].filter(d => sets.length > 0 && sets.every(s => s.has(d))));
  const sedang = sortNum([...allDigits].filter(d => !kuat.includes(d)));
  return { kuat, sedang, hasSource: top3.length > 0 };
}

function renderTopPosisi(posLabels, used){
  const grid = document.getElementById('topPosisiCols');
  if(!grid) return;
  if(!FX_RECOMMENDATIONS || !FX_FORMULAS_CACHE){ grid.innerHTML = ''; return; }

  const wrap = document.createElement('div');
  wrap.className = 'fxGrid';
  const homeTopDigits = [];
  posLabels.forEach((label, idx) => {
    const col = document.createElement('div');
    col.className = 'fxCol';
    const h3 = document.createElement('h3');
    h3.textContent = 'Top Posisi ' + label;
    col.appendChild(h3);

    const { kuat, sedang, hasSource } = computeTopPosisiDigits(label, idx, used);
    homeTopDigits.push(hasSource && kuat[0] ? kuat[0] : null);

    const list = document.createElement('div');
    list.className = 'fxOptList topPosList';

    if(!hasSource){
      list.innerHTML = '<p class="emptynote" style="padding:6px 0;">Data belum cukup.</p>';
    } else {
      [
        { key: 'kuat', label: 'Kuat', digits: kuat.join('') },
        { key: 'sedang', label: 'Sedang', digits: sedang.join('') }
      ].forEach(r => {
        const row = document.createElement('label');
        row.className = 'fxOpt topPosOpt' + (r.key === 'kuat' ? ' top3' : '');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'topPos_' + label;
        radio.value = r.key;
        radio.checked = (r.key === (TOP_POSISI_SELECTED[label] || 'kuat'));
        radio.addEventListener('change', () => { TOP_POSISI_SELECTED[label] = r.key; });
        row.appendChild(radio);
        const txt = document.createElement('span');
        txt.className = 'lbl';
        txt.textContent = r.label + ' : ' + (r.digits || '-');
        row.appendChild(txt);
        list.appendChild(row);
      });
    }
    col.appendChild(list);
    wrap.appendChild(col);
  });
  grid.innerHTML = '';
  grid.appendChild(wrap);

  // Isi 4 kotak digit "Top Candidate" di Beranda dengan digit terkuat tiap posisi
  for(let i = 0; i < 4; i++){
    const box = document.getElementById('homeTopDigit' + i);
    if(!box) continue;
    box.textContent = homeTopDigits[i] || '–';
  }
}

// ---------- TABEL FORMULA X: backtest sukses/gagal dari formula yang sedang DIPILIH (radio) tiap posisi ----------
function renderFxBacktestTable(posLabels, used){
  const kpiBox = document.getElementById('fxKpiBox');
  const thead = document.getElementById('fxTableHead');
  const tbody = document.getElementById('fxTableBody');

  if(!FX_FORMULAS_CACHE){ kpiBox.innerHTML = ''; thead.innerHTML = ''; tbody.innerHTML = ''; return; }

  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });
  const selFn = posLabels.map(label => formulaByKey[fxSelectedKey(label)]);

  if(selFn.some(f => !f)){
    kpiBox.innerHTML = '<p class="emptynote">Pilih varian Formula X dulu untuk tiap posisi.</p>';
    thead.innerHTML = '';
    tbody.innerHTML = '';
    return;
  }

  const controlN = FX_FORMULAS_CACHE.controlN;
  const minNeeded = Math.max(...selFn.map(f => (f.kind === 'bhg' || f.kind === 'pk') ? FX_BHG_PK_MIN : (controlN === Infinity ? 1 : controlN)));
  const chronoNum = used.slice().reverse(); // lama -> baru

  let success = 0, fail = 0;
  const posFail = posLabels.map(() => 0);
  const rows = [];
  for(let i = minNeeded; i < chronoNum.length; i++){
    const availableChrono = chronoNum.slice(0, i);
    const windowNewestFirst = availableChrono.slice().reverse();
    const target = chronoNum[i];
    const hitFlags = [];
    let anyFail = false;
    for(let p = 0; p < posLabels.length; p++){
      let pools;
      try{ pools = selFn[p].fn(windowNewestFirst); }catch(e){ pools = null; }
      const hit = !!(pools && pools[p] && pools[p].includes(target[p]));
      hitFlags.push(hit);
      if(!hit){ posFail[p]++; anyFail = true; }
    }
    const ok = !anyFail;
    if(ok) success++; else fail++;
    rows.push({ prev: chronoNum[i - 1], target, hitFlags, ok });
  }
  rows.reverse(); // tampilkan dari yang terbaru

  const total = success + fail;
  kpiBox.innerHTML = '';
  function kpiEl(label, value){
    const d = document.createElement('div');
    d.innerHTML = `<div class="v">${value}</div><div class="l">${label}</div>`;
    kpiBox.appendChild(d);
  }
  kpiEl('Total Transisi', total);
  kpiEl('Sukses (semua posisi)', success);
  kpiEl('Gagal', fail);
  kpiEl('Akurasi Keseluruhan', total > 0 ? (success / total * 100).toFixed(1) + '%' : '-');
  posLabels.forEach((label, i) => {
    kpiEl('Akurasi ' + label, total > 0 ? ((total - posFail[i]) / total * 100).toFixed(1) + '%' : '-');
  });

  thead.innerHTML = '<th>Periode</th><th>Angka Aktual</th>' + posLabels.map(l => `<th>${l}</th>`).join('') + '<th>Status</th>';

  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="${posLabels.length + 3}" class="emptynote">Data belum cukup untuk backtest (butuh minimal ${minNeeded + 1} data).</td></tr>`;
    return;
  }
  
  // Buat mapping nomor -> periode dari FX_HISTORY_DATA (newest-first)
  const nomor2periode = {};
  if(window.FX_HISTORY_DATA && Array.isArray(window.FX_HISTORY_DATA)){
    window.FX_HISTORY_DATA.forEach(d => {
      if(!nomor2periode[d.nomor]) nomor2periode[d.nomor] = d.periode;
    });
  }
  
  tbody.innerHTML = rows.map(r => {
    const cells = r.hitFlags.map(f => `<td class="${f ? 'fxOk' : 'fxBad'}">${f ? 'OK' : 'X'}</td>`).join('');
    const periode = nomor2periode[r.prev] || '—';
    return `<tr><td>${periode}</td><td>${r.target}</td>${cells}<td class="${r.ok ? 'fxOk' : 'fxBad'}">${r.ok ? 'SUKSES' : 'GAGAL'}</td></tr>`;
  }).join('');
}

function setupSectionToggle(headId, wrapId, iconId){
  document.getElementById(headId).addEventListener('click', () => {
    const wrap = document.getElementById(wrapId);
    const icon = document.getElementById(iconId);
    const isHidden = wrap.style.display === 'none';
    wrap.style.display = isHidden ? 'block' : 'none';
    icon.textContent = isHidden ? '▾' : '▸';
  });
}
setupSectionToggle('fxCardToggle', 'fxCardWrap', 'fxCardToggleIcon');
setupSectionToggle('fxAckeToggle', 'fxAckeWrap', 'fxAckeToggleIcon');
setupSectionToggle('fxComboToggle', 'fxComboWrap', 'fxComboToggleIcon');
setupSectionToggle('fxTableToggle', 'fxTableWrap', 'fxTableToggleIcon');
setupSectionToggle('fxTrendToggle', 'fxTrendWrap', 'fxTrendToggleIcon');
setupSectionToggle('jsToggle', 'jsWrap', 'jsToggleIcon');
setupSectionToggle('cbToggle', 'cbWrap', 'cbToggleIcon');
setupSectionToggle('shioToggle', 'shioWrap', 'shioToggleIcon');
setupSectionToggle('genToggle', 'genWrap', 'genToggleIcon');


// Isi Generator & Kombinasi Acak pakai varian Formula X yang dipilih (radio) tiap posisi.
// silent=true (dipanggil otomatis dari computeFormulaX/radio) -> tidak tampilkan alert kalau belum siap, cukup diam saja.
function fxApplyToGenerator(silent){
  // Kalau Gen 1 sedang terkunci (baik lewat tombol LOCK GEN 1 maupun lewat Semi Auto),
  // pakai pool yang terkunci itu — jangan hitung ulang dari Formula X yang sedang aktif.
  if(fxGen1Locked && fxGen1LockedPools){
    lastTop8Pools = fxGen1LockedPools;
    document.getElementById('bulkOut').value = fxGen1LockedPools.map(p => p.join('')).join('.');
    generateCombineOutput();
    if(document.getElementById('filterCard').style.display === 'block') resetFilters();
    return;
  }

  // Gen 1 TIDAK terkunci dan fungsi ini mau menghitung/menimpa pool dari Formula X yang aktif
  // (dipicu: ganti periode/pasaran lewat analyze(), pilih radio/baris tabel sendiri, atau
  // tombol Streak%/Auto%/Posisi%) — daftar hasil Status Streak yang lama (kalau ada) sudah
  // tidak relevan lagi, bersihkan dulu.
  if(typeof fxClearStreakGen1List === 'function') fxClearStreakGen1List();

  if(!FX_FORMULAS_CACHE || !lastPosLabels || !lastHistoryNumbers.length){
    if(!silent) alert('Hitung Formula X dulu (isi Data Historis lalu Hitung Frekuensi).');
    return;
  }
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });

  let pools;
  try{
    pools = lastPosLabels.map((label, idx) => {
      const f = formulaByKey[fxSelectedKey(label)];
      if(!f) return [];
      const allPools = f.fn(lastHistoryNumbers); // lastHistoryNumbers sudah newest-first
      return allPools[idx] || [];
    });
  } catch(e){
    if(!silent) alert('Tiap posisi (' + lastPosLabels.join('/') + ') harus punya varian Formula X yang valid — coba Hitung Ulang.');
    return;
  }

  if(pools.some(p => !p.length)){
    if(!silent) alert('Tiap posisi (' + lastPosLabels.join('/') + ') harus punya varian Formula X yang valid — coba Hitung Ulang.');
    return;
  }

  lastTop8Pools = pools;
  document.getElementById('bulkOut').value = pools.map(p => p.join('')).join('.');
  generateCombineOutput();
  if(document.getElementById('filterCard').style.display === 'block') resetFilters();
}
document.getElementById('fxApplyBtn').addEventListener('click', () => fxApplyToGenerator(false));

// Isi Generator & Kombinasi Acak pakai radio Kuat/Sedang yang dipilih di Top Posisi tiap posisi
function applyTopPosisiToGenerator(){
  if(!FX_FORMULAS_CACHE || !lastPosLabels || !lastHistoryNumbers.length){
    alert('Hitung Formula X dulu (isi Data Historis lalu Hitung Frekuensi).');
    return;
  }

  const pools = lastPosLabels.map((label, idx) => {
    const { kuat, sedang } = computeTopPosisiDigits(label, idx, lastHistoryNumbers);
    const pilihan = TOP_POSISI_SELECTED[label] || 'kuat';
    return pilihan === 'sedang' ? sedang : kuat;
  });

  if(pools.some(p => !p.length)){
    alert('Tiap posisi (' + lastPosLabels.join('/') + ') harus punya digit Top Posisi (Kuat/Sedang) yang valid — coba Hitung Ulang.');
    return;
  }

  lastTop8Pools = pools;
  document.getElementById('bulkOut').value = pools.map(p => p.join('')).join('.');
  generateCombineOutput();
  if(document.getElementById('filterCard').style.display === 'block') resetFilters();
}
document.getElementById('topPosApplyBtn').addEventListener('click', applyTopPosisiToGenerator);
document.getElementById('fxRecalcBtn').addEventListener('click', () => {
  fxRefreshHistoryIfTerbaru();
  const _mode = (typeof getAppMode === 'function') ? getAppMode() : 'normal';
  if(_mode === 'auto' || _mode === 'semi'){
    // Mode Auto/Semi: Preset yang pegang kendali PENUH atas semua pengaturan (Top Posisi,
    // pilihan Formula X per posisi, dst — lihat presetApplyExtraNow yang dipasang ulang lewat
    // hook MutationObserver #fxStatus di automode.js). Tombol ini di sini HANYA bertugas
    // merefresh sumber data (tabel Histori terbaru via fxRefreshHistoryIfTerbaru di atas) supaya
    // semua sistem yang butuh data segar (Formula X, Generator, Filter) ikut kebaca — BUKAN
    // mereset pengaturan. Makanya TIDAK ada TOP_POSISI_SELECTED={} di cabang ini: itu urusan
    // preset, bukan tombol ini.
    if(lastHistoryNumbers.length && lastPosLabels) computeFormulaX(lastHistoryNumbers, lastPosLabels);
    // computeFormulaX() di atas sudah otomatis mengarahkan tiap radio Formula X (fxpos_) ke
    // varian dengan PERSENTASE TERTINGGI dulu sebagai default; preset (lewat hook di atas) baru
    // menimpanya lagi SETELAH ini kalau memang punya pilihan tersimpan yang masih valid untuk
    // posisi itu — itu yang dimaksud "kendali penuh oleh preset", bukan menghalangi default ini.
    if(typeof runAutoPipelineAfterFormulaX === 'function') runAutoPipelineAfterFormulaX();
  } else {
    // Mode Normal: tidak ada preset yang mengendalikan, jadi Top Posisi (Kuat/Sedang) perlu
    // dikosongkan manual di sini supaya balik ke default "Kuat" — computeFormulaX() tidak
    // pernah menyentuh TOP_POSISI_SELECTED sama sekali.
    TOP_POSISI_SELECTED = {};
    if(lastHistoryNumbers.length && lastPosLabels) computeFormulaX(lastHistoryNumbers, lastPosLabels);
  }
});


function analyze(){
  // ── Aturan tetap: ganti pasaran/periode (analyze() ini selalu dipanggil ulang tiap kali
  // Data Historis/Periode berubah) -> daftar hasil Status Streak (fxStreakGen1List) SELALU
  // dibersihkan, tanpa syarat status lock Gen 1. Taruh paling atas supaya pasti kena walau
  // nanti di bawah ada jalur early-return lain. ──
  if(typeof fxClearStreakGen1List === 'function') fxClearStreakGen1List();

  const raw = document.getElementById('dataInput').value;
  const parsedWithMonth = parseDataWithMonth(raw);
  const tokens = parsedWithMonth.tokens;
  const targetLen = pickTargetLength(tokens);
  const used = [];
  const usedMonths = [];
  tokens.forEach((t, i) => {
    if(t.length === targetLen){ used.push(t); usedMonths.push(parsedWithMonth.months[i]); }
  });
  const skipped = tokens.length - used.length;

  document.getElementById('totalCount').textContent = used.length;
  document.getElementById('skippedCount').textContent = skipped;

  if(used.length === 0){
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('jsCard').style.display = 'none';
    document.getElementById('bulkCard').style.display = 'none';
    document.getElementById('filterCard').style.display = 'none';
    lastPosLabels = null;
    lastTop8Pools = [];
    lastHistoryNumbers = [];
    FX_RECOMMENDATIONS = null;
    FX_SELECTED = {};
    FX_TOUCHED = {};
    FX_FORMULAS_CACHE = null;
    TOP_POSISI_SELECTED = {};
    document.getElementById('fxCols').innerHTML = '';
    document.getElementById('fxTrendCols').innerHTML = '';
    document.getElementById('topPosisiCols').innerHTML = '';
    document.getElementById('fxKpiBox').innerHTML = '';
    document.getElementById('fxTableHead').innerHTML = '';
    document.getElementById('fxTableBody').innerHTML = '';
    document.getElementById('fxStatus').textContent = '';
    jsTopValues = { jumlah: [], selisih: [] };
    jsCtReference = { jumlah: null, selisih: null };
    lastJsUsed = null;
    document.getElementById('jsTableBody').innerHTML = '';
    document.getElementById('jsCtRef').innerHTML = '';
    document.getElementById('simpulanJS').innerHTML = '';
    ctReference = { AC: null, CK: null, KE: null };
    document.getElementById('cbAiTableBody').innerHTML = '';
    document.getElementById('cbCtRef').innerHTML = '';
    document.getElementById('cbMonthAi').innerHTML = '';
    document.getElementById('cbMonthTitle').textContent = 'Ai Bulan Ini';
    document.getElementById('cbMonthHistorySelect').innerHTML = '<option value="">— pilih bulan —</option>';
    document.getElementById('cbMonthHistoryRef').innerHTML = '';
    shioCtReference = null;
    document.getElementById('shioAiTableBody').innerHTML = '';
    document.getElementById('shioCtRef').innerHTML = '';
    return;
  }

  const posLabels = targetLen === 4
    ? ['A','C','K','E']
    : targetLen === 3
      ? ['C','K','E']
      : ['K','E'];

  lastPosLabels = posLabels;
  lastHistoryNumbers = used; // newest-first, dipakai Formula X & filter "buang yang sudah keluar"

  document.getElementById('resultCard').style.display = 'block';
  computeFormulaX(used, posLabels);

  renderJumlahSelisih(used);
  renderAngkaIkut4D(used, targetLen, usedMonths);
  renderShioAnalysis(used, targetLen);

  document.getElementById('bulkCard').style.display = 'block';

  document.getElementById('filterCard').style.display = 'block';
  renderTwinMurniCheckboxes(targetLen);

  // Kalau Mode Auto/Semi Auto sedang aktif, setiap kali Periode/Data Historis diproses ulang
  // (fungsi analyze() ini), langsung lanjutkan sisa alurnya (Auto Generate → ... → Terapkan
  // Filter) TANPA perlu klik tombol Auto lagi — jadi kontrol berikutnya benar-benar dari
  // Periode. computeFormulaX sudah dipanggil di atas, jadi lewati ulang bagian itu.
  if(typeof getAppMode === 'function'){
    const _mode = getAppMode();
    if(_mode === 'auto' || _mode === 'semi'){
      // Sengaja tidak di-await: fungsi ini sekarang async (retry Gen 2 sampai 3x sebelum
      // Auto Generate jalan). analyze() tidak perlu menunggu; sisa alur (Auto Generate →
      // Filter) jalan sendiri di background, termasuk alert reload kalau retry gagal.
      runAutoPipelineAfterFormulaX();
    }
  }
}

let jsTopValues = { jumlah: [], selisih: [] }; // Jumlah & Selisih prediksi baris teratas (Wait) -> dipakai tombol "Pakai ... di Filter"
let jsCtReference = { jumlah: null, selisih: null }; // sama seperti jsTopValues tapi format string gabungan (buat label tombol prediksi)
let lastJsUsed = null; // data historis terakhir dipakai render Jumlah & Selisih (buat re-render saat dropdown/manual diganti)

// Dari 1 pasangan digit (mis. AC="88") -> Jumlah = (d1+d2) mod 10, Selisih = |d1-d2|
function jumlahSelisihDariPasangan(pairStr){
  const d = pairStr.split('').map(Number);
  return { jumlah: (d[0] + d[1]) % 10, selisih: Math.abs(d[0] - d[1]) };
}

// Pecah 1 angka 4D jadi AC/CK/KE dulu (pakai bagianOf4D yang sudah ada), baru tiap pasangan
// dihitung Jumlah & Selisih-nya masing-masing -> hasilnya 3 nilai Jumlah & 3 nilai Selisih per angka.
function jumlahSelisihList(num){
  const bagian = bagianOf4D(num);
  const jumlahList = [], selisihList = [];
  ['AC', 'CK', 'KE'].forEach(k => {
    const { jumlah, selisih } = jumlahSelisihDariPasangan(bagian[k]);
    jumlahList.push(jumlah);
    selisihList.push(selisih);
  });
  return { jumlahList, selisihList };
}

// Kombinasi `digitCount` digit dengan CAKUPAN (cover) paling tinggi ke daftar `rows[key]` — logika sama
// persis dengan bestCoverAiPart di Analisis Angka Ikut 4D (Exact Minimum Hitting Set, brute-force C(10,digitCount)
// kombinasi dicoba semua, dijamin optimal). Tie-break: total frekuensi digit gabungan lebih tinggi menang.
function bestCoverJsPart(rows, key, digitCount){
  const totalFreq = new Array(10).fill(0);
  rows.forEach(r => r[key].forEach(v => totalFreq[v]++));
  const combos = digitCount === 5 ? AI_COMBOS_5 : combinationsOfDigits(digitCount);
  let best = null;
  combos.forEach(combo => {
    let hits = 0;
    rows.forEach(r => { if(r[key].some(v => combo.includes(v))) hits++; });
    const freqSum = combo.reduce((s, d) => s + totalFreq[d], 0);
    if(!best || hits > best.hits || (hits === best.hits && freqSum > best.freqSum)){
      best = { combo, hits, freqSum };
    }
  });
  return best.combo.slice().sort((a, b) => a - b);
}

function renderJumlahSelisih(used){
  lastJsUsed = used;
  const tbody = document.getElementById('jsTableBody');
  const ctBox = document.getElementById('jsCtRef');

  const ROWS_SHOWN = parseInt(document.getElementById('jsRowsShown').value, 10) || 15;
  const NJumlah = parseInt(document.getElementById('jsRecoCountJumlah').value, 10) || 5;
  const NSelisih = parseInt(document.getElementById('jsRecoCountSelisih').value, 10) || 5;

  const rows = used.map(num => {
    const { jumlahList, selisihList } = jumlahSelisihList(num);
    return { num, jumlahList, selisihList };
  });

  // Manual: kalau diisi minimal 1 digit, dipakai TETAP untuk SEMUA baris (menggantikan hitungan otomatis per baris) — sama seperti Ai manual AC/CK/KE.
  const manualDigitsFor = (id) => {
    const raw = document.getElementById(id).value.replace(/\D/g, '').slice(0, 10);
    if(raw.length < 1) return null;
    return [...new Set(raw.split('').map(ch => parseInt(ch, 10)))].sort((a, b) => a - b);
  };
  const manualJumlah = manualDigitsFor('jsJumlahManual');
  const manualSelisih = manualDigitsFor('jsSelisihManual');

  // Rekomendasi per baris: window sendiri (baris ini + N-1 sebelumnya), sesuai dropdown Jumlah Baris Tabel — persis Angka Ikut 4D.
  const maxT = Math.min(ROWS_SHOWN, used.length - ROWS_SHOWN + 1);
  let row0 = null;
  let hitCount = 0, totalChecked = 0;

  if(maxT < 1){
    tbody.innerHTML = `<tr><td colspan="4" class="emptynote">Data belum cukup untuk menghitung Jumlah & Selisih per baris (butuh minimal ${ROWS_SHOWN} data sesuai dropdown Jumlah Baris Tabel).</td></tr>`;
  }else{
    const rowsHtml = [];
    for(let t = 0; t < maxT; t++){
      const subN = rows.slice(t, t + ROWS_SHOWN);
      const jumlahOrdered = manualJumlah || bestCoverJsPart(subN, 'jumlahList', NJumlah);
      const selisihOrdered = manualSelisih || bestCoverJsPart(subN, 'selisihList', NSelisih);
      if(t === 0) row0 = { jumlah: jumlahOrdered, selisih: selisihOrdered };

      let statusHtml, rowClass, nextActual = null;
      if(t === 0){
        statusHtml = `<span class="statusBadge wait">Wait</span>`;
        rowClass = 'waitRow';
      }else{
        nextActual = jumlahSelisihList(used[t - 1]); // data setelahnya (lebih baru) = target yang diprediksi baris ini
        const jumlahOk = jumlahOrdered.some(d => nextActual.jumlahList.includes(d));
        const selisihOk = selisihOrdered.some(d => nextActual.selisihList.includes(d));
        const ok = jumlahOk && selisihOk;
        statusHtml = ok ? `<span class="statusBadge o">O</span>` : `<span class="statusBadge x">X</span>`;
        rowClass = ok ? 'fullMatch' : 'noMatch';
        totalChecked++;
        if(ok) hitCount++;
      }
      const jumlahCell = jumlahOrdered.map(d => (nextActual && nextActual.jumlahList.includes(d)) ? `<span class="aiHitDigit">${d}</span>` : d).join('');
      const selisihCell = selisihOrdered.map(d => (nextActual && nextActual.selisihList.includes(d)) ? `<span class="aiHitDigit">${d}</span>` : d).join('');
      rowsHtml.push(`<tr class="${rowClass}"><td>${used[t]}</td><td class="numCell">${jumlahCell}</td><td class="numCell">${selisihCell}</td><td>${statusHtml}</td></tr>`);
    }
    tbody.innerHTML = rowsHtml.join('');
  }

  // Jumlah & Selisih prediksi draw berikutnya = rekomendasi baris teratas (Wait) di tabel
  if(row0){
    jsTopValues = { jumlah: row0.jumlah.map(String), selisih: row0.selisih.map(String) };
    jsCtReference = { jumlah: row0.jumlah.join(''), selisih: row0.selisih.join('') };
    ctBox.innerHTML = `
      <button class="btn aiPredBtn" onclick="pakaiJsPrediksi('jumlah')">JUMLAH ${jsCtReference.jumlah}</button>
      <button class="btn aiPredBtn" onclick="pakaiJsPrediksi('selisih')">SELISIH ${jsCtReference.selisih}</button>`;
  }else{
    jsTopValues = { jumlah: [], selisih: [] };
    jsCtReference = { jumlah: null, selisih: null };
    ctBox.innerHTML = '';
  }

  const pct = totalChecked ? (hitCount / totalChecked * 100).toFixed(1) : '0.0';
  document.getElementById('simpulanJS').innerHTML =
    `Status O: <b style="color:var(--teal);">${hitCount}</b> / ${totalChecked} baris teruji (<b style="color:var(--teal);">${pct}%</b>). `
    + `Window per baris: <b style="color:var(--ink);">${ROWS_SHOWN} data</b> · Jumlah digit rekomendasi — Jumlah: <b style="color:var(--ink);">${NJumlah}</b>, Selisih: <b style="color:var(--ink);">${NSelisih}</b>.`;

  document.getElementById('jsCard').style.display = 'block';
}

// tombol Jumlah/Selisih Prediksi -> langsung isi filter terkait (sama seperti pakaiAiPrediksi di Angka Ikut 4D)
function pakaiJsPrediksi(kind){
  if(!jsCtReference[kind]) return;
  if(kind === 'jumlah') document.getElementById('filterJumlah').value = jsTopValues.jumlah.join(',');
  else if(kind === 'selisih') document.getElementById('filterSelisih').value = jsTopValues.selisih.join(',');
  if(lastTop8Pools.length) applyFilters();
}

// ganti dropdown "Jumlah Baris Tabel" / "Jumlah Rekomendasi" -> render ulang tabel pakai data yang sama, tanpa hitung ulang seluruh analisis
document.getElementById('jsRowsShown').addEventListener('change', () => {
  if(lastJsUsed) renderJumlahSelisih(lastJsUsed);
});
document.getElementById('jsRecoCountJumlah').addEventListener('change', () => {
  if(lastJsUsed) renderJumlahSelisih(lastJsUsed);
});
document.getElementById('jsRecoCountSelisih').addEventListener('change', () => {
  if(lastJsUsed) renderJumlahSelisih(lastJsUsed);
});

// textbox Jumlah/Selisih manual: hanya terima digit, maksimal 10 karakter, otomatis refresh tabel tiap kali diketik
['jsJumlahManual', 'jsSelisihManual'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const cleaned = e.target.value.replace(/\D/g, '').slice(0, 10);
    if(cleaned !== e.target.value) e.target.value = cleaned;
    if(lastJsUsed) renderJumlahSelisih(lastJsUsed);
  });
});

// tombol "Cari (cover data)": hitung digit dengan cakupan PALING TINGGI ke N data teratas (N = dropdown
// Jumlah Baris Tabel), lalu isi ke kotak manual (otomatis dipakai sama untuk SEMUA baris tabel) — persis logika cariAiCoverPart.
function cariJsCoverPart(key, manualInputId){
  if(!lastJsUsed || !lastJsUsed.length) return;
  const rowsShown = parseInt(document.getElementById('jsRowsShown').value, 10) || 15;
  const nFieldId = (key === 'jumlahList') ? 'jsRecoCountJumlah' : 'jsRecoCountSelisih';
  const n = parseInt(document.getElementById(nFieldId).value, 10) || 5;
  const subset = lastJsUsed.slice(0, Math.min(rowsShown, lastJsUsed.length)).map(num => {
    const { jumlahList, selisihList } = jumlahSelisihList(num);
    return { jumlahList, selisihList };
  });
  const best = bestCoverJsPart(subset, key, n);
  document.getElementById(manualInputId).value = best.join('');
  renderJumlahSelisih(lastJsUsed);

  // Langsung distribusikan hasil cover ke filter kombinasi (Jumlah/Selisih pakai format dipisah koma).
  const filterId = (key === 'jumlahList') ? 'filterJumlah' : 'filterSelisih';
  document.getElementById(filterId).value = best.join(',');
  if(lastTop8Pools.length) applyFilters();
}
document.getElementById('cariJumlahBtn').addEventListener('click', () => cariJsCoverPart('jumlahList', 'jsJumlahManual'));
document.getElementById('cariSelisihBtn').addEventListener('click', () => cariJsCoverPart('selisihList', 'jsSelisihManual'));

// ---------- Analisis Angka Ikut 4D (Ai per bagian AC/CK/KE) ----------
let ctReference = { AC: null, CK: null, KE: null }; // Ai prediksi draw berikutnya (baris teratas tabel)
let lastAiUsed = null; // data historis terakhir dipakai render tabel Ai (buat re-render saat kontrol diganti)
let lastAiTargetLen = null;
let lastAiUsedMonths = null; // bulan (YYYY-MM) sejajar index dengan lastAiUsed, buat fitur Ai Bulanan
let lastAiBulananDB = {}; // cache database Ai bulanan (localStorage), dipakai dropdown referensi

// jumlah digit Ai per bagian — dibaca dari dropdown "Jumlah Output Ai" (pilihan 2-7), default 5 kalau belum ada/rusak
function getAiDigitCount(){
  const el = document.getElementById('aiDigitCount');
  const v = el ? parseInt(el.value, 10) : NaN;
  return (Number.isInteger(v) && v >= 2 && v <= 7) ? v : 5;
}
const AI_MONTH_THRESHOLD = 0.70; // Ai bulanan diganti kalau cakupannya ke data bulan berjalan turun di bawah ini

// Radio "Sumber Data" (Ai Ai) — persis pola fxRefreshHistoryIfTerbaru di Formula X:
// - Data Default = baca ULANG kotak Data Historis (#dataInput), sesuai pasaran/periode yang
//   sedang aktif di kotak itu (sama seperti analyze()).
// - Data Terbaru = ambil dari tabel Histori All Periode (allPeriodeHistoryList, historyall.js —
//   gabungan SEMUA pasaran dari Firebase, terbaru di index 0), dipakai apa adanya tanpa
//   difilter ke pasaran yang aktif.
// Menimpa lastAiUsed/lastAiTargetLen/lastAiUsedMonths lalu render ulang tabel Ai Ai.
function aiRefreshHistoryIfTerbaru(){
  const statusEl = document.getElementById('aiDataSourceStatus');
  const useTerbaru = (document.querySelector('input[name="aiDataSource"]:checked') || {}).value === 'terbaru';
  let tokens, months;
  if(useTerbaru){
    const rows = (typeof allPeriodeHistoryList !== 'undefined' && Array.isArray(allPeriodeHistoryList)) ? allPeriodeHistoryList : [];
    tokens = rows.map(r => String((r && r.nomor) || '').replace(/[^0-9]/g, '')).filter(Boolean);
    months = rows.map(r => extractMonthKey(String((r && r.tanggal) || '')));
  } else {
    const raw = document.getElementById('dataInput').value;
    const parsed = parseDataWithMonth(raw);
    tokens = parsed.tokens;
    months = parsed.months;
  }
  if(!tokens.length){
    if(statusEl) statusEl.textContent = useTerbaru
      ? '⚠️ Tabel Histori All Periode masih kosong, pakai data sebelumnya.'
      : '⚠️ Kotak Data Historis kosong/tidak terbaca, pakai data sebelumnya.';
    return; // sumbernya kosong/tidak valid — biarkan snapshot lama, jangan ditimpa
  }
  const targetLen = pickTargetLength(tokens);
  const used = [], usedMonths = [];
  tokens.forEach((t, i) => {
    if(t.length === targetLen){ used.push(t); usedMonths.push(months[i] || null); }
  });
  if(!used.length) return;
  renderAngkaIkut4D(used, targetLen, usedMonths);
  if(statusEl) statusEl.textContent = useTerbaru
    ? `📡 Data Terbaru (Histori All Periode, semua pasaran) — ${used.length} angka.`
    : `📄 Data Default (Data Historis) — ${used.length} angka.`;
}

// Klik radio langsung memicu refresh (tidak perlu klik tombol lain).
document.querySelectorAll('input[name="aiDataSource"]').forEach(radio => {
  radio.addEventListener('change', aiRefreshHistoryIfTerbaru);
});

function bagianOf4D(num){
  return { AC: num.slice(0, 2), CK: num.slice(1, 3), KE: num.slice(2, 4) };
}

// digit-count per bagian (AC/CK/KE) dari daftar angka `subUsed` — twin (pasangan digit sama, mis. "44") dihitung 1x saja
function countDigitsAiPart(subUsed, partKey){
  const counts = new Array(10).fill(0);
  subUsed.forEach(num => {
    const pair = bagianOf4D(num)[partKey];
    if(pair[0] === pair[1]){
      counts[parseInt(pair[0], 10)]++; // twin -> 1x
    }else{
      counts[parseInt(pair[0], 10)]++;
      counts[parseInt(pair[1], 10)]++;
    }
  });
  return counts;
}

// Ai per bagian, algoritma "Exact Minimum Hitting Set" (brute-force): karena cuma ada C(10,5) = 252
// kombinasi 5-digit dari 10 digit yang mungkin, semua kombinasi dicoba dan dipilih yang cakupannya
// PALING TINGGI ke pasangan (AC/CK/KE) di window data itu — dijamin optimal (bukan sekadar pendekatan
// greedy), dan tetap murah dihitung. Kalau ada beberapa kombinasi dengan cakupan sama, menang yang total
// frekuensi digitnya lebih tinggi (tie-break).
const AI_ALL_DIGITS = [0,1,2,3,4,5,6,7,8,9];
functio
