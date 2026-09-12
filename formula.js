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
let FX_SELECTED = {};          // posLabel -> key varian yang dipilih (radio)
let FX_TOUCHED = {};           // posLabel -> true kalau radio pernah digeser MANUAL oleh user (dipakai Gen 2 untuk tahu beda
                                // antara "masih default" vs "sudah dipilih sendiri") — direset tiap computeFormulaX()/ganti data.
let TOP_POSISI_SELECTED = {};  // posLabel -> 'kuat' | 'sedang' (radio Top Posisi)
let FX_FORMULAS_CACHE = null;  // { formulas, controlN } — daftar formula terakhir dipakai computeFormulaX(), dipakai ulang oleh fxApplyToGenerator()
let FX_OUT_N = 8;              // OUT= jumlah digit kandidat per pool (dulu tetap 8, sekarang bisa 4-9 lewat dropdown #fxOutN)
let FX_HISTORY_DATA = [];      // array [{nomor, periode, tanggal}, ...] — data lengkap dengan periode untuk tabel backtest

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
const FX_N_CANDIDATES = [3, 5, 7, 10, 15, 20, 30, 50, 100];

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

// Walk-forward: uji akurasi dari BEBERAPA titik potong mundur (bukan cuma dari data terakhir),
// lalu gabungkan hasilnya — supaya tidak "beruntung" cuma cocok di beberapa data terakhir saja.
function fxTrendAccuracyWalkForward(formula, chronoNum, controlN, trendN, posIdx, folds){
  const step = Math.max(1, Math.floor((trendN === Infinity ? 10 : trendN) / 2));
  let totalHit = 0, totalCount = 0, foldsUsed = 0;
  for(let f = 0; f < folds; f++){
    const trimEnd = chronoNum.length - f * step;
    if(trimEnd < 2) break;
    const slice = chronoNum.slice(0, trimEnd);
    const r = fxTrendAccuracy(formula, slice, controlN, trendN, posIdx);
    if(r.total > 0){ totalHit += r.hit; totalCount += r.total; foldsUsed++; }
  }
  return { hit: totalHit, total: totalCount, pct: totalCount > 0 ? (totalHit / totalCount * 100) : 0, folds: foldsUsed };
}

// Jalankan pencarian kandidat (controlN x trendN), skor tiap pasangan pakai fungsi `scoreFn`,
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

// Ensemble/voting: tiap formula & posisi "memilih" pasangan N terbaiknya sendiri (akurasi mentah tertinggi),
// lalu pasangan yang paling sering menang (voting terbanyak) yang dipakai.
function fxSearchBestNEnsemble(used, posLabels){
  const chronoNum = used.slice().reverse();
  const votes = {};
  posLabels.forEach((label, idx) => {
    FX_N_CANDIDATES.forEach(controlN => {
      const formulas = fxBuildFormulaList(posLabels, controlN);
      formulas.forEach(f => {
        let bestPair = null, bestPct = -1;
        FX_N_CANDIDATES.forEach(trendN => {
          const r = fxTrendAccuracy(f, chronoNum, controlN, trendN, idx);
          if(r.total > 0 && r.pct > bestPct){ bestPct = r.pct; bestPair = { controlN, trendN }; }
        });
        if(bestPair){
          const key = bestPair.controlN + '_' + bestPair.trendN;
          votes[key] = (votes[key] || 0) + 1;
        }
      });
    });
  });
  let bestKey = null, bestVotes = -1;
  Object.keys(votes).forEach(key => { if(votes[key] > bestVotes){ bestVotes = votes[key]; bestKey = key; } });
  if(!bestKey) return null;
  const [controlN, trendN] = bestKey.split('_').map(Number);
  return { controlN, trendN, votes: bestVotes };
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
    document.getElementById('fxOptEnsembleBtn'),
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

document.getElementById('fxOptWilsonBtn').addEventListener('click', () => {
  fxRefreshHistoryIfTerbaru();
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  fxRunOptimizer('Wilson Score', () => {
    const best = fxSearchBestN(lastHistoryNumbers, lastPosLabels, fxTrendAccuracy);
    fxApplyOptimizedN(best, 'Wilson Score');
  });
});

document.getElementById('fxOptWalkBtn').addEventListener('click', () => {
  fxRefreshHistoryIfTerbaru();
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  fxRunOptimizer('Walk-Forward', () => {
    const best = fxSearchBestN(lastHistoryNumbers, lastPosLabels, (f, chrono, cN, tN, idx) => fxTrendAccuracyWalkForward(f, chrono, cN, tN, idx, 5));
    fxApplyOptimizedN(best, 'Walk-Forward');
  });
});

document.getElementById('fxOptEnsembleBtn').addEventListener('click', () => {
  fxRefreshHistoryIfTerbaru();
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  fxRunOptimizer('Ensemble', () => {
    const best = fxSearchBestNEnsemble(lastHistoryNumbers, lastPosLabels);
    fxApplyOptimizedN(best, 'Ensemble');
  });
});

function computeFormulaX(used, posLabels){
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

  // Selalu arahkan pilihan (radio) ke varian dengan akurasi tertinggi tiap kali dihitung ulang / dioptimalkan
  // (Hitung Ulang, Pilih N Wilson, Pilih N Walk-Forward, Pilih N Ensemble) — tidak mempertahankan pilihan lama.
  posLabels.forEach(label => {
    FX_SELECTED[label] = recs[label][0] ? recs[label][0].key : null;
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
      radio.checked = (opt.key === FX_SELECTED[label]);
      radio.addEventListener('change', () => {
        FX_SELECTED[label] = opt.key;
        FX_TOUCHED[label] = true; // tandai posisi ini sudah dipilih manual -> Gen 2 ikut radio mulai sekarang
        renderFxTrendNumbers(posLabels, lastHistoryNumbers);
        renderFxBacktestTable(posLabels, lastHistoryNumbers);
        fxApplyToGenerator(true);
        // Refresh live preview Gen 1 & Gen 2 (yang belum dikunci) supaya ikut berubah
        // sesuai varian yang baru dipilih — sebelumnya panel ini tidak pernah diminta
        // render ulang saat radio Formula X diganti.
        if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
        if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
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
function renderFxTrendNumbers(posLabels, used){
  const grid = document.getElementById('fxTrendCols');
  if(!FX_RECOMMENDATIONS || !FX_FORMULAS_CACHE){ grid.innerHTML = ''; return; }
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
    const selectedKey = FX_SELECTED[label];
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
  const selFn = posLabels.map(label => formulaByKey[FX_SELECTED[label]]);

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

  if(!FX_FORMULAS_CACHE || !lastPosLabels || !lastHistoryNumbers.length){
    if(!silent) alert('Hitung Formula X dulu (isi Data Historis lalu Hitung Frekuensi).');
    return;
  }
  const formulaByKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { formulaByKey[f.key] = f; });

  let pools;
  try{
    pools = lastPosLabels.map((label, idx) => {
      const f = formulaByKey[FX_SELECTED[label]];
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
  if(lastHistoryNumbers.length && lastPosLabels) computeFormulaX(lastHistoryNumbers, lastPosLabels);
});


function analyze(){
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
function combinationsOfDigits(k){
  const result = [];
  function helper(start, combo){
    if(combo.length === k){ result.push(combo.slice()); return; }
    for(let i = start; i < AI_ALL_DIGITS.length; i++){
      combo.push(AI_ALL_DIGITS[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return result;
}
const AI_COMBOS_5 = combinationsOfDigits(5); // dihitung sekali saja, dipakai ulang tiap panggilan

function bestCoverAiPart(subUsed, partKey, digitCount){
  const pairs = subUsed.map(num => bagianOf4D(num)[partKey]);
  const totalFreq = countDigitsAiPart(subUsed, partKey);
  const combos = digitCount === 5 ? AI_COMBOS_5 : combinationsOfDigits(digitCount);
  let best = null;
  combos.forEach(combo => {
    let hits = 0;
    pairs.forEach(pair => { if(pair.split('').some(ch => combo.includes(parseInt(ch, 10)))) hits++; });
    const freqSum = combo.reduce((s, d) => s + totalFreq[d], 0);
    if(!best || hits > best.hits || (hits === best.hits && freqSum > best.freqSum)){
      best = { combo, hits, freqSum };
    }
  });
  return best.combo.slice().sort((a, b) => a - b);
}

// persentase data di `subUsed` yang ke-cover minimal 1 digit oleh `aiDigits` (dipakai buat cek ambang 70% Ai bulanan)
function coveragePct(aiDigits, subUsed, partKey){
  if(subUsed.length === 0) return 1;
  const hits = subUsed.filter(num => aiHit(aiDigits, bagianOf4D(num)[partKey])).length;
  return hits / subUsed.length;
}

function aiHit(aiDigits, actualPair){
  return actualPair.split('').some(d => aiDigits.includes(parseInt(d, 10)));
}

// ---------- Ai Bulanan: kunci Ai di awal tiap bulan, pertahankan selama cakupannya >= 70%, simpan tiap ganti bulan ----------
const MONTH_NAMES_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function monthKeyToLabel(key){
  if(!key) return '-';
  const [y, m] = key.split('-');
  return `${MONTH_NAMES_ID[parseInt(m, 10) - 1] || m} ${y}`;
}

function extractMonthKey(str){
  const clean = str.trim().replace(/^\(|\)$/g, ''); // buang kurung pembungkus tanggal, kalau ada — mis. "(24-08-2026)"
  let m = clean.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);        // DD-MM-YYYY
  if(m) return `${m[3]}-${pad2(parseInt(m[2], 10))}`;
  m = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);           // DD/MM/YYYY
  if(m) return `${m[3]}-${pad2(parseInt(m[2], 10))}`;
  m = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);              // YYYY-MM-DD
  if(m) return `${m[1]}-${pad2(parseInt(m[2], 10))}`;
  return null;
}

// sama seperti parseData, tapi juga mengembalikan bulan (YYYY-MM) tiap token dari kolom tanggal (kolom paling kiri)
function parseDataWithMonth(raw){
  const tokens = [];
  const months = []; // sejajar index dengan tokens
  raw.split(/\n+/).forEach(line => {
    const trimmedLine = line.trim();
    if(!trimmedLine) return;
    const cols = trimmedLine.split(/\t+| {2,}/).filter(c => c.trim().length > 0);
    const lastCol = cols.length > 1 ? cols[cols.length - 1] : trimmedLine;
    const monthKey = cols.length > 1 ? extractMonthKey(cols[0]) : null;
    lastCol.split(/[\s,\*]+/).forEach(field => {
      const digitsOnly = field.replace(/[^0-9]/g, '');
      if(digitsOnly.length === 0) return;
      tokens.push(digitsOnly.length > 4 ? digitsOnly.slice(-4) : digitsOnly);
      months.push(monthKey);
    });
  });
  return { tokens, months };
}

const AI_BULANAN_DB_KEY = 'togel_ai_bulanan_v1';
function loadAiBulananDB(){
  try{
    const raw = localStorage.getItem(AI_BULANAN_DB_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch(e){ return {}; }
}
function saveAiBulananDB(db){
  try{ localStorage.setItem(AI_BULANAN_DB_KEY, JSON.stringify(db)); }catch(e){ /* localStorage diblokir — tetap jalan dari cache memori */ }
}

// Simulasi kronologis (lama -> baru) untuk satu bagian (AC/CK/KE): Ai dihitung ulang di awal tiap bulan
// Simulasi kronologis (lama -> baru) untuk satu bagian (AC/CK/KE): Ai dihitung dari N data TERBARU (rolling
// window, sama seperti kontrol "Kontrol Ai AC/CK/KE" di atas tabel) di awal tiap bulan, lalu DIPERTAHANKAN
// selama cakupannya ke data-data bulan berjalan sejak dikunci masih >= threshold; begitu turun di bawah itu,
// Ai dihitung ulang dari N data terbaru saat itu. `finalized` = Ai akhir tiap bulan yang SUDAH LEWAT (siap
// disimpan ke database).
function computeAiBulananPart(used, usedMonths, winSize, partKey, digitCount, threshold){
  const validT = used.length - winSize + 1;
  const finalized = {};
  if(validT < 1 || !usedMonths || !usedMonths.length) return { current: null, finalized };

  let prevMonthKey = null, lockedAi = null, lockedSinceIdx = null, lastCoverage = 1;
  for(let t = validT - 1; t >= 0; t--){ // t menurun = kronologis lama -> baru (index 0 = data terbaru)
    const monthKey = usedMonths[t];
    if(!monthKey) continue;
    if(monthKey !== prevMonthKey){
      if(prevMonthKey !== null){
        finalized[prevMonthKey] = { digits: lockedAi.slice(), coverage: lastCoverage };
      }
      lockedAi = bestCoverAiPart(used.slice(t, t + winSize), partKey, digitCount);
      lockedSinceIdx = t;
      prevMonthKey = monthKey;
      lastCoverage = coveragePct(lockedAi, used.slice(t, lockedSinceIdx + 1), partKey);
    }else{
      const relevant = used.slice(t, lockedSinceIdx + 1); // semua data bulan ini sejak Ai dikunci, termasuk data ini
      const cov = coveragePct(lockedAi, relevant, partKey);
      if(cov < threshold){
        lockedAi = bestCoverAiPart(used.slice(t, t + winSize), partKey, digitCount);
        lockedSinceIdx = t;
        lastCoverage = coveragePct(lockedAi, used.slice(t, lockedSinceIdx + 1), partKey);
      }else{
        lastCoverage = cov;
      }
    }
  }
  const current = prevMonthKey ? { monthKey: prevMonthKey, digits: lockedAi.slice(), coverage: lastCoverage } : null;
  return { current, finalized };
}

function renderMonthRef(){
  const sel = document.getElementById('cbMonthHistorySelect').value;
  const box = document.getElementById('cbMonthHistoryRef');
  if(!sel || !lastAiBulananDB[sel]){ box.innerHTML = ''; return; }
  const entry = lastAiBulananDB[sel];
  const lines = ['AC', 'CK', 'KE']
    .filter(p => entry[p])
    .map(p => `Ai ${p} bulan ${monthKeyToLabel(sel)}: <b style="color:var(--ink);">${entry[p].digits.join('')}</b>`);
  box.innerHTML = lines.join('<br>');
}
document.getElementById('cbMonthHistorySelect').addEventListener('change', renderMonthRef);

function renderAngkaIkut4D(used, targetLen, usedMonths){
  const toggle = document.getElementById('cbToggle');
  const wrap = document.getElementById('cbWrap');
  const tbody = document.getElementById('cbAiTableBody');
  const ctBox = document.getElementById('cbCtRef');

  lastAiUsed = used;
  lastAiTargetLen = targetLen;
  lastAiUsedMonths = usedMonths;

  const monthBox = document.getElementById('cbMonthAi');
  const monthTitle = document.getElementById('cbMonthTitle');
  const monthSelect = document.getElementById('cbMonthHistorySelect');
  const monthRefBox = document.getElementById('cbMonthHistoryRef');

  if(targetLen !== 4){
    toggle.style.display = 'none';
    wrap.style.display = 'none';
    ctReference = { AC: null, CK: null, KE: null };
    tbody.innerHTML = '';
    ctBox.innerHTML = '';
    monthBox.innerHTML = '';
    monthTitle.textContent = 'Ai Bulan Ini';
    monthSelect.innerHTML = '<option value="">— pilih bulan —</option>';
    monthRefBox.innerHTML = '';
    return;
  }
  toggle.style.display = '';

  const ROWS_SHOWN = parseInt(document.getElementById('aiRowsShown').value, 10) || 15; // jumlah baris histori yang ditampilkan (dari dropdown)
  const AI_DIGIT_COUNT = getAiDigitCount(); // jumlah digit Ai per bagian (dari dropdown "Jumlah Output Ai")
  const PARTS = ['AC', 'CK', 'KE'];

  // window kontrol per bagian = sama dengan jumlah baris tabel (dropdown tunggal di atas)
  const winMap = { AC: ROWS_SHOWN, CK: ROWS_SHOWN, KE: ROWS_SHOWN };

  // Ai manual: textbox terpisah. Kalau diisi minimal 4 digit (maksimal 7),
  // digit itu dipakai sebagai Ai TETAP untuk bagian ini di SEMUA baris tabel (menggantikan hitungan otomatis).
  const manualDigitsFor = (part) => {
    const raw = document.getElementById(`aiWin${part}Manual`).value.replace(/\D/g, '').slice(0, 7);
    if(raw.length < 4) return null;
    return [...new Set(raw.split('').map(ch => parseInt(ch, 10)))].sort((a, b) => a - b);
  };
  const manualMap = { AC: manualDigitsFor('AC'), CK: manualDigitsFor('CK'), KE: manualDigitsFor('KE') };
  const maxWin = Math.max(winMap.AC, winMap.CK, winMap.KE);

  // Ai per baris: tiap bagian (AC/CK/KE) pakai window sendiri (baris itu sendiri + N-1 sebelumnya).
  // Status baris dicek terhadap DATA SETELAHNYA (baris yang lebih baru / di atasnya), karena Ai memprediksi draw berikutnya.
  const maxT = Math.min(ROWS_SHOWN, used.length - maxWin + 1);
  let row0Ai = null; // Ai baris teratas (Wait) = prediksi Ai draw berikutnya
  if(maxT < 1){
    tbody.innerHTML = `<tr><td colspan="5" class="emptynote">Data belum cukup untuk menghitung Ai per baris (butuh minimal ${maxWin} data sesuai kontrol yang dipilih).</td></tr>`;
  }else{
    const rowsHtml = [];
    for(let t = 0; t < maxT; t++){
      const aiRow = {};
      PARTS.forEach(p => {
        if(manualMap[p]){
          aiRow[p] = manualMap[p]; // Ai manual aktif -> pakai digit yang diketik user, sama untuk semua baris
        }else{
          const subN = used.slice(t, t + winMap[p]); // baris ini + (N-1) data sebelumnya, sesuai kontrol bagian ini
          aiRow[p] = bestCoverAiPart(subN, p, AI_DIGIT_COUNT);
        }
      });
      if(t === 0) row0Ai = aiRow;

      let statusHtml, rowClass, nextActual = null;
      if(t === 0){
        statusHtml = `<span class="statusBadge wait">Wait</span>`;
        rowClass = 'waitRow';
      }else{
        nextActual = bagianOf4D(used[t - 1]); // data setelahnya (lebih baru, hasil yang diprediksi) = target
        const allHit = PARTS.every(p => aiHit(aiRow[p], nextActual[p]));
        statusHtml = allHit ? `<span class="statusBadge o">O</span>` : `<span class="statusBadge x">X</span>`;
        rowClass = allHit ? 'fullMatch' : 'noMatch';
      }
      // digit Ai yang match ke target (nextActual) ditandai hijau; baris Wait belum punya target jadi tidak ditandai
      const aiCells = PARTS.map(p => {
        const cellHtml = nextActual
          ? aiRow[p].map(d => nextActual[p].includes(String(d)) ? `<span class="aiHitDigit">${d}</span>` : String(d)).join('')
          : aiRow[p].join('');
        return `<td class="numCell">${cellHtml}</td>`;
      }).join('');
      rowsHtml.push(`<tr class="${rowClass}"><td>${used[t]}</td>${aiCells}<td>${statusHtml}</td></tr>`);
    }
    tbody.innerHTML = rowsHtml.join('');
  }

  // Ai prediksi draw berikutnya = Ai baris teratas (Wait) di tabel
  if(row0Ai){
    ctReference = {
      AC: row0Ai.AC.join(''),
      CK: row0Ai.CK.join(''),
      KE: row0Ai.KE.join('')
    };
    ctBox.innerHTML = `
      <button class="btn aiPredBtn" onclick="pakaiAiPrediksi('AC')">AI AC ${ctReference.AC}</button>
      <button class="btn aiPredBtn" onclick="pakaiAiPrediksi('CK')">AI CK ${ctReference.CK}</button>
      <button class="btn aiPredBtn" onclick="pakaiAiPrediksi('KE')">AI KE ${ctReference.KE}</button>`;
  }else{
    ctReference = { AC: null, CK: null, KE: null };
    ctBox.innerHTML = '';
  }

  // ---------- Ai Bulanan ----------
  const aiBulanan = {};
  PARTS.forEach(p => {
    aiBulanan[p] = computeAiBulananPart(used, usedMonths || [], winMap[p], p, AI_DIGIT_COUNT, AI_MONTH_THRESHOLD);
  });

  const db = loadAiBulananDB();
  let dbChanged = false;
  PARTS.forEach(p => {
    Object.keys(aiBulanan[p].finalized).forEach(monthKey => {
      if(!db[monthKey]) db[monthKey] = {};
      db[monthKey][p] = aiBulanan[p].finalized[monthKey];
      dbChanged = true;
    });
  });
  const activeMonthKey = aiBulanan.AC.current ? aiBulanan.AC.current.monthKey : null;
  if(activeMonthKey){
    if(!db[activeMonthKey]) db[activeMonthKey] = {};
    PARTS.forEach(p => {
      if(aiBulanan[p].current) db[activeMonthKey][p] = { digits: aiBulanan[p].current.digits, coverage: aiBulanan[p].current.coverage };
    });
    dbChanged = true;
  }
  if(dbChanged) saveAiBulananDB(db);
  lastAiBulananDB = db;

  if(activeMonthKey){
    monthTitle.textContent = `Ai Bulan Ini · ${monthKeyToLabel(activeMonthKey)}`;
    monthBox.innerHTML = PARTS.map(p => {
      const c = aiBulanan[p].current;
      return `<div class="btn aiPredBtn" style="cursor:default;">AI ${p} ${c ? c.digits.join('') : '-'}</div>`;
    }).join('');
  }else{
    monthTitle.textContent = 'Ai Bulan Ini';
    monthBox.innerHTML = `<p class="emptynote" style="padding:6px 0;">Tanggal tidak terdeteksi di data (butuh kolom tanggal format DD-MM-YYYY) — Ai bulanan belum bisa dihitung.</p>`;
  }

  const monthKeysSorted = Object.keys(db).sort().reverse();
  const prevSelectValue = monthSelect.value;
  monthSelect.innerHTML = '<option value="">— pilih bulan —</option>' +
    monthKeysSorted.map(k => `<option value="${k}">${monthKeyToLabel(k)}</option>`).join('');
  if(monthKeysSorted.includes(prevSelectValue)) monthSelect.value = prevSelectValue;
  renderMonthRef();
}

// ganti kontrol window Ai AC/CK/KE -> render ulang tabel pakai data yang sama, tanpa hitung ulang seluruh analisis
// dropdown "Jumlah Baris Tabel": ganti nilai -> render ulang tabel pakai data yang sama
document.getElementById('aiRowsShown').addEventListener('change', () => {
  if(lastAiUsed) renderAngkaIkut4D(lastAiUsed, lastAiTargetLen, lastAiUsedMonths);
});

// dropdown "Jumlah Output Ai": ganti jumlah digit hasil bestCoverAiPart, otomatis refresh tabel & Ai Bulanan
document.getElementById('aiDigitCount').addEventListener('change', () => {
  if(lastAiUsed) renderAngkaIkut4D(lastAiUsed, lastAiTargetLen, lastAiUsedMonths);
});

// textbox Ai manual AC/CK/KE: hanya terima digit, maksimal 7 karakter, otomatis refresh tabel tiap kali diketik
['aiWinACManual', 'aiWinCKManual', 'aiWinKEManual'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const cleaned = e.target.value.replace(/\D/g, '').slice(0, 7);
    if(cleaned !== e.target.value) e.target.value = cleaned;
    if(lastAiUsed) renderAngkaIkut4D(lastAiUsed, lastAiTargetLen, lastAiUsedMonths);
  });
});

// tombol "Cari Ai (cover data)": hitung 5 digit dengan cakupan PALING TINGGI ke N data teratas (N = dropdown
// Jumlah Baris Tabel), lalu isi ke kotak Ai manual (otomatis dipakai sama untuk SEMUA baris tabel, lewat manualMap yang sudah ada).
function cariAiCoverPart(partKey, manualInputId){
  if(!lastAiUsed || !lastAiUsed.length) return;
  const rowsShown = parseInt(document.getElementById('aiRowsShown').value, 10) || 15;
  const subset = lastAiUsed.slice(0, Math.min(rowsShown, lastAiUsed.length));
  const ai = bestCoverAiPart(subset, partKey, getAiDigitCount());
  document.getElementById(manualInputId).value = ai.join('');
  renderAngkaIkut4D(lastAiUsed, lastAiTargetLen, lastAiUsedMonths);

  // Langsung distribusikan hasil cover ke filter kombinasi (KE ikut pola tombol Ai Prediksi -> filterCB).
  if(partKey === 'AC') document.getElementById('filterAiAC').value = ai.join('');
  else if(partKey === 'CK') document.getElementById('filterAiCK').value = ai.join('');
  else if(partKey === 'KE') document.getElementById('filterCB').value = ai.join('');
  if(lastTop8Pools.length) applyFilters();
}
document.getElementById('cariAiACBtn').addEventListener('click', () => cariAiCoverPart('AC', 'aiWinACManual'));
document.getElementById('cariAiCKBtn').addEventListener('click', () => cariAiCoverPart('CK', 'aiWinCKManual'));
document.getElementById('cariAiKEBtn').addEventListener('click', () => cariAiCoverPart('KE', 'aiWinKEManual'));

// tombol Ai Prediksi (AI AC/CK/KE + digit jadi satu tombol) -> langsung isi filter terkait
function pakaiAiPrediksi(part){
  if(!ctReference[part]) return;
  if(part === 'AC') document.getElementById('filterAiAC').value = ctReference.AC;
  else if(part === 'CK') document.getElementById('filterAiCK').value = ctReference.CK;
  else if(part === 'KE') document.getElementById('filterCB').value = ctReference.KE;
  if(lastTop8Pools.length) applyFilters();
}

// ---------- Analisis Shio 2D 4D (AC/CK/KE -> sisa bagi 12) ----------
let shioTotals = {}; // { '1': totalPct, '2': totalPct, ... } — diisi ulang tiap renderShioAnalysis()

let shioCtReference = null; // Shio rekomendasi prediksi draw berikutnya (baris teratas tabel), mis. "1,4,6,9,12"
let lastShioUsed = null; // data historis terakhir dipakai render tabel Shio (buat re-render saat kontrol diganti)
let lastShioTargetLen = null;

function shioOf12(twoDigitStr){
  const n = parseInt(twoDigitStr, 10);
  const r = n % 12;
  return r === 0 ? 12 : r;
}

function shioOfPart(num, partKey){
  return shioOf12(bagianOf4D(num)[partKey]);
}

// frekuensi kemunculan tiap shio (1-12) dari daftar angka `subUsed`, dihitung dari AC, CK, DAN KE sekaligus digabung
// (tiap angka menyumbang 3 nilai shio ke hitungan) — jadi 1 hasil rekomendasi yang mewakili ketiga bagian.
function countShioGabungan(subUsed){
  const counts = new Array(13).fill(0); // index 1-12 dipakai
  subUsed.forEach(num => {
    counts[shioOfPart(num, 'AC')]++;
    counts[shioOfPart(num, 'CK')]++;
    counts[shioOfPart(num, 'KE')]++;
  });
  return counts;
}

// Kombinasi k shio dari 12 kemungkinan (1-12) — dipakai exact minimum hitting set utk Shio Rekomendasi,
// persis pola combinationsOfDigits/AI_COMBOS_5 di bestCoverAiPart (Analisis Angka Ikut 4D).
const SHIO_ALL_12 = [1,2,3,4,5,6,7,8,9,10,11,12];
function combinationsOfShio(k){
  const result = [];
  function helper(start, combo){
    if(combo.length === k){ result.push(combo.slice()); return; }
    for(let i = start; i < SHIO_ALL_12.length; i++){
      combo.push(SHIO_ALL_12[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return result;
}
const SHIO_COMBOS_CACHE = {}; // cache per pickCount biar kombinasi tidak digenerate ulang tiap panggilan

// Pilih `pickCount` shio dengan CAKUPAN (jumlah data ter-cover) PALING TINGGI di window `subUsed`
// (gabungan AC+CK+KE — 1 data ter-cover kalau salah satu dari AC/CK/KE-nya kena salah satu shio yang dipilih).
// Algoritma "Exact Minimum Hitting Set" (brute-force): semua kombinasi C(12, pickCount) dicoba, dipilih yang
// cakupannya PALING TINGGI — persis logika bestCoverAiPart di Ai Angka Ikut 4D, TIDAK pakai persentase sama
// sekali. Tie-break: kombinasi dengan total frekuensi (gabungan AC+CK+KE) lebih tinggi menang, lalu nomor
// shio lebih kecil.
function bestCoverShioGabungan(subUsed, pickCount){
  const totalFreq = countShioGabungan(subUsed);
  const rowSets = subUsed.map(num => new Set([shioOfPart(num, 'AC'), shioOfPart(num, 'CK'), shioOfPart(num, 'KE')]));
  if(!SHIO_COMBOS_CACHE[pickCount]) SHIO_COMBOS_CACHE[pickCount] = combinationsOfShio(pickCount);
  const combos = SHIO_COMBOS_CACHE[pickCount];
  let best = null;
  combos.forEach(combo => {
    let hits = 0;
    rowSets.forEach(set => { if(combo.some(s => set.has(s))) hits++; });
    const freqSum = combo.reduce((s, d) => s + totalFreq[d], 0);
    if(!best || hits > best.hits || (hits === best.hits && freqSum > best.freqSum)){
      best = { combo, hits, freqSum };
    }
  });
  return best.combo.slice().sort((a, b) => a - b);
}

// parsing kotak "Shio Manual": terima angka dipisah koma/spasi, saring hanya 1-12, dedup, urutkan ascending.
// return null kalau kosong / tidak ada angka valid (artinya: pakai hitungan otomatis per baris).
function parseManualShio(raw){
  const nums = (raw || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
  const valid = [...new Set(nums.filter(n => Number.isInteger(n) && n >= 1 && n <= 12))];
  if(valid.length === 0) return null;
  return valid.sort((a, b) => a - b);
}

function renderShioAnalysis(used, targetLen){
  const shioToggle = document.getElementById('shioToggle');
  const shioWrap = document.getElementById('shioWrap');
  const tbody = document.getElementById('shioAiTableBody');
  const ctBox = document.getElementById('shioCtRef');

  lastShioUsed = used;
  lastShioTargetLen = targetLen;

  if(targetLen !== 4){
    if(shioToggle) shioToggle.style.display = 'none';
    if(shioWrap) shioWrap.style.display = 'none';
    shioTotals = {};
    shioCtReference = null;
    if(tbody) tbody.innerHTML = '';
    if(ctBox) ctBox.innerHTML = '';
    return;
  }
  if(shioToggle) shioToggle.style.display = '';
  // jangan paksa buka shioWrap di sini — biarkan mengikuti state toggle terakhir (klik judul)

  const ROWS_SHOWN = parseInt(document.getElementById('shioRowsShown').value, 10) || 15; // jumlah baris histori yang ditampilkan, sekaligus jadi window (N) per baris
  const pickCount = parseInt(document.getElementById('shioPickCount').value, 10) || 5; // jumlah shio direkomendasikan per baris (dipakai kalau manual kosong)

  // Shio Manual: kalau diisi minimal 1 angka valid (1-12), dipakai sebagai Shio Rekomendasi TETAP di SEMUA baris
  // tabel (menggantikan hitungan otomatis) — sama seperti Ai manual di Angka Ikut 4D.
  const manualPicks = parseManualShio(document.getElementById('shioManual').value);

  // Shio Rekomendasi per baris (baris itu sendiri + N-1 data sebelumnya, N = Jumlah Baris Ditampilkan).
  // Status baris dicek terhadap DATA SETELAHNYA (baris yang lebih baru / di atasnya): SUKSES kalau salah satu
  // dari shio rekomendasi ada di salah satu AC, CK, atau KE draw itu (bukan harus cocok di ketiganya sekaligus).
  const maxT = Math.min(ROWS_SHOWN, used.length - ROWS_SHOWN + 1);
  let row0Picks = null; // Shio Rekomendasi baris teratas (Wait) = prediksi draw berikutnya
  if(maxT < 1){
    tbody.innerHTML = `<tr><td colspan="3" class="emptynote">Data belum cukup untuk menghitung Shio Rekomendasi (butuh minimal ${ROWS_SHOWN} data sesuai Jumlah Baris Ditampilkan yang dipilih).</td></tr>`;
    shioCtReference = null;
    ctBox.innerHTML = '';
  }else{
    const rowsHtml = [];
    for(let t = 0; t < maxT; t++){
      let picks;
      if(manualPicks){
        picks = manualPicks; // Shio manual aktif -> pakai angka yang diketik user, sama untuk semua baris
      }else{
        const subN = used.slice(t, t + ROWS_SHOWN); // baris ini + (N-1) data sebelumnya
        picks = bestCoverShioGabungan(subN, pickCount);
      }
      if(t === 0) row0Picks = picks;

      let statusHtml, rowClass, targetSet = null;
      if(t === 0){
        statusHtml = `<span class="statusBadge wait">Wait</span>`;
        rowClass = 'waitRow';
      }else{
        const target = used[t - 1]; // data setelahnya (lebih baru) = target yang diprediksi
        targetSet = new Set([shioOfPart(target, 'AC'), shioOfPart(target, 'CK'), shioOfPart(target, 'KE')]);
        const sukses = picks.some(s => targetSet.has(s));
        statusHtml = sukses ? `<span class="statusBadge o">Sukses</span>` : `<span class="statusBadge x">Gagal</span>`;
        rowClass = sukses ? 'fullMatch' : 'noMatch';
      }
      // shio rekomendasi yang match ke salah satu AC/CK/KE target ditandai hijau; baris Wait belum punya target
      const picksHtml = targetSet
        ? picks.map(s => targetSet.has(s) ? `<span class="aiHitDigit">${s}</span>` : String(s)).join(', ')
        : picks.join(', ');
      rowsHtml.push(`<tr class="${rowClass}"><td>${used[t]}</td><td class="numCell">${picksHtml}</td><td>${statusHtml}</td></tr>`);
    }
    tbody.innerHTML = rowsHtml.join('');

    // Shio rekomendasi prediksi draw berikutnya = baris teratas (Wait) di tabel
    if(row0Picks){
      shioCtReference = row0Picks.join(', ');
      ctBox.innerHTML = `<div>Shio Rekomendasi <b style="color:var(--amber);">${shioCtReference}</b></div>`;
    }else{
      shioCtReference = null;
      ctBox.innerHTML = '';
    }
  }

  // ---------- shioTotals dihitung diam-diam (dari seluruh data) — dipakai Filter AI Shio 4D di bawah, tidak ditampilkan sebagai tabel ----------
  const countsAC = new Array(13).fill(0);
  const countsCK = new Array(13).fill(0);
  const countsKE = new Array(13).fill(0);
  used.forEach(num => {
    countsAC[shioOf12(num.slice(0,2))]++;
    countsCK[shioOf12(num.slice(1,3))]++;
    countsKE[shioOf12(num.slice(2,4))]++;
  });
  const total = used.length || 1;
  shioTotals = {};
  for(let s = 1; s <= 12; s++){
    shioTotals[String(s)] = (countsAC[s] + countsCK[s] + countsKE[s]) / total * 100;
  }

  document.getElementById('simpulanShio').innerHTML = manualPicks
    ? `Shio Manual aktif: <b style="color:var(--ink);">${manualPicks.join(', ')}</b> dipakai tetap untuk semua baris tabel. Kosongkan kotak Shio Manual untuk kembali ke hitungan otomatis per baris (${ROWS_SHOWN} data terakhir).`
    : `Untuk prediksi draw berikutnya, pakai baris <b>Wait</b> di tabel Shio Rekomendasi di atas — dihitung dari ${ROWS_SHOWN} data terakhir, persis logika Ai Angka Ikut 4D. Status <b>Sukses</b> berarti minimal salah satu dari ${pickCount} shio rekomendasi cocok ke salah satu AC, CK, atau KE draw berikutnya.`;

  updateShioPickNote();
}

// ganti dropdown "Jumlah Baris Ditampilkan" / "Jumlah Shio Rekomendasi" -> render ulang tabel pakai data yang sama
document.getElementById('shioRowsShown').addEventListener('change', () => {
  if(lastShioUsed) renderShioAnalysis(lastShioUsed, lastShioTargetLen);
});
document.getElementById('shioPickCount').addEventListener('change', () => {
  if(lastShioUsed) renderShioAnalysis(lastShioUsed, lastShioTargetLen);
});

// textbox Shio Manual: hanya terima digit, koma, spasi; otomatis refresh tabel tiap kali diketik
document.getElementById('shioManual').addEventListener('input', (e) => {
  const cleaned = e.target.value.replace(/[^0-9,\s]/g, '');
  if(cleaned !== e.target.value) e.target.value = cleaned;
  if(lastShioUsed) renderShioAnalysis(lastShioUsed, lastShioTargetLen);
});

// tombol "🔎 Cari Shio (cover data)": hitung shio dengan cakupan PALING TINGGI dari N data teratas
// (N = dropdown Jumlah Baris Ditampilkan), lalu isi ke kotak Shio Manual (otomatis dipakai sama untuk SEMUA baris tabel).
document.getElementById('cariShioBtn').addEventListener('click', () => {
  if(!lastShioUsed || !lastShioUsed.length) return;
  const rowsShown = parseInt(document.getElementById('shioRowsShown').value, 10) || 15;
  const pickCount = parseInt(document.getElementById('shioPickCount').value, 10) || 5;
  const subset = lastShioUsed.slice(0, Math.min(rowsShown, lastShioUsed.length));
  const picks = bestCoverShioGabungan(subset, pickCount);
  document.getElementById('shioManual').value = picks.join(',');
  renderShioAnalysis(lastShioUsed, lastShioTargetLen);

  // Langsung centang checkbox Shio sesuai hasil cover (checkbox lain ikut di-uncheck).
  const pickSet = new Set(picks);
  document.querySelectorAll('.shioPick').forEach(cb => {
    cb.checked = pickSet.has(parseInt(cb.dataset.shio, 10));
  });
  const shioAllCount = document.querySelectorAll('.shioPick').length;
  const shioCheckedCount = document.querySelectorAll('.shioPick:checked').length;
  document.getElementById('filterShioAll').checked = (shioAllCount === shioCheckedCount && shioAllCount > 0);
  updateShioPickNote();
  if(lastTop8Pools.length) applyFilters();
});

function updateShioPickNote(){
  const checked = [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio);
  const note = document.getElementById('shioPickNote');
  if(checked.length === 0){
    note.textContent = 'Centang salah satu atau lebih shio di atas untuk dipakai sebagai Filter AI Shio 4D. Kombinasi lolos filter kalau salah satu dari AC/CK/KE-nya masuk shio yang dicentang.';
    return;
  }
  const sum = checked.reduce((a, s) => a + (shioTotals[s] || 0), 0);
  const avg = sum / checked.length;
  note.innerHTML = `Shio dicentang: <b style="color:var(--ink);">${checked.map(s => 'Shio '+s).join(', ')}</b> — rata-rata peluang hadir gabungan: <b style="color:var(--teal);">${avg.toFixed(1)}%</b> (dari ${checked.length} shio). Filter AI Shio 4D akan meloloskan kombinasi jika salah satu dari AC/CK/KE-nya cocok ke salah satu shio ini.`;
}

document.querySelectorAll('.shioPick').forEach(cb => {
  cb.addEventListener('change', () => {
    const all = document.querySelectorAll('.shioPick').length;
    const checked = document.querySelectorAll('.shioPick:checked').length;
    document.getElementById('filterShioAll').checked = (all === checked && all > 0);
    updateShioPickNote();
  });
});
document.getElementById('filterShioAll').addEventListener('change', e => {
  document.querySelectorAll('.shioPick').forEach(cb => cb.checked = e.target.checked);
  updateShioPickNote();
});



let lastTop8Pools = []; // array per posisi, tiap elemen array 8 digit teratas — diisi lewat fxApplyToGenerator()
// Dipakai HANYA oleh "Kirim ke Filter" (Auto Generator Formula X): daftar kombinasi JADI (bukan pool per posisi),
// supaya hasil yang sudah dieliminasi Gen 2 tidak dibangun ulang dari pool mentah Gen 1 di Filter.
// Direset (null) tiap kali ada regenerasi pool baru lewat generateCombineOutput()/applyShareState(),
// supaya tidak nyangkut dan bikin Filter memakai data basi.
let filterCustomSource = null;

