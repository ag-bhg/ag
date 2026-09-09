let lastHistoryNumbers = []; // data historis yang dipakai untuk filter "buang yang sudah keluar" (newest-first)
let lastPosLabels = null; // ['A','C','K','E'] dst — dipakai ulang saat Formula X dihitung ulang
let currentLoadedDataName = ''; // nama data tersimpan yang sedang dimuat (diisi lewat tombol Muat) — ditampilkan di Filter Pangkas Kombinasi

// Tampilkan nama data yang sedang dimuat di dekat "Sisa setelah difilter" (Filter Pangkas Kombinasi).
function renderFilterLoadedName(){
  const el = document.getElementById('filterLoadedName');
  if(el) el.textContent = currentLoadedDataName || '–';
}
// ---------- Tabel kode Mistik Lama / Mistik Baru / Index ----------
const DIGIT_MAPS = {
  normal: null,
  mistikLama: {0:1,1:0,2:5,3:8,4:7,5:2,6:9,7:4,8:3,9:6},
  mistikBaru: {0:3,1:7,2:5,3:0,4:9,5:2,6:8,7:1,8:6,9:4},
  index:      {0:5,1:6,2:7,3:8,4:9,5:0,6:1,7:2,8:3,9:4}
};

// ---------- Formula X: state ----------
let FX_RECOMMENDATIONS = null; // { posLabel: [{key,label,source,pct,hit,total}, ...] } terurut dari akurasi tertinggi
let FX_SELECTED = {};          // posLabel -> key varian yang dipilih (radio)
let FX_TOUCHED = {};           // posLabel -> true kalau radio pernah digeser MANUAL oleh user (dipakai Gen 2 untuk tahu beda
                                // antara "masih default" vs "sudah dipilih sendiri") — direset tiap computeFormulaX()/ganti data.
let TOP_POSISI_SELECTED = {};  // posLabel -> 'kuat' | 'sedang' (radio Top Posisi)
let FX_FORMULAS_CACHE = null;  // { formulas, controlN } — daftar formula terakhir dipakai computeFormulaX(), dipakai ulang oleh fxApplyToGenerator()
let FX_OUT_N = 8;              // OUT= jumlah digit kandidat per pool (dulu tetap 8, sekarang bisa 4-9 lewat dropdown #fxOutN)

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

document.getElementById('fxOptWilsonBtn').addEventListener('click', () => {
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  fxRunOptimizer('Wilson Score', () => {
    const best = fxSearchBestN(lastHistoryNumbers, lastPosLabels, fxTrendAccuracy);
    fxApplyOptimizedN(best, 'Wilson Score');
  });
});

document.getElementById('fxOptWalkBtn').addEventListener('click', () => {
  if(!lastHistoryNumbers.length || !lastPosLabels) return;
  fxRunOptimizer('Walk-Forward', () => {
    const best = fxSearchBestN(lastHistoryNumbers, lastPosLabels, (f, chrono, cN, tN, idx) => fxTrendAccuracyWalkForward(f, chrono, cN, tN, idx, 5));
    fxApplyOptimizedN(best, 'Walk-Forward');
  });
});

document.getElementById('fxOptEnsembleBtn').addEventListener('click', () => {
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
  posLabels.forEach((label, idx) => {
    const col = document.createElement('div');
    col.className = 'fxCol';
    const h3 = document.createElement('h3');
    h3.textContent = 'Top Posisi ' + label;
    col.appendChild(h3);

    const { kuat, sedang, hasSource } = computeTopPosisiDigits(label, idx, used);

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

  thead.innerHTML = '<th>Sumber</th><th>Angka Aktual</th>' + posLabels.map(l => `<th>${l}</th>`).join('') + '<th>Status</th>';

  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="${posLabels.length + 3}" class="emptynote">Data belum cukup untuk backtest (butuh minimal ${minNeeded + 1} data).</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const cells = r.hitFlags.map(f => `<td class="${f ? 'fxOk' : 'fxBad'}">${f ? 'OK' : 'X'}</td>`).join('');
    return `<tr><td>${r.prev}</td><td>${r.target}</td>${cells}<td class="${r.ok ? 'fxOk' : 'fxBad'}">${r.ok ? 'SUKSES' : 'GAGAL'}</td></tr>`;
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
  if(lastHistoryNumbers.length && lastPosLabels) computeFormulaX(lastHistoryNumbers, lastPosLabels);
});

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
  resetFilters();

  // Kalau Mode Auto/Semi Auto sedang aktif, setiap kali Periode/Data Historis diproses ulang
  // (fungsi analyze() ini), langsung lanjutkan sisa alurnya (Auto Generate → ... → Terapkan
  // Filter) TANPA perlu klik tombol Auto lagi — jadi kontrol berikutnya benar-benar dari
  // Periode. computeFormulaX sudah dipanggil di atas, jadi lewati ulang bagian itu.
  if(typeof getAppMode === 'function'){
    const _mode = getAppMode();
    if(_mode === 'auto' || _mode === 'semi'){
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
  const N_JUMLAH = parseInt(document.getElementById('jsRecoCountJumlah').value, 10) || 5;
  const N_SELISIH = parseInt(document.getElementById('jsRecoCountSelisih').value, 10) || 5;

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
      const jumlahOrdered = manualJumlah || bestCoverJsPart(subN, 'jumlahList', N_JUMLAH);
      const selisihOrdered = manualSelisih || bestCoverJsPart(subN, 'selisihList', N_SELISIH);
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
    + `Window per baris: <b style="color:var(--ink);">${ROWS_SHOWN} data</b> · Jumlah digit rekomendasi: <b style="color:var(--ink);">${N_JUMLAH} (Jumlah) / ${N_SELISIH} (Selisih)</b>.`;

  document.getElementById('jsCard').style.display = 'block';
}

// tombol Jumlah/Selisih Prediksi -> langsung isi filter terkait (sama seperti pakaiAiPrediksi di Angka Ikut 4D)
function pakaiJsPrediksi(kind){
  if(!jsCtReference[kind]) return;
  if(kind === 'jumlah') document.getElementById('filterJumlah').value = jsTopValues.jumlah.join(',');
  else if(kind === 'selisih') document.getElementById('filterSelisih').value = jsTopValues.selisih.join(',');
  if(lastTop8Pools.length) applyFilters();
}

// ganti dropdown "Jumlah Baris Tabel" / "Jumlah Rekomendasi" (Jumlah & Selisih, terpisah) -> render ulang tabel pakai data yang sama, tanpa hitung ulang seluruh analisis
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

// tombol "Cari (cover data)": hitung digit dengan cakupan PALING TINGGI ke N data teratas (N = dropdown Jumlah
// Rekomendasi MASING-MASING bagian — Jumlah & Selisih punya dropdown N sendiri-sendiri, tidak lagi berbagi satu
// dropdown, supaya nilai N milik Jumlah tidak ketiban N milik Selisih pas dihitung ulang/preset dimuat lagi),
// lalu isi ke kotak manual (otomatis dipakai sama untuk SEMUA baris tabel) — persis logika cariAiCoverPart.
function cariJsCoverPart(key, manualInputId){
  if(!lastJsUsed || !lastJsUsed.length) return;
  const rowsShown = parseInt(document.getElementById('jsRowsShown').value, 10) || 15;
  const recoCountId = (key === 'jumlahList') ? 'jsRecoCountJumlah' : 'jsRecoCountSelisih';
  const n = parseInt(document.getElementById(recoCountId).value, 10) || 5;
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

// jumlah digit Ai per bagian — dibaca dari dropdown "Jumlah Output Ai" (pilihan 2-9), default 5 kalau belum ada/rusak
function getAiDigitCount(){
  const el = document.getElementById('aiDigitCount');
  const v = el ? parseInt(el.value, 10) : NaN;
  return (Number.isInteger(v) && v >= 2 && v <= 9) ? v : 5;
}
const AI_MONTH_THRESHOLD = 0.70; // Ai bulanan diganti kalau cakupannya ke data bulan berjalan turun di bawah ini

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
    const raw = document.getElementById(`aiWin${part}Manual`).value.replace(/\D/g, '').slice(0, 9);
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

// textbox Ai manual AC/CK/KE: hanya terima digit, maksimal 9 karakter, otomatis refresh tabel tiap kali diketik
['aiWinACManual', 'aiWinCKManual', 'aiWinKEManual'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const cleaned = e.target.value.replace(/\D/g, '').slice(0, 9);
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

function cartesianProduct(pools){
  return pools.reduce((acc, pool) => {
    const next = [];
    acc.forEach(prefix => { pool.forEach(d => next.push(prefix + d)); });
    return next;
  }, ['']);
}

function generateCombineOutput(){
  const raw = document.getElementById('bulkOut').value.trim();
  if(!raw){ alert('Isi dulu kotak pool digit (bisa otomatis dari Formula X/Top Posisi, atau ketik manual dipisah titik).'); return; }

  const segments = raw.split('.').map(s => s.trim()).filter(s => s.length > 0);
  if(segments.length < 2){
    alert('Format tidak valid — pisahkan tiap posisi pakai titik (.), mis. 12345678.98765432 untuk 2D.');
    return;
  }
  if(segments.some(s => !/^[0-9]+$/.test(s))){
    alert('Tiap posisi hanya boleh berisi digit 0-9, dipisah titik (.).');
    return;
  }

  const pools = segments.map(s => s.split(''));
  lastTop8Pools = pools; // jadi sumber untuk filter panel & regenerasi berikutnya juga
  filterCustomSource = null; // pool baru dibuat manual -> lepas sumber kustom dari Auto Generator (kalau ada)

  const results = cartesianProduct(pools); // urutan baku sesuai peringkat kandidat, tidak diacak
  document.getElementById('combineOut').value = results.join('*') + '*';
  document.getElementById('combineCountOut').textContent = results.length;
}

document.getElementById('combineGenBtn').addEventListener('click', generateCombineOutput);

// Tombol 2D/3D: ambil pool digit posisi tertentu saja dari hasil Formula X yang sedang aktif
// (lastPosLabels/lastTop8Pools, sudah terisi lewat fxApplyToGenerator), lalu generate + terapkan ke Filter Pangkas Kombinasi.
// 2D = posisi K & E. 3D = posisi C, K & E.
function generateBySubsetPosisi(requiredLabels, dimName){
  if(!lastPosLabels || !lastTop8Pools.length){
    alert('Hitung Frekuensi dulu (isi Data Historis) sebelum generate ' + dimName + '.');
    return;
  }
  const idxs = requiredLabels.map(l => lastPosLabels.indexOf(l));
  if(idxs.some(i => i === -1)){
    alert('Data historis saat ini tidak punya posisi ' + requiredLabels.join('/') + ' — generate ' + dimName + ' butuh data 3D/4D (posisi ' + requiredLabels.join(',') + ').');
    return;
  }
  const pools = idxs.map(i => lastTop8Pools[i]);
  if(pools.some(p => !p || !p.length)){
    alert('Pool digit untuk posisi ' + requiredLabels.join('/') + ' belum lengkap — coba Hitung Ulang Formula X dulu.');
    return;
  }
  lastTop8Pools = pools;
  document.getElementById('bulkOut').value = pools.map(p => p.join('')).join('.');
  generateCombineOutput();
  if(document.getElementById('filterCard').style.display === 'block') resetFilters();
}
document.getElementById('gen2DBtn').addEventListener('click', () => generateBySubsetPosisi(['K','E'], '2D'));
document.getElementById('gen3DBtn').addEventListener('click', () => generateBySubsetPosisi(['C','K','E'], '3D'));

// Tombol "Ambil dari Formula X" di tab Generator — sama persis dengan fxApplyBtn di tab Formula X,
// cuma dipasang keduanya di sini supaya tidak perlu pindah tab dulu.
document.getElementById('genFxApplyBtn').addEventListener('click', () => fxApplyToGenerator(false));

// Tombol "Standar" — isi pool tiap posisi dengan semua digit 0-9 (generate semua 10.000 kombinasi 4D),
// dipakai sebagai baseline netral sebelum dipangkas lewat tab Filter.
const GEN_STANDAR_POOL = '0987654321.1234567890.9087654321.6789054321';
document.getElementById('genStandarBtn').addEventListener('click', () => {
  document.getElementById('bulkOut').value = GEN_STANDAR_POOL;
  generateCombineOutput();
  if(document.getElementById('filterCard').style.display === 'block') resetFilters();
});

document.getElementById('combineCopyBtn').addEventListener('click', () => {
  const text = document.getElementById('combineOut').value;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('combineCopyBtn');
    const original = btn.textContent;
    btn.textContent = 'Tersalin ✓';
    setTimeout(() => btn.textContent = original, 1400);
  }).catch(() => {
    const ta = document.getElementById('combineOut');
    ta.select(); document.execCommand('copy');
  });
});

function isNoTwin(num){
  return new Set(num.split('')).size === num.length;
}

// ---------- Filter Twin Murni (pola posisi kembar, mis. AABC/ABAC/ABCA/BAAC/BACA/BCAA) ----------
const TWIN_MURNI_LABELS_4D = {
  '0-1': 'AABC', '0-2': 'ABAC', '0-3': 'ABCA',
  '1-2': 'BAAC', '1-3': 'BACA', '2-3': 'BCAA'
};

function getPositionPairs(len){
  const pairs = [];
  for(let i = 0; i < len; i++){
    for(let j = i + 1; j < len; j++){ pairs.push([i, j]); }
  }
  return pairs;
}

function matchesPairPattern(str, i, j){
  const d = str.split('');
  if(d[i] !== d[j]) return false;
  const rest = [];
  for(let k = 0; k < d.length; k++){
    if(k !== i && k !== j){
      if(d[k] === d[i]) return false;
      rest.push(d[k]);
    }
  }
  return new Set(rest).size === rest.length; // posisi sisa wajib unik satu sama lain juga
}

function renderTwinMurniCheckboxes(len){
  const group = document.getElementById('twinMurniGroup');
  group.querySelectorAll('.twinMurniPick').forEach(el => el.closest('label').remove());
  getPositionPairs(len).forEach(([i, j]) => {
    const label = document.createElement('label');
    label.className = 'chk';
    const name = (len === 4 && TWIN_MURNI_LABELS_4D[`${i}-${j}`]) || `Digit ke-${i+1} & ke-${j+1}`;
    label.innerHTML = `<input type="checkbox" class="twinMurniPick" data-i="${i}" data-j="${j}"> ${name}`;
    group.appendChild(label);
  });
}

// Hapus 3-4: buang angka yang punya digit muncul 3x atau lebih (mencakup AAAB/AABA/ABAA/BAAA/AAAA sekaligus,
// karena semua pola itu punya satu digit yang muncul minimal 3 kali).
function hasTripleOrMore(numStr){
  const counts = {};
  for(const d of numStr){ counts[d] = (counts[d] || 0) + 1; }
  return Object.values(counts).some(c => c >= 3);
}

function getSelectedTwinMurniPairs(){
  return [...document.querySelectorAll('.twinMurniPick:checked')]
    .map(el => [parseInt(el.dataset.i, 10), parseInt(el.dataset.j, 10)]);
}

function parseMultiValues(raw){
  return [...new Set(
    raw.split(',')
      .map(s => s.trim())
      .filter(s => s !== '' && /^[0-9]$/.test(s))
      .map(s => parseInt(s, 10))
  )];
}

function applyFilters(){
  // Sumber kustom (dari "Kirim ke Filter" Auto Generator) menang kalau ada — itu daftar
  // kombinasi JADI yang sudah melalui eliminasi Gen 2, jadi tidak boleh dibangun ulang
  // dari pool mentah lastTop8Pools (itu akan memunculkan lagi angka yang sudah dieliminasi).
  const source = (filterCustomSource && filterCustomSource.length)
    ? filterCustomSource
    : (lastTop8Pools.length ? cartesianProduct(lastTop8Pools) : null);
  if(!source) return;

  const noTwin = document.getElementById('filterNoTwin').checked;
  const shortAC = document.getElementById('filterShortAC').checked;
  const shortCK = document.getElementById('filterShortCK').checked;
  const shortKE = document.getElementById('filterShortKE').checked;
  const hapus34 = document.getElementById('filterHapus34').checked;
  const excludeHistory = document.getElementById('filterExcludeHistory').checked;
  const cb = document.getElementById('filterCB').value.replace(/[^0-9]/g, '');
  const aiAC = document.getElementById('filterAiAC').value.replace(/[^0-9]/g, '');
  const aiCK = document.getElementById('filterAiCK').value.replace(/[^0-9]/g, '');
  const ai = document.getElementById('filterAI').value.replace(/[^0-9]/g, '');
  const jumlahTargets = parseMultiValues(document.getElementById('filterJumlah').value);
  const selisihTargets = parseMultiValues(document.getElementById('filterSelisih').value);
  const historySet = new Set(lastHistoryNumbers);

  let filtered = source;
  if(noTwin) filtered = filtered.filter(isNoTwin);
  if(hapus34) filtered = filtered.filter(num => !hasTripleOrMore(num));
  if(excludeHistory) filtered = filtered.filter(num => !historySet.has(num));
  if(cb){
    // Ai 2D: cek hanya ke posisi K (puluhan) & E (satuan) = 2 digit terakhir.
    // Mode normal (ShortKE tidak dicentang): lolos kalau salah satu digit yang diisi cocok salah satu dari K/E (OR).
    // Mode ShortKE dicentang: lolos hanya kalau K DAN E berdua ada di dalam set Ai 2D (AND) — fokus KE saja.
    const cbDigits = new Set(cb.split(''));
    filtered = filtered.filter(num => {
      const ke = num.slice(-2).split('');
      return shortKE ? ke.every(d => cbDigits.has(d)) : ke.some(d => cbDigits.has(d));
    });
  }
  if(aiAC){
    // Ai AC: cek hanya ke posisi A & C = 2 digit pertama.
    // Mode normal (ShortAC tidak dicentang): lolos kalau salah satu digit yang diisi cocok salah satu dari A/C (OR).
    // Mode ShortAC dicentang: lolos hanya kalau A DAN C berdua ada di dalam set Ai AC (AND) — fokus AC saja.
    const acDigits = new Set(aiAC.split(''));
    filtered = filtered.filter(num => {
      const ac = num.slice(0, 2).split('');
      return shortAC ? ac.every(d => acDigits.has(d)) : ac.some(d => acDigits.has(d));
    });
  }
  if(aiCK){
    // Ai CK: cek hanya ke posisi C & K = digit ke-2 & ke-3.
    // Mode normal (ShortCK tidak dicentang): lolos kalau salah satu digit yang diisi cocok salah satu dari C/K (OR).
    // Mode ShortCK dicentang: lolos hanya kalau C DAN K berdua ada di dalam set Ai CK (AND) — fokus CK saja.
    const ckDigits = new Set(aiCK.split(''));
    filtered = filtered.filter(num => {
      const ck = num.slice(1, 3).split('');
      return shortCK ? ck.every(d => ckDigits.has(d)) : ck.some(d => ckDigits.has(d));
    });
  }
  if(ai){
    const included = new Set(ai.split(''));
    filtered = filtered.filter(num => num.split('').some(d => included.has(d)));
  }
  if(jumlahTargets.length){
    // Disamakan dengan menu Analisis Jumlah & Selisih: Jumlah dihitung per pasangan AC/CK/KE
    // (bukan total 4 digit) -> angka lolos kalau salah satu dari 3 nilai Jumlah tsb cocok target.
    const targetSet = new Set(jumlahTargets);
    filtered = filtered.filter(num => {
      const { jumlahList } = jumlahSelisihList(num);
      return jumlahList.some(v => targetSet.has(v));
    });
  }
  if(selisihTargets.length){
    // Disamakan dengan menu Analisis Jumlah & Selisih: Selisih dihitung per pasangan AC/CK/KE
    // (bukan |digit pertama - digit terakhir|) -> angka lolos kalau salah satu dari 3 nilai Selisih tsb cocok target.
    const targetSet = new Set(selisihTargets);
    filtered = filtered.filter(num => {
      const { selisihList } = jumlahSelisihList(num);
      return selisihList.some(v => targetSet.has(v));
    });
  }
  const twinMurniPairs = getSelectedTwinMurniPairs();
  if(twinMurniPairs.length > 0){
    const twinModeEl = document.querySelector('input[name="twinMode"]:checked');
    const twinMode = twinModeEl ? twinModeEl.value : 'include';
    if(twinMode === 'exclude'){
      // Hapus twin: buang angka yang cocok salah satu pola twin yang dicentang.
      filtered = filtered.filter(num => !twinMurniPairs.some(([i, j]) => matchesPairPattern(num, i, j)));
    } else {
      // Ikutkan twin: hanya sertakan angka yang cocok salah satu pola twin yang dicentang.
      filtered = filtered.filter(num => twinMurniPairs.some(([i, j]) => matchesPairPattern(num, i, j)));
    }
  }
  const shioSelected = [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio);
  if(shioSelected.length > 0 && lastPosLabels && lastPosLabels.length === 4){
    // Filter AI Shio 4D: lolos kalau salah satu dari AC/CK/KE kombinasi masuk ke shio yang dicentang.
    const shioSet = new Set(shioSelected.map(s => parseInt(s, 10)));
    filtered = filtered.filter(num => {
      const ac = shioOf12(num.slice(0,2));
      const ck = shioOf12(num.slice(1,3));
      const ke = shioOf12(num.slice(2,4));
      return shioSet.has(ac) || shioSet.has(ck) || shioSet.has(ke);
    });
  }

  document.getElementById('filterOut').value = filtered.length ? (filtered.join('*') + '*') : '(tidak ada hasil dengan filter ini)';
  document.getElementById('filterCountOut').textContent = filtered.length;
}

function resetFilters(){
  document.getElementById('filterNoTwin').checked = false;
  document.getElementById('filterShortAC').checked = false;
  document.getElementById('filterShortCK').checked = false;
  document.getElementById('filterShortKE').checked = false;
  document.getElementById('filterHapus34').checked = false;
  document.getElementById('filterExcludeHistory').checked = false;
  document.getElementById('filterCB').value = '';
  document.getElementById('filterAiAC').value = '';
  document.getElementById('filterAiCK').value = '';
  document.getElementById('filterAI').value = '';
  document.getElementById('filterJumlah').value = '';
  document.getElementById('filterSelisih').value = '';
  document.querySelectorAll('.twinMurniPick').forEach(cb => cb.checked = false);
  document.getElementById('twinModeInclude').checked = true;
  document.getElementById('filterShioAll').checked = false;
  document.querySelectorAll('.shioPick').forEach(cb => cb.checked = false);
  updateShioPickNote();
  applyFilters();
}

document.getElementById('applyFilterBtn').addEventListener('click', applyFilters);
document.getElementById('resetFilterBtn').addEventListener('click', resetFilters);

// ---------- Bagikan Link (data + pool generator + opsi filter, tidak berubah saat dibuka lagi) ----------
function collectShareState(){
  return {
    data: document.getElementById('dataInput').value,
    pools: lastTop8Pools,
    f: {
      noTwin: document.getElementById('filterNoTwin').checked,
      shortAC: document.getElementById('filterShortAC').checked,
      shortCK: document.getElementById('filterShortCK').checked,
      shortKE: document.getElementById('filterShortKE').checked,
      hapus34: document.getElementById('filterHapus34').checked,
      excludeHistory: document.getElementById('filterExcludeHistory').checked,
      cb: document.getElementById('filterCB').value,
      aiAC: document.getElementById('filterAiAC').value,
      aiCK: document.getElementById('filterAiCK').value,
      ai: document.getElementById('filterAI').value,
      jumlah: document.getElementById('filterJumlah').value,
      selisih: document.getElementById('filterSelisih').value,
      twinPairs: getSelectedTwinMurniPairs(),
      twinMode: (document.querySelector('input[name="twinMode"]:checked') || {}).value || 'include',
      shio: [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio)
    }
  };
}

// Link pendek: simpan state ke Firebase ('sharedFilters/<pushId>'), URL cuma bawa ID-nya (#s=<pushId>).
// Kalau cloud tidak tersedia/gagal, fallback ke cara lama (semua data di-encode base64 di URL, #share=...).
function buildShareLinkFallback(state){
  const json = JSON.stringify(state);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  const url = new URL(window.location.href);
  url.hash = 'share=' + encoded;
  return url.toString();
}

function buildShareLink(){
  const state = collectShareState();
  if(!db) return Promise.resolve(buildShareLinkFallback(state));
  return authReadyPromise.then(isAuthed => {
    if(!isAuthed) return buildShareLinkFallback(state);
    const shareRef = db.ref('sharedFilters').push();
    return shareRef.set(state)
      .then(() => {
        const url = new URL(window.location.href);
        url.hash = 's=' + shareRef.key;
        return url.toString();
      })
      .catch(e => {
        console.error('Gagal simpan link ke cloud, pakai link cadangan (lebih panjang):', e);
        return buildShareLinkFallback(state);
      });
  });
}

// Terapkan state hasil bagikan (dari cloud ataupun dari link lama) ke semua kontrol filter.
function applyShareState(state){
  document.getElementById('dataInput').value = state.data || '';
  analyze();
  if(Array.isArray(state.pools) && state.pools.length) lastTop8Pools = state.pools;
  filterCustomSource = null; // pool dipulihkan dari link bagikan -> lepas sumber kustom Auto Generator
  const f = state.f || {};
  document.getElementById('filterNoTwin').checked = !!f.noTwin;
  document.getElementById('filterShortAC').checked = !!f.shortAC;
  document.getElementById('filterShortCK').checked = !!f.shortCK;
  document.getElementById('filterShortKE').checked = !!f.shortKE;
  document.getElementById('filterHapus34').checked = !!f.hapus34;
  document.getElementById('filterExcludeHistory').checked = !!f.excludeHistory;
  document.getElementById('filterCB').value = f.cb || '';
  document.getElementById('filterAiAC').value = f.aiAC || '';
  document.getElementById('filterAiCK').value = f.aiCK || '';
  document.getElementById('filterAI').value = f.ai || '';
  document.getElementById('filterJumlah').value = f.jumlah || '';
  document.getElementById('filterSelisih').value = f.selisih || '';
  (f.twinPairs || []).forEach(([i, j]) => {
    const cb = document.querySelector(`.twinMurniPick[data-i="${i}"][data-j="${j}"]`);
    if(cb) cb.checked = true;
  });
  const twinModeEl = document.getElementById(f.twinMode === 'exclude' ? 'twinModeExclude' : 'twinModeInclude');
  if(twinModeEl) twinModeEl.checked = true;
  (f.shio || []).forEach(s => {
    const cb = document.querySelector(`.shioPick[data-shio="${s}"]`);
    if(cb) cb.checked = true;
  });
  const shioAll = document.querySelectorAll('.shioPick').length;
  const shioChecked = document.querySelectorAll('.shioPick:checked').length;
  document.getElementById('filterShioAll').checked = (shioAll === shioChecked && shioAll > 0);
  updateShioPickNote();
  applyFilters();
  const filterCard = document.getElementById('filterCard');
  if(filterCard) filterCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Baca hash URL: format baru #s=<id> (ambil dari cloud) atau format lama #share=<base64> (langsung decode).
// Selalu mengembalikan Promise<boolean> supaya pemanggilnya (DOMContentLoaded) bisa nunggu proses cloud selesai.
function restoreFromShareLink(){
  const hash = window.location.hash || '';
  const shortMatch = hash.match(/[#&]s=([^&]+)/);
  const longMatch = hash.match(/[#&]share=([^&]+)/);

  if(shortMatch){
    if(!db) return Promise.resolve(false);
    return authReadyPromise.then(isAuthed => {
      if(!isAuthed) return false;
      return db.ref('sharedFilters/' + shortMatch[1]).once('value')
        .then(snap => {
          const state = snap.val();
          if(!state) return false;
          applyShareState(state);
          return true;
        })
        .catch(e => {
          console.error('Gagal memuat link berbagi dari cloud:', e);
          return false;
        });
    });
  }

  if(longMatch){
    try{
      const json = decodeURIComponent(escape(atob(longMatch[1])));
      const state = JSON.parse(json);
      applyShareState(state);
      return Promise.resolve(true);
    }catch(e){
      console.error('Gagal memulihkan link berbagi:', e);
      return Promise.resolve(false);
    }
  }

  return Promise.resolve(false);
}

document.getElementById('filterShareBtn').addEventListener('click', () => {
  const feedback = document.getElementById('filterShareFeedback');
  if(!lastTop8Pools.length){
    feedback.style.color = 'var(--rose)';
    feedback.textContent = 'Belum ada hasil untuk dibagikan — isi data & terapkan filter dulu.';
    return;
  }
  feedback.style.color = 'var(--ink-dim)';
  feedback.textContent = 'Membuat link...';
  const done = (link) => {
    const copy = () => {
      feedback.style.color = 'var(--teal)';
      feedback.textContent = 'Link Tersalin ✓';
      setTimeout(() => { feedback.textContent = ''; }, 3000);
    };
    navigator.clipboard.writeText(link).then(copy).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copy();
    });
  };
  buildShareLink().then(done).catch(e => {
    console.error('Gagal membuat link berbagi:', e);
    feedback.style.color = 'var(--rose)';
    feedback.textContent = 'Gagal membuat link, coba lagi.';
  });
});
document.getElementById('filterCopyBtn').addEventListener('click', () => {
  const text = document.getElementById('filterOut').value;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('filterCopyBtn');
    const original = btn.textContent;
    btn.textContent = 'Tersalin ✓';
    setTimeout(() => btn.textContent = original, 1400);
  }).catch(() => {
    const ta = document.getElementById('filterOut');
    ta.select(); document.execCommand('copy');
  });
  if(text && text.trim()) addRekapEntry();
});

function resetAllSettings(){
  // Formula X & Top Posisi: kosongkan pilihan supaya balik ke rekomendasi teratas (default) saat dihitung ulang.
  FX_SELECTED = {};
  FX_TOUCHED = {};
  TOP_POSISI_SELECTED = {};
  // Jendela Tren N & Kontrol N balik ke nilai standar.
  const trendSel = document.getElementById('fxTrendN');
  const controlSel = document.getElementById('fxControlN');
  const outSel = document.getElementById('fxOutN');
  if(trendSel) trendSel.value = '30';
  if(controlSel) controlSel.value = '10';
  if(outSel) outSel.value = '8';
  // Panel filter (Tanpa Kembar, Buang Riwayat, CB, AI, Jumlah, Selisih, Twin Murni, Shio) — resetFilters()
  // sudah dipanggil otomatis di akhir analyze(), jadi tidak perlu diulang di sini.
}

// ---------- Kumpulkan & pulihkan SEMUA opsi/pengaturan di seluruh menu (Formula X, Kontrol Ai, Generator, Filter) ----------
// Dipakai oleh tombol Simpan/Muat supaya setiap data tersimpan membawa persis pilihan & input manual/otomatis
// yang sedang aktif di semua menu, bukan cuma teks Data Historis-nya saja.
function collectAllSettings(){
  return {
    fx: {
      trendN: document.getElementById('fxTrendN').value,
      controlN: document.getElementById('fxControlN').value,
      outN: document.getElementById('fxOutN').value,
      selected: { ...FX_SELECTED },
      topPosisiSelected: { ...TOP_POSISI_SELECTED }
    },
    aiWin: {
      rowsShown: document.getElementById('aiRowsShown').value,
      digitCount: document.getElementById('aiDigitCount').value,
      ACManual: document.getElementById('aiWinACManual').value,
      CKManual: document.getElementById('aiWinCKManual').value,
      KEManual: document.getElementById('aiWinKEManual').value
    },
    shioWin: {
      rowsShown: document.getElementById('shioRowsShown').value,
      pickCount: document.getElementById('shioPickCount').value,
      manual: document.getElementById('shioManual').value
    },
    js: {
      recoCountJumlah: document.getElementById('jsRecoCountJumlah').value,
      recoCountSelisih: document.getElementById('jsRecoCountSelisih').value
    },
    generator: {
      bulkOut: document.getElementById('bulkOut').value,
      pools: lastTop8Pools
    },
    filter: {
      noTwin: document.getElementById('filterNoTwin').checked,
      shortAC: document.getElementById('filterShortAC').checked,
      shortCK: document.getElementById('filterShortCK').checked,
      shortKE: document.getElementById('filterShortKE').checked,
      hapus34: document.getElementById('filterHapus34').checked,
      excludeHistory: document.getElementById('filterExcludeHistory').checked,
      cb: document.getElementById('filterCB').value,
      aiAC: document.getElementById('filterAiAC').value,
      aiCK: document.getElementById('filterAiCK').value,
      ai: document.getElementById('filterAI').value,
      jumlah: document.getElementById('filterJumlah').value,
      selisih: document.getElementById('filterSelisih').value,
      twinPairs: getSelectedTwinMurniPairs(),
      twinMode: (document.querySelector('input[name="twinMode"]:checked') || {}).value || 'include',
      shio: [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio)
    }
  };
}

function applyAllSettings(settings){
  if(!settings || typeof settings !== 'object'){ analyze(); return; }

  // 1) Kontrol Ai (dropdown Jumlah Baris Tabel & manual per bagian) dan Formula X (Jendela Tren N / Kontrol N)
  //    -> diisi SEBELUM analyze(), karena analyze() membaca nilai dropdown/textbox ini langsung waktu merender ulang tabel.
  const aiWin = settings.aiWin || {};
  if(aiWin.rowsShown != null) document.getElementById('aiRowsShown').value = aiWin.rowsShown;
  if(aiWin.digitCount != null) document.getElementById('aiDigitCount').value = aiWin.digitCount;
  document.getElementById('aiWinACManual').value = aiWin.ACManual || '';
  document.getElementById('aiWinCKManual').value = aiWin.CKManual || '';
  document.getElementById('aiWinKEManual').value = aiWin.KEManual || '';

  const shioWin = settings.shioWin || {};
  if(shioWin.rowsShown != null) document.getElementById('shioRowsShown').value = shioWin.rowsShown;
  if(shioWin.pickCount != null) document.getElementById('shioPickCount').value = shioWin.pickCount;
  document.getElementById('shioManual').value = shioWin.manual || '';

  const js = settings.js || {};
  if(js.recoCountJumlah != null) document.getElementById('jsRecoCountJumlah').value = js.recoCountJumlah;
  if(js.recoCountSelisih != null) document.getElementById('jsRecoCountSelisih').value = js.recoCountSelisih;

  const fx = settings.fx || {};
  if(fx.trendN != null) document.getElementById('fxTrendN').value = fx.trendN;
  if(fx.controlN != null) document.getElementById('fxControlN').value = fx.controlN;
  if(fx.outN != null) document.getElementById('fxOutN').value = fx.outN;

  // 2) Hitung ulang seluruh analisis dari data historis yang baru dimuat (otomatis merender Formula X, Ai, Shio, dll).
  analyze();

  // 3) Formula X & Top Posisi: computeFormulaX (dipanggil dari analyze()) selalu mengarahkan pilihan ke varian
  //    akurasi tertinggi -> timpa lagi dengan pilihan yang tersimpan, lalu render ulang supaya radio & Generator ikut.
  if(lastPosLabels && lastPosLabels.length){
    FX_SELECTED = { ...(fx.selected || {}) };
    // Tandai semua posisi yang dipulihkan sebagai "sudah dipilih manual" (FX_TOUCHED) — kalau tidak,
    // Gen 2 di Generator akan balik ke default (rangking terakhir) padahal FX_SELECTED-nya sudah benar.
    FX_TOUCHED = {};
    Object.keys(FX_SELECTED).forEach(label => { FX_TOUCHED[label] = true; });
    TOP_POSISI_SELECTED = { ...(fx.topPosisiSelected || {}) };
    renderFormulaX(lastPosLabels);
    renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers);
    renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
    renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  }

  // 4) Generator: pulihkan isian Kombinasi Acak persis seperti saat disimpan (baik hasil otomatis maupun ketikan manual).
  const gen = settings.generator || {};
  if(Array.isArray(gen.pools) && gen.pools.length) lastTop8Pools = gen.pools;
  if(gen.bulkOut != null) document.getElementById('bulkOut').value = gen.bulkOut;
  if(typeof generateCombineOutput === 'function') generateCombineOutput();

  // 5) Filter Pangkas Kombinasi: analyze() selalu memanggil resetFilters() di baris terakhirnya,
  //    jadi filter baru dipulihkan SETELAH analyze() selesai supaya tidak ketiban reset.
  const f = settings.filter || {};
  document.getElementById('filterNoTwin').checked = !!f.noTwin;
  document.getElementById('filterShortAC').checked = !!f.shortAC;
  document.getElementById('filterShortCK').checked = !!f.shortCK;
  document.getElementById('filterShortKE').checked = !!f.shortKE;
  document.getElementById('filterHapus34').checked = !!f.hapus34;
  document.getElementById('filterExcludeHistory').checked = !!f.excludeHistory;
  document.getElementById('filterCB').value = f.cb || '';
  document.getElementById('filterAiAC').value = f.aiAC || '';
  document.getElementById('filterAiCK').value = f.aiCK || '';
  document.getElementById('filterAI').value = f.ai || '';
  document.getElementById('filterJumlah').value = f.jumlah || '';
  document.getElementById('filterSelisih').value = f.selisih || '';
  (f.twinPairs || []).forEach(([i, j]) => {
    const cb = document.querySelector(`.twinMurniPick[data-i="${i}"][data-j="${j}"]`);
    if(cb) cb.checked = true;
  });
  const twinModeEl = document.getElementById(f.twinMode === 'exclude' ? 'twinModeExclude' : 'twinModeInclude');
  if(twinModeEl) twinModeEl.checked = true;
  (f.shio || []).forEach(s => {
    const cb = document.querySelector(`.shioPick[data-shio="${s}"]`);
    if(cb) cb.checked = true;
  });
  const shioAllCount = document.querySelectorAll('.shioPick').length;
  const shioCheckedCount = document.querySelectorAll('.shioPick:checked').length;
  const shioAllEl = document.getElementById('filterShioAll');
  if(shioAllEl) shioAllEl.checked = (shioAllCount === shioCheckedCount && shioAllCount > 0);
  if(typeof updateShioPickNote === 'function') updateShioPickNote();
  if(typeof applyFilters === 'function') applyFilters();
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

function firebaseSetSelectedKode(kode){
  const select = document.getElementById('firebaseMarketSelect');
  if(!select || !kode) return;
  const found = Array.from(select.options).find(o => o.value.toLowerCase() === String(kode).toLowerCase());
  if(found) select.value = found.value;
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
  const select = document.getElementById('firebaseMarketSelect');
  if(!select) return;

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

  select.innerHTML = '<option value="">— pilih pasaran —</option>' +
    items.map(item => {
      const namaPanjang = String(item.found?.info?.nama || item.name).trim();
      const label = item.next
        ? `${namaPanjang} · ${firebaseFormatDropdownDuration((item.next.ts - Date.now()) / 1000)}`
        : `${namaPanjang} · —`;
      const value = item.name.replace(/"/g,'&quot;');
      return `<option value="${value}" title="${namaPanjang}">${label}</option>`;
    }).join('');

  firebaseSetSelectedKode(selected);
  if(!select.value && items.length) select.value = items[0].name;
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
    if(kode) localStorage.setItem(FIREBASE_MARKET_KEY, kode);
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

// ===== Tambahan rapikan tampilan (tidak mengubah logika perhitungan yang sudah ada) =====

// (5) Fade-in halus tiap kali card hasil (resultCard/jsCard/bulkCard/filterCard) ditampilkan lewat style.display
(function(){
  const revealIds = ['resultCard','jsCard','bulkCard','filterCard'];
  revealIds.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    const obs = new MutationObserver(() => {
      if(el.style.display === 'block' && el.dataset.revealed !== '1'){
        el.dataset.revealed = '1';
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        }));
      } else if(el.style.display === 'none'){
        el.dataset.revealed = '0';
      }
    });
    obs.observe(el, { attributes: true, attributeFilter: ['style'] });
  });
})();

// (1) Nav tab-panel: klik tab -> tampilkan 1 panel terkait, sembunyikan sisanya. Tab redup kalau hasilnya belum siap (belum klik Hitung Frekuensi).
(function(){
  const nav = document.getElementById('navTabs');
  if(!nav) return;
  const buttons = Array.from(nav.querySelectorAll('.tabbtn'));
  const panels = Array.from(document.querySelectorAll('.tabpanel'));

  function activate(tabName, doScroll){
    buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    panels.forEach(p => p.classList.toggle('active', p.dataset.tab === tabName));
    if(doScroll){
      const activePanel = panels.find(p => p.dataset.tab === tabName);
      if(activePanel){
        // Geser supaya isi tab persis mulai di bawah nav tab (nav-nya sticky/nempel di atas,
        // jadi tidak bisa asal scrollIntoView ke posisi 0 — nanti isi tab ketutupan nav).
        const navH = nav.getBoundingClientRect().height || 0;
        const y = activePanel.getBoundingClientRect().top + window.pageYOffset - navH - 4;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }
    }
  }
  buttons.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab, true)));
  if(buttons[0]) activate(buttons[0].dataset.tab, false);

  // Tab redup selama kartu sumbernya belum ditampilkan (menunggu Hitung Frekuensi)
  const readinessCardId = {
    formulax: 'resultCard',
    jumlahselisih: 'jsCard',
    angkaikut: 'jsCard',
    shio234: 'jsCard',
    generator: 'bulkCard'
  };
  function refreshLocks(){
    buttons.forEach(b => {
      const cardId = readinessCardId[b.dataset.tab];
      const card = cardId && document.getElementById(cardId);
      const ready = !card || card.style.display !== 'none';
      if(ready) b.removeAttribute('data-locked'); else b.setAttribute('data-locked', '1');
    });
  }
  refreshLocks();
  ['resultCard', 'jsCard', 'bulkCard'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    new MutationObserver(refreshLocks).observe(el, { attributes: true, attributeFilter: ['style'] });
  });
})();

// (2) Badge jumlah data di judul "Data Historis", ikut nilai #totalCount
(function(){
  const src = document.getElementById('totalCount');
  const badge = document.getElementById('dataCountBadge');
  if(!src || !badge) return;
  new MutationObserver(() => { badge.textContent = (src.textContent || '0') + ' data'; })
    .observe(src, { childList: true, characterData: true, subtree: true });
})();

// (2) Badge sisa hasil di judul "Filter Pangkas Kombinasi", ikut nilai #filterCountOut
(function(){
  const src = document.getElementById('filterCountOut');
  const badge = document.getElementById('filterCountBadge');
  if(!src || !badge) return;
  new MutationObserver(() => { badge.textContent = (src.textContent || '0') + ' sisa'; })
    .observe(src, { childList: true, characterData: true, subtree: true });
})();

// ===== Rekapitulasi (dibuat otomatis tiap tombol Salin di Filter Pangkas Kombinasi ditekan) =====
const REKAP_STORAGE_KEY = 'rekapEntries_v1';
const REKAP_TTL_MS = 48 * 60 * 60 * 1000; // catatan rekap otomatis terhapus setelah 48 jam

function loadRekapEntries(){
  try{
    const raw = localStorage.getItem(REKAP_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function saveRekapEntries(arr){
  try{ localStorage.setItem(REKAP_STORAGE_KEY, JSON.stringify(arr)); }catch(e){}
}
let rekapEntries = loadRekapEntries();

function rekapTodayStr(){
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}`;
}

// hanya menyisakan digit 0-9 dari isian filter (mis. "5,7,2" -> "572")
function rekapCleanList(raw){
  return (raw || '').replace(/[^0-9]/g, '');
}

function rekapEscapeHtml(str){
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Label pasaran/data yang sedang dimuat, mis. "HK615"
function rekapCurrentMarketLabel(){
  const marketLabelEl = document.getElementById('filterLoadedName');
  const marketLabel = (marketLabelEl?.textContent || '').trim();
  return (marketLabel && marketLabel !== '–' && marketLabel !== '-')
    ? marketLabel
    : (currentLoadedDataName || '-');
}

// Naikkan +1 nomor urut di akhir label, mis. "HK615" -> "HK616". Kalau tidak ada
// angka di akhir label, dikembalikan apa adanya (tidak bisa ditebak periode berikutnya).
// Pakai rekapParsePeriode yang sama dengan jalur pencocokan hasil, supaya label
// tampilan dan ID pencocokan tidak pernah geser satu sama lain.
function rekapIncrementPeriode(label){
  const { prefix, urutan, digits } = rekapParsePeriode(label);
  if(urutan === null) return label;
  const next = String(urutan + 1).padStart(digits, '0');
  return prefix + next;
}

// Ambil prefix pasaran dari sebuah label/periode, mis. "HK-615" atau "HK615" -> "HK".
function rekapPeriodePrefix(label){
  return rekapParsePeriode(label).prefix;
}

// ID rekap tunggal: prefix pasaran + noUrut TARGET (bukan noUrut sumber).
// Dibuat SEKALI saat rekap dibuat (buildRekapEntry), dipakai apa adanya untuk
// mencocokkan hasil di semua jalur (lokal maupun Firebase) — supaya tidak ada
// dua logika penentuan hasil yang bisa saling miss.
function rekapMakeId(prefix, targetUrutan){
  return prefix + '#' + targetUrutan;
}

// Ambil snapshot semua state yang relevan (Formula X, filter yang dipilih, shio, twin) saat tombol Salin ditekan.
// "market" disimpan sebagai periode BERIKUTNYA (mis. data yang dipakai HK615 -> rekap untuk HK616),
// karena Formula X & filter di sini memprediksi draw setelah data yang sedang dimuat.
function buildRekapEntry(){
  const sourceMarket = rekapCurrentMarketLabel();
  const market = rekapIncrementPeriode(sourceMarket);

  let fxLabels = [];
  let fxPools = [];
  if(Array.isArray(lastPosLabels) && lastPosLabels.length && Array.isArray(lastTop8Pools) && lastTop8Pools.length === lastPosLabels.length){
    fxLabels = lastPosLabels.slice();
    fxPools = lastTop8Pools.map(p => Array.isArray(p) ? p.join('') : '');
  }

  const aiAC = rekapCleanList(document.getElementById('filterAiAC')?.value);
  const aiCK = rekapCleanList(document.getElementById('filterAiCK')?.value);
  const aiKE = rekapCleanList(document.getElementById('filterCB')?.value);

  const jumlah = rekapCleanList(document.getElementById('filterJumlah')?.value);
  const selisih = rekapCleanList(document.getElementById('filterSelisih')?.value);

  // Shio: pakai yang dicentang di Filter AI Shio 4D; kalau kosong, fallback ke Shio Rekomendasi (baris teratas)
  let shio = [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio);
  if(!shio.length && typeof shioCtReference !== 'undefined' && shioCtReference){
    shio = String(shioCtReference).split(',').map(s => s.trim()).filter(Boolean);
  }

  const twin = [];
  if(document.getElementById('filterExcludeHistory')?.checked) twin.push('angka yang sudah keluar');
  if(document.getElementById('filterHapus34')?.checked) twin.push('hapus 3-4');
  if(document.getElementById('twinModeExclude')?.checked) twin.push('hapus twin');

  // ── BARU: filter checkbox tambahan yang sebelumnya belum tercatat ──
  const extraFlags = [];
  if(document.getElementById('filterShortAC')?.checked) extraFlags.push('Short AC');
  if(document.getElementById('filterShortCK')?.checked) extraFlags.push('Short CK');
  if(document.getElementById('filterShortKE')?.checked) extraFlags.push('Short KE');
  if(document.getElementById('filterNoTwin')?.checked) extraFlags.push('Tanpa kembar');

  // Angka Ikut manual (filterAI) — sebelumnya belum tercatat
  const ai = rekapCleanList(document.getElementById('filterAI')?.value);

  const baseCount = Array.isArray(lastHistoryNumbers) ? lastHistoryNumbers.length : 0;

  // ── BARU: simpan periode + noUrut draw TERAKHIR saat rekap dibuat ──
  // Ini akan dipakai auto-fill: cari baris dengan noUrut = lastDrawUrutan+1 di data mendatang.
  // Baca langsung dari textarea (3 kolom: Tanggal TAB Periode TAB Angka).
  let lastDrawPeriode = null;  // mis. "HK-615"
  let lastDrawUrutan  = null;  // mis. 615 (angka saja)
  let lastDrawPrefix  = null;  // mis. "HK-" (bagian non-angka dari periode)
  try {
    const raw = document.getElementById('dataInput')?.value || '';
    const rows = parseStoredRows(raw).filter(r => r.periode && r.urutan !== null);
    if(rows.length){
      // Cari draw dengan urutan tertinggi = draw paling terakhir
      const latest = rows.reduce((a, b) => (b.urutan > a.urutan ? b : a));
      lastDrawPeriode = latest.periode;
      lastDrawUrutan  = latest.urutan;
      // Pakai rekapPeriodePrefix() (sumber kebenaran yang sama dipakai saat
      // pencocokan hasil) — sebelumnya di sini pakai regex sendiri yang
      // menghasilkan prefix beda ("HK-" vs "HK"), jadi targetId tidak pernah
      // match saat checkRekapAutoFill / checkRekapAutoFillAgainstFirebase jalan.
      lastDrawPrefix = rekapPeriodePrefix(latest.periode);
    }
  } catch(e) { /* tidak kritis */ }

  // ID rekap tunggal untuk pencocokan hasil: prefix + noUrut TARGET (urutan+1).
  // Dibuat sekali di sini, dipakai apa adanya oleh rekapMatchHasil — tidak
  // dihitung ulang di tempat lain supaya tidak ada peluang geser/miss.
  const targetId = (lastDrawPrefix !== null && lastDrawUrutan !== null)
    ? rekapMakeId(lastDrawPrefix, lastDrawUrutan + 1)
    : null;

  // ── BARU: filter Gen2 (Generator) — angka BAHAN mentah per slot, bukan angka jadi ──
  // Format per slot: "A:98765, C:16892, K:01928, E:12345" — persis pool digit
  // per posisi milik slot itu sendiri (tidak digabung/union antar slot, dan
  // bukan hasil kombinasi jadi). Slot yang tidak dikunci ditulis label saja
  // tanpa data.
  const gen2Active = !!document.getElementById('fxAutoFilterWorst')?.checked;
  // Kalau filter Gen2 aktif tapi Formula X belum pernah dihitung di sesi ini
  // (mis. user langsung Salin dari tab Filter tanpa mampir ke panel Formula X),
  // FX_RECOMMENDATIONS masih null sehingga fxBuildGen2Pools() gagal dan angka
  // mentah Gen2 tidak pernah muncul di rekap. Hitung otomatis sekali di sini —
  // hanya kalau BELUM pernah dihitung sama sekali, supaya pilihan formula
  // manual yang sudah ada tidak ikut ter-reset oleh computeFormulaX().
  if(gen2Active && !FX_RECOMMENDATIONS && Array.isArray(lastPosLabels) && lastPosLabels.length && lastHistoryNumbers.length){
    try{ computeFormulaX(lastHistoryNumbers, lastPosLabels); }catch(e){ /* biarkan gen2Lines fallback ke null di bawah */ }
  }
  const gen2Lines = gen2Active
    ? rekapGen2Lines(lastPosLabels, lastHistoryNumbers)
    : { A: null, B: null, C: null, live: null };

  return {
    id: 'rk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    tanggal: rekapTodayStr(),
    market,
    sourceMarket,
    baseCount,
    // ── field baru ──
    lastDrawPeriode,  // periode draw terakhir saat rekap dibuat, mis. "HK-615"
    lastDrawUrutan,   // noUrut draw terakhir, mis. 615
    lastDrawPrefix,   // prefix non-angka, mis. "HK-"
    targetId,         // ID rekap tunggal untuk pencocokan hasil, mis. "HK-#616"
    extraFlags,       // Short AC/CK/KE, Tanpa kembar
    ai,               // Angka Ikut manual (filterAI)
    gen2Active,       // status checkbox "Aktifkan filter Gen 2"
    gen2Lines,         // angka bahan per slot: {A, B, C, live}
    // ────────────────
    fxLabels, fxPools,
    aiAC, aiCK, aiKE,
    jumlah, selisih,
    shio, twin,
    hasil: null,
    ts: Date.now()
  };
}

// Susun teks rekap sesuai format yang diinginkan
function rekapEntryText(entry){
  const fxLine = entry.fxLabels.length
    ? entry.fxLabels.map((l, i) => `${l}: ${entry.fxPools[i] || '-'}`).join(' | ')
    : '-';
  const shioLine = (entry.shio && entry.shio.length) ? entry.shio.join(',') : '-';
  const twinLine = (entry.twin && entry.twin.length) ? entry.twin.join(' | ') : '-';
  const extraLine = (entry.extraFlags && entry.extraFlags.length) ? entry.extraFlags.join(' | ') : '-';

  // Gen2: satu baris per slot (a/b/c), angka BAHAN mentah saja — bukan digabung, bukan angka jadi.
  const gl = entry.gen2Lines || {};
  let gen2Block;
  if(!entry.gen2Active){
    gen2Block = ['Gen2 tidak aktif'];
  } else if(gl.live){
    gen2Block = [`Gen2 (live, belum dikunci) ${gl.live}`];
  } else {
    gen2Block = [
      `Gen2a${gl.A ? ' ' + gl.A : ''}`,
      `Gen2b${gl.B ? ' ' + gl.B : ''}`,
      `Gen2c${gl.C ? ' ' + gl.C : ''}`
    ];
  }

  const hasilLine = entry.hasil ? `Hasil: ${entry.hasil}` : 'Hasil: menunggu result.';
  // Tampilkan periode draw terakhir yang dijadikan basis prediksi
  const basisLine = entry.lastDrawPeriode
    ? `Basis data: ${entry.lastDrawPeriode} → prediksi ${entry.market}`
    : `Prediksi: ${entry.market}`;

  return [
    `${entry.tanggal}  ${entry.market}`,
    basisLine,
    `Formula x`,
    `|${fxLine}|`,
    ...gen2Block,
    `Filter yang di pilih`,
    `Ai |AC:${entry.aiAC || '-'} |CK: ${entry.aiCK || '-'} |KE:${entry.aiKE || '-'} |AI:${entry.ai || '-'} |`,
    `Selisih & jumlah`,
    `Selisih |${entry.selisih || '-'} | Jumlah | ${entry.jumlah || '-'}|`,
    `Shio`,
    shioLine,
    `Twin`,
    `${twinLine} |`,
    `Filter Tambahan`,
    `${extraLine} |`,
    ``,
    hasilLine
  ].join('\n');
}

// ── Highlight hasil di rekap: hijau = tepat kena (Formula X / Ai / Jumlah&Selisih), merah = kena Gen2 ──
// Ambil 4 digit terakhir dari hasil, dipetakan ke posisi A/C/K/E (sama seperti bagianOf4D:
// AC = 2 digit pertama, CK = digit ke-2 & ke-3, KE = 2 digit terakhir). null kalau hasil < 4 digit.
function rekapResultDigitsPerPosisi(hasil){
  const digits = String(hasil || '').replace(/[^0-9]/g, '');
  if(digits.length < 4) return null;
  const d4 = digits.slice(-4);
  return { A: d4[0], C: d4[1], K: d4[2], E: d4[3] };
}

// Bungkus digit yang ada di hitSet dengan span berwarna, di dalam sebuah string digit polos (mis. "98765").
function rekapColorDigits(poolStr, hitSet, cls){
  if(!poolStr) return poolStr;
  return poolStr.split('').map(ch => hitSet.has(ch) ? `<span class="${cls}">${ch}</span>` : ch).join('');
}

// Warnai satu baris Gen2 format "A:98765, C:16892, K:01928, E:12345" — merah di digit yang
// cocok dengan hasil PADA POSISI yang sama (label sebelum ":" menentukan posisi mana yang dicek).
function rekapColorGen2Line(lineStr, resultDigits){
  if(!lineStr) return '';
  return lineStr.split(', ').map(tok => {
    const idx = tok.indexOf(':');
    if(idx === -1) return rekapEscapeHtml(tok);
    const label = tok.slice(0, idx);
    const pool  = tok.slice(idx + 1);
    const target = resultDigits[label];
    const hitSet = target ? new Set([target]) : new Set();
    return `${rekapEscapeHtml(label)}:${rekapColorDigits(pool, hitSet, 'rekapHitRed')}`;
  }).join(', ');
}

// Versi rekapEntryText() yang sudah diberi highlight — dipakai HANYA saat entry.hasil sudah terisi
// dan bisa dipetakan ke 4 posisi (A/C/K/E). Strukturnya sengaja dibuat sama persis urutannya dengan
// rekapEntryText() supaya tampilan tidak berubah selain warnanya.
function rekapEntryHtmlHighlighted(entry, resultDigits){
  const esc = rekapEscapeHtml;

  // Formula X per posisi: hijau di digit pool yang sama dengan digit hasil pada posisi itu.
  const fxLine = entry.fxLabels.length
    ? entry.fxLabels.map((l, i) => {
        const pool = entry.fxPools[i] || '';
        const target = resultDigits[l];
        const hitSet = target ? new Set([target]) : new Set();
        return `${esc(l)}: ${pool ? rekapColorDigits(esc(pool), hitSet, 'rekapHitGreen') : '-'}`;
      }).join(' | ')
    : '-';

  // Ai AC/CK/KE/umum: hijau per digit yang cocok (OR per digit, bukan harus semua posisi cocok).
  const acHit = new Set([resultDigits.A, resultDigits.C].filter(Boolean));
  const ckHit = new Set([resultDigits.C, resultDigits.K].filter(Boolean));
  const keHit = new Set([resultDigits.K, resultDigits.E].filter(Boolean));
  const aiHit = new Set([resultDigits.A, resultDigits.C, resultDigits.K, resultDigits.E].filter(Boolean));
  const aiACColored = entry.aiAC ? rekapColorDigits(esc(entry.aiAC), acHit, 'rekapHitGreen') : '-';
  const aiCKColored = entry.aiCK ? rekapColorDigits(esc(entry.aiCK), ckHit, 'rekapHitGreen') : '-';
  const aiKEColored = entry.aiKE ? rekapColorDigits(esc(entry.aiKE), keHit, 'rekapHitGreen') : '-';
  const aiColored   = entry.ai   ? rekapColorDigits(esc(entry.ai),   aiHit, 'rekapHitGreen') : '-';

  // Jumlah & Selisih: hijau di nilai target yang cocok salah satu dari 3 nilai (AC/CK/KE) hasil.
  const d4 = resultDigits.A + resultDigits.C + resultDigits.K + resultDigits.E;
  const { jumlahList, selisihList } = jumlahSelisihList(d4);
  const jumlahSet  = new Set(jumlahList.map(String));
  const selisihSet = new Set(selisihList.map(String));
  const colorList = (raw, hitValueSet) => {
    if(!raw) return '-';
    return raw.split(',').map(v => {
      const t = v.trim();
      return hitValueSet.has(t) ? `<span class="rekapHitGreen">${esc(t)}</span>` : esc(t);
    }).join(',');
  };
  const jumlahColored  = colorList(entry.jumlah, jumlahSet);
  const selisihColored = colorList(entry.selisih, selisihSet);

  // Gen2: merah HANYA kalau ada slot 2A/2B/2C yang terkunci — live (belum dikunci) tidak diwarnai.
  const gl = entry.gen2Lines || {};
  let gen2Block;
  if(!entry.gen2Active){
    gen2Block = ['Gen2 tidak aktif'];
  } else if(gl.live){
    gen2Block = [`Gen2 (live, belum dikunci) ${esc(gl.live)}`];
  } else {
    gen2Block = [
      `Gen2a${gl.A ? ' ' + rekapColorGen2Line(gl.A, resultDigits) : ''}`,
      `Gen2b${gl.B ? ' ' + rekapColorGen2Line(gl.B, resultDigits) : ''}`,
      `Gen2c${gl.C ? ' ' + rekapColorGen2Line(gl.C, resultDigits) : ''}`
    ];
  }

  const shioLine  = (entry.shio && entry.shio.length) ? esc(entry.shio.join(',')) : '-';
  const twinLine  = (entry.twin && entry.twin.length) ? esc(entry.twin.join(' | ')) : '-';
  const extraLine = (entry.extraFlags && entry.extraFlags.length) ? esc(entry.extraFlags.join(' | ')) : '-';
  const basisLine = entry.lastDrawPeriode
    ? `Basis data: ${esc(entry.lastDrawPeriode)} → prediksi ${esc(entry.market)}`
    : `Prediksi: ${esc(entry.market)}`;
  const hasilDisplay = `Hasil: ${esc(entry.hasil)}`;

  return [
    `${esc(entry.tanggal)}  ${esc(entry.market)}`,
    basisLine,
    `Formula x`,
    `|${fxLine}|`,
    ...gen2Block,
    `Filter yang di pilih`,
    `Ai |AC:${aiACColored} |CK: ${aiCKColored} |KE:${aiKEColored} |AI:${aiColored} |`,
    `Selisih & jumlah`,
    `Selisih |${selisihColored} | Jumlah | ${jumlahColored}|`,
    `Shio`,
    shioLine,
    `Twin`,
    `${twinLine} |`,
    `Filter Tambahan`,
    `${extraLine} |`,
    ``,
    `<span class="rekapHasilLine">${hasilDisplay}</span>`
  ].join('\n');
}

// Tampilan ringkas: cuma label periode + status. Detail lengkap baru muncul saat baris diklik.
function renderRekapList(){
  const list = document.getElementById('rekapList');
  const empty = document.getElementById('rekapEmptyNote');
  const badge = document.getElementById('rekapCountBadge');
  if(!list) return;
  if(badge) badge.textContent = `${rekapEntries.length} catatan`;

  if(!rekapEntries.length){
    list.innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';

  list.innerHTML = rekapEntries.map(entry => {
    // Kalau hasil sudah diisi dan bisa dipetakan ke 4 posisi (A/C/K/E), pakai versi ber-highlight
    // (hijau: Formula X/Ai/Jumlah&Selisih tepat kena; merah: Gen2 yang terkunci kena di posisinya).
    const resultDigits = entry.hasil ? rekapResultDigitsPerPosisi(entry.hasil) : null;
    let bodyHtml;
    if(resultDigits){
      bodyHtml = rekapEntryHtmlHighlighted(entry, resultDigits);
    } else {
      const text = rekapEntryText(entry);
      const hasilDisplay = entry.hasil ? `Hasil: ${entry.hasil}` : 'Hasil: menunggu result.';
      const hasilClass = entry.hasil ? 'rekapHasilLine' : 'rekapHasilLine waiting';
      bodyHtml = rekapEscapeHtml(text).replace(
        /Hasil:.*/,
        `<span class="${hasilClass}">${rekapEscapeHtml(hasilDisplay)}</span>`
      );
    }
    const statusChip = entry.hasil
      ? `<span class="rekapStatus done">${rekapEscapeHtml(entry.hasil)}</span>`
      : `<span class="rekapStatus waiting">menunggu</span>`;
    return `
      <div class="rekapItem" data-id="${entry.id}">
        <div class="rekapHead" data-action="toggle">
          <div class="rekapTitle">${rekapEscapeHtml(entry.market)}</div>
          <div class="rekapHeadRight">
            ${statusChip}
            <button type="button" class="rekapMenuBtn" data-action="menu" title="Menu">☰</button>
          </div>
        </div>
        <div class="rekapBodyWrap" id="rekapBodyWrap_${entry.id}">
          <pre class="rekapBody">${bodyHtml}</pre>
          <div class="rekapActions" id="rekapActions_${entry.id}">
            <input type="text" inputmode="numeric" maxlength="6" placeholder="Isi angka result, mis. 4821" id="rekapHasilInput_${entry.id}" value="${entry.hasil ? rekapEscapeHtml(entry.hasil) : ''}">
            <button type="button" class="btn primary" data-action="saveHasil">Simpan Hasil</button>
            <button type="button" class="btn" data-action="copy">Salin</button>
            <button type="button" class="btn" data-action="delete" style="border-color:var(--rose); color:var(--rose);">Hapus</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function addRekapEntry(){
  const entry = buildRekapEntry();
  rekapEntries.unshift(entry);
  saveRekapEntries(rekapEntries);
  renderRekapList();
}

// Buang catatan yang sudah lebih dari 48 jam
function pruneExpiredRekap(){
  const now = Date.now();
  const before = rekapEntries.length;
  rekapEntries = rekapEntries.filter(en => (now - (en.ts || 0)) < REKAP_TTL_MS);
  if(rekapEntries.length !== before){
    saveRekapEntries(rekapEntries);
    return true;
  }
  return false;
}

// ── Helper: parse semua baris 3-kolom dari raw data, return Map urutan→nomor ──
// Dipakai oleh kedua fungsi auto-fill untuk exact match berdasarkan noUrut.
function rekapBuildUrutanMap(raw){
  const map = new Map(); // urutan (int) → nomor (string)
  try {
    parseStoredRows(raw).forEach(r => {
      if(r.urutan !== null && r.nomor) map.set(r.urutan, r.nomor);
    });
  } catch(e) {}
  return map;
}

// ── Pencocokan hasil TUNGGAL, dipakai bersama oleh jalur lokal (checkRekapAutoFill)
// dan jalur Firebase (checkRekapAutoFillAgainstFirebase) — supaya cuma ada SATU
// logika penentuan hasil, tidak dua yang bisa saling miss/beda hasil.
// prefixForMap: prefix pasaran milik urutanMap yang diberikan (dipakai untuk
// membangun ulang targetId dengan prefix yang sama persis seperti saat entry dibuat).
function rekapMatchHasil(entry, urutanMap, prefixForMap){
  if(!entry.targetId) return null;
  const targetUrutan = entry.lastDrawUrutan + 1;
  const id = rekapMakeId(prefixForMap, targetUrutan);
  if(id !== entry.targetId) return null; // prefix beda pasaran, bukan target entry ini
  const found = urutanMap.get(targetUrutan);
  return (found && /^\d{2,5}$/.test(found)) ? found : null;
}

// Dipanggil tiap kali jumlah data historis berubah (input manual, Firebase auto-sync).
// Logika: cocokkan via targetId (prefix+noUrut target) → exact match, tidak menebak.
// Fallback ke baseCount hanya untuk entry rekap lama (tidak punya targetId).
function checkRekapAutoFill(){
  if(!rekapEntries.length) return;
  const nowMarket = rekapCurrentMarketLabel();
  if(!lastHistoryNumbers.length) return;

  // Bangun map urutan→nomor dari textarea yang sedang aktif
  const raw = document.getElementById('dataInput')?.value || '';
  const urutanMap = rekapBuildUrutanMap(raw);
  const nowPrefix = rekapPeriodePrefix(nowMarket);

  let changed = false;
  rekapEntries.forEach(entry => {
    if(entry.hasil) return;
    if(entry.sourceMarket !== nowMarket) return;

    if(entry.targetId){
      // ── CARA BARU: exact match by targetId (prefix+noUrut target) ──
      const found = rekapMatchHasil(entry, urutanMap, nowPrefix);
      if(found){
        entry.hasil = found;
        changed = true;
      }
    } else {
      // ── FALLBACK untuk rekap lama (tanpa targetId) ──
      const nowCount = lastHistoryNumbers.length;
      const diff = nowCount - (entry.baseCount || 0);
      if(diff >= 1){
        const chosen = lastHistoryNumbers[0]; // asumsi newest-first
        if(chosen && /^\d{2,5}$/.test(chosen)){
          entry.hasil = chosen;
          changed = true;
        }
      }
    }
  });
  if(changed){
    saveRekapEntries(rekapEntries);
    renderRekapList();
  }
}

document.getElementById('rekapList')?.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('[data-action]');
  const itemEl = e.target.closest('.rekapItem');
  if(!itemEl || !actionBtn) return;
  const id = itemEl.dataset.id;
  const action = actionBtn.dataset.action;

  if(action === 'toggle'){
    const wrap = document.getElementById(`rekapBodyWrap_${id}`);
    if(wrap) wrap.classList.toggle('open');
    return;
  }
  if(action === 'menu'){
    const wrap = document.getElementById(`rekapBodyWrap_${id}`);
    const actions = document.getElementById(`rekapActions_${id}`);
    if(wrap && !wrap.classList.contains('open')) wrap.classList.add('open');
    if(actions) actions.classList.toggle('open');
    return;
  }
  if(action === 'saveHasil'){
    const input = document.getElementById(`rekapHasilInput_${id}`);
    const val = rekapCleanList(input?.value);
    const entry = rekapEntries.find(en => en.id === id);
    if(entry){
      entry.hasil = val || null;
      saveRekapEntries(rekapEntries);
      renderRekapList();
    }
    return;
  }
  if(action === 'copy'){
    const entry = rekapEntries.find(en => en.id === id);
    if(!entry) return;
    const text = rekapEntryText(entry);
    navigator.clipboard.writeText(text).then(() => {
      actionBtn.textContent = 'Tersalin ✓';
      setTimeout(() => { actionBtn.textContent = 'Salin'; }, 1400);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
    });
    return;
  }
  if(action === 'delete'){
    if(!confirm('Hapus catatan rekap ini?')) return;
    rekapEntries = rekapEntries.filter(en => en.id !== id);
    saveRekapEntries(rekapEntries);
    renderRekapList();
    return;
  }
});

// Pantau perubahan jumlah data historis (#totalCount sudah dipakai badge lain di atas) untuk trigger auto-isi Hasil
// — ini menangani kasus data diketik/diinput manual saat pasaran yang bersangkutan sedang aktif dilihat.
(function(){
  const src = document.getElementById('totalCount');
  if(!src) return;
  new MutationObserver(checkRekapAutoFill).observe(src, { childList: true, characterData: true, subtree: true });
})();

// Parsing data Firebase → Map urutan→nomor (untuk auto-fill lintas pasaran)
function rekapParseFirebaseToUrutanMap(raw){
  return rekapBuildUrutanMap(raw);
}

// Auto-isi Hasil lintas pasaran via Firebase — exact match by noUrut.
function checkRekapAutoFillAgainstFirebase(){
  if(!rekapEntries.length) return;
  if(typeof firebaseMarketMap === 'undefined' || !firebaseMarketMap) return;
  let changed = false;

  rekapEntries.forEach(entry => {
    if(entry.hasil) return;
    if(!entry.targetId) return; // rekap lama tanpa targetId, skip (biar checkRekapAutoFill yg fallback)

    // Cocokkan ke Firebase key menggunakan prefix pasaran
    const prefix = rekapPeriodePrefix(entry.sourceMarket);
    if(!prefix) return;

    let marketEntry = firebaseMarketMap[prefix]
      || firebaseMarketMap[Object.keys(firebaseMarketMap).find(k =>
          k.toLowerCase() === prefix.toLowerCase()
        ) || '']
      || firebaseMarketMap[Object.keys(firebaseMarketMap).find(k =>
          k.toLowerCase().startsWith(prefix.toLowerCase()) ||
          prefix.toLowerCase().startsWith(k.toLowerCase())
        ) || ''];

    if(!marketEntry || typeof marketEntry.data !== 'string' || !marketEntry.data.trim()) return;

    // Bangun map urutan→nomor dari data Firebase pasaran ini
    const urutanMap = rekapParseFirebaseToUrutanMap(marketEntry.data);
    if(!urutanMap.size) return;

    // ── Exact match by targetId, lewat fungsi pencocokan bersama ──
    const found = rekapMatchHasil(entry, urutanMap, prefix);
    if(found){
      entry.hasil = found;
      changed = true;
    }
  });

  if(changed){
    saveRekapEntries(rekapEntries);
    renderRekapList();
  }
}

// Sisipkan pemanggilan checkRekapAutoFillAgainstFirebase() setiap kali Firebase menerima data master baru,
// baik saat load pertama maupun tiap kali ada update live — supaya jalan otomatis walau tab pasaran sudah dipindah.
if(typeof firebaseReceiveMasterData === 'function'){
  const _origFirebaseReceiveMasterData = firebaseReceiveMasterData;
  firebaseReceiveMasterData = function(value, auto){
    _origFirebaseReceiveMasterData(value, auto);
    checkRekapAutoFillAgainstFirebase();
  };
}

// Bersihkan rekap kedaluwarsa (>48 jam) tiap 5 menit selagi halaman terbuka
setInterval(() => { if(pruneExpiredRekap()) renderRekapList(); }, 5 * 60 * 1000);

pruneExpiredRekap();
renderRekapList();

// ============================================================
// AUTO GENERATOR FORMULA X — v3
// Gen 1 : pool terbaik (% tertinggi), bisa dikunci
// Gen 2A/2B/2C : 3 slot filter eliminasi berlapis, masing-masing bisa dikunci
// Auto-unlock semua saat pasaran berganti
// ============================================================
setupSectionToggle('fxAutoGenToggle', 'fxAutoGenWrap', 'fxAutoGenToggleIcon');

// ── State Gen 1 ──
let fxGen1Locked = false;
let fxGen1LockedPools = null;
let fxGen1LockedPosLabels = null;
let fxGen1LockedFP = '';

// ── State Gen 2 (A/B/C) ──
const FX_GEN2_SLOTS = ['A','B','C'];
const fxGen2State = {
  A: { locked:false, pools:null, posLabels:null, fp:'', rule:null },
  B: { locked:false, pools:null, posLabels:null, fp:'', rule:null },
  C: { locked:false, pools:null, posLabels:null, fp:'', rule:null },
};

// Fingerprint data historis untuk deteksi ganti pasaran
function dataFingerprint(used){
  if(!used || !used.length) return '';
  return used.length+'|'+used[0]+'|'+used[used.length-1];
}

// Build pool dari Formula X
function fxBuildGen1Pools(posLabels, used){
  if(!FX_FORMULAS_CACHE || !FX_RECOMMENDATIONS) return null;
  const byKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { byKey[f.key]=f; });
  const pools = [];
  for(let i=0; i<posLabels.length; i++){
    const recs = FX_RECOMMENDATIONS[posLabels[i]] || [];
    if(!recs.length) return null;
    // Pakai varian yang sedang DIPILIH manual di panel Formula X (FX_SELECTED) untuk
    // posisi ini — supaya Gen 1 ikut berubah begitu radio diganti. Fallback ke rangking
    // #1 (persentase tertinggi) kalau posisi ini belum pernah dipilih user sama sekali.
    const selectedKey = FX_SELECTED[posLabels[i]];
    const chosenRec = recs.find(r => r.key === selectedKey) || recs[0];
    const f = byKey[chosenRec.key];
    let pool = [];
    if(f){ try{ pool = f.fn(used)[i]||[]; }catch(e){} }
    pools.push(pool.length ? pool : ['0']);
  }
  return pools;
}

// ── PATEN GEN 2 (baru): tiap slot punya PERINGKAT TERBURUK tetap, tidak lagi ikut
// posisi Formula X yang dipilih manual (selected/touched). 2A = terburuk ke-1 (paling
// buncit), 2B = terburuk ke-2, 2C = terburuk ke-3 — membentuk 3 lapis eliminasi yang
// otomatis berbeda tanpa perlu geser radio manual.
const WORST_RANK_BY_SLOT = { A: 1, B: 2, C: 3 };

// Ambil formula dari daftar rekomendasi (sudah diurutkan dari akurasi TERTINGGI ke
// TERENDAH) sesuai peringkat TERBURUK ke-N. rank=1 → paling akhir/buncit, rank=2 →
// kedua dari akhir, dst. Kalau daftar lebih pendek dari rank, fallback ke yang paling awal.
function pickWorstRank(list, rank){
  if(!list || !list.length) return null;
  const idx = list.length - rank;
  return list[idx >= 0 ? idx : 0];
}

// Hitung pool Gen2 untuk SATU slot memakai Formula X yang SEDANG aktif/tampil di layar
// (FX_RECOMMENDATIONS live) — dipakai saat tombol Kunci 2A/2B/2C diklik manual.
function fxBuildGen2PoolsLive(slot, posLabels, used){
  if(!FX_FORMULAS_CACHE || !FX_RECOMMENDATIONS) return null;
  const byKey = {};
  FX_FORMULAS_CACHE.formulas.forEach(f => { byKey[f.key]=f; });
  const rank = WORST_RANK_BY_SLOT[slot] || 1;
  const pools = [];
  for(let i=0; i<posLabels.length; i++){
    const label = posLabels[i];
    const list = FX_RECOMMENDATIONS[label] || [];
    if(!list.length){ pools.push([]); continue; }
    const chosen = pickWorstRank(list, rank);
    const f = chosen ? byKey[chosen.key] : null;
    let pool = [];
    if(f){ try{ pool = f.fn(used)[i]||[]; }catch(e){} }
    pools.push(pool);
  }
  return pools;
}

// Versi "murni" dari computeFormulaX: menghitung rekomendasi Formula X untuk trendN/controlN/outN
// TERTENTU (bukan yang sedang tampil di dropdown), TANPA mengubah FX_RECOMMENDATIONS / FX_SELECTED /
// FX_TOUCHED / FX_FORMULAS_CACHE / tampilan layar yang sedang aktif. Ini dipakai supaya tiap slot
// Gen 2 (2A/2B/2C) bisa dihitung ulang persis sesuai Tren N/Control N/Out N miliknya sendiri
// masing-masing — walau slot lain atau layar utama sedang pakai kombinasi lain.
function computeFormulaXPure(used, posLabels, trendNRaw, controlNRaw, outNRaw){
  const outN = parseInt(outNRaw, 10) || 8;
  const controlN = controlNRaw === 'all' ? Infinity : parseInt(controlNRaw, 10);
  const trendN = trendNRaw === 'all' ? Infinity : parseInt(trendNRaw, 10);
  // PENTING: FX_OUT_N harus sudah = outN SEBELUM formula di-ranking (fxTrendAccuracy di bawah
  // memakai FX_OUT_N global untuk memotong pool tiap formula saat mengecek hit/miss). Kalau
  // di-set belakangan (setelah ranking), ranking akan memakai FX_OUT_N basi/sisa sesi
  // sebelumnya (bug lama: dampaknya kelihatan saat Gen2 dihitung ulang lewat Preset — formula
  // "terburuk" yang kepilih bisa beda dari hasil manual Hitung Ulang, walau Out N yang tampil
  // di label sama).
  const prevOutNForRanking = FX_OUT_N;
  FX_OUT_N = outN;
  const chronoNum = used.slice().reverse();
  const formulas = fxBuildFormulaList(posLabels, controlN);
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
  FX_OUT_N = prevOutNForRanking; // pulihkan — pemanggil (mis. fxBuildGen2PoolsForSlot) yang mengatur FX_OUT_N saat memotong pool akhir
  return { recs, formulas, outN };
}

// Bangun pool satu slot Gen 2 dari RULE tersimpan (trendN/controlN/outN milik slot itu
// sendiri) + peringkat terburuk tetap sesuai slotnya (lihat WORST_RANK_BY_SLOT) — bukan
// dari konfigurasi Formula X yang sedang aktif di layar, dan bukan dari selected/touched.
function fxBuildGen2PoolsForSlot(slot, posLabels, used, rule){
  if(!rule) return null;
  const { recs, formulas, outN } = computeFormulaXPure(used, posLabels, rule.trendN, rule.controlN, rule.outN);
  const byKey = {};
  formulas.forEach(f => { byKey[f.key] = f; });
  const rank = WORST_RANK_BY_SLOT[slot] || 1;
  const prevOutN = FX_OUT_N;
  FX_OUT_N = outN; // sementara — dipulihkan lagi di finally, tidak mengganggu tampilan/slot lain
  try{
    const pools = [];
    for(let i=0; i<posLabels.length; i++){
      const label = posLabels[i];
      const list = recs[label] || [];
      if(!list.length){ pools.push([]); continue; }
      const chosen = pickWorstRank(list, rank);
      const f = chosen ? byKey[chosen.key] : null;
      let pool = [];
      if(f){ try{ pool = f.fn(used)[i] || []; }catch(e){} }
      pools.push(pool);
    }
    return pools;
  } finally {
    FX_OUT_N = prevOutN;
  }
}

// Coba terapkan aturan tersimpan (s.rule) satu slot Gen2 memakai data TERKINI.
// Dipanggil saat: (1) periode/data berganti & slot ini sedang terkunci, (2) preset dimuat,
// (3) Data Historis baru selesai diproses padahal sebelumnya slot ini masih "menunggu data".
// Return true kalau berhasil dihitung & dikunci ulang.
function fxApplyGen2Rule(slot){
  const s = fxGen2State[slot];
  if(!s.rule) return false;
  if(!lastPosLabels || !lastPosLabels.length || !lastHistoryNumbers.length) return false;
  const pools = fxBuildGen2PoolsForSlot(slot, lastPosLabels, lastHistoryNumbers, s.rule);
  if(!pools || pools.some(p => !p.length)) return false;
  s.locked = true;
  s.pools = pools;
  s.posLabels = lastPosLabels.slice();
  s.fp = dataFingerprint(lastHistoryNumbers);
  return true;
}

// Ambil angka BAHAN mentah satu slot Gen2 saja (tidak digabung dgn slot lain).
// Format per posisi: "A:98765, C:16892, K:01928, E:12345". null kalau slot
// tidak dikunci / belum ada poolnya.
function rekapGen2SlotLine(slot, posLabels){
  const s = fxGen2State[slot];
  if(!s || !s.locked || !Array.isArray(s.pools)) return null;
  if(!s.pools.some(p => Array.isArray(p) && p.length)) return null;
  return posLabels.map((l, i) => `${l}:${(s.pools[i] || []).join('')}`).join(', ');
}

// Kumpulkan angka bahan Gen2 untuk Rekap: satu baris per slot (A/B/C), TANPA
// digabung/union — supaya benar-benar "bahan", bukan "jadi". Kalau tidak ada
// satupun slot yang dikunci tapi filter Gen2 tetap dicentang aktif, sertakan
// pool live sebagai catatan tambahan (field terpisah: live).
function rekapGen2Lines(posLabels, used){
  const lines = { A: null, B: null, C: null, live: null };
  if(!Array.isArray(posLabels) || !posLabels.length) return lines;

  let anyLocked = false;
  FX_GEN2_SLOTS.forEach(sl => {
    const line = rekapGen2SlotLine(sl, posLabels);
    lines[sl] = line;
    if(line) anyLocked = true;
  });

  if(!anyLocked){
    const livePools = fxBuildGen2PoolsLive('A', posLabels, used);
    if(livePools && livePools.some(p => Array.isArray(p) && p.length)){
      lines.live = posLabels.map((l, i) => `${l}:${(livePools[i] || []).join('')}`).join(', ');
    }
  }
  return lines;
}

// Render chip digit per posisi
function renderDigitsRow(elId, pools, posLabels, color){
  const row = document.getElementById(elId);
  if(!row) return;
  if(!pools || !posLabels){
    row.innerHTML = '<span style="font-size:11px;color:var(--ink-dim);">Hitung Frekuensi dulu.</span>';
    return;
  }
  row.innerHTML = posLabels.map((lbl,i)=>{
    const d = (pools[i]||[]).join('');
    return `<div style="background:var(--panel);border:1px solid ${color};border-radius:8px;padding:5px 9px;text-align:center;min-width:48px;">
      <div style="font-size:9px;color:${color};text-transform:uppercase;font-weight:700;margin-bottom:2px;">${lbl}</div>
      <div style="font-family:var(--mono);font-size:13px;font-weight:800;color:var(--ink);">${d||'-'}</div>
    </div>`;
  }).join('');
}

// ── Render Gen 1 Lock UI ──
function renderGen1LockUI(){
  const btn   = document.getElementById('fxGen1LockBtn');
  const badge = document.getElementById('fxGen1LockBadge');
  const note  = document.getElementById('fxGen1LockedNote');
  const card  = document.getElementById('fxGen1Card');
  if(!btn) return;
  if(fxGen1Locked){
    btn.textContent = '🔓 UNLOCK GEN 1';
    btn.style.cssText += 'border-color:var(--amber);color:var(--amber);';
    badge.style.display = 'inline';
    note.style.display  = 'block';
    card.style.borderColor = 'var(--amber)';
    renderDigitsRow('fxGen1DigitsRow', fxGen1LockedPools, fxGen1LockedPosLabels, 'var(--amber)');
  } else {
    btn.textContent = '🔒 LOCK GEN 1';
    btn.style.cssText += 'border-color:var(--teal);color:var(--teal);';
    badge.style.display = 'none';
    note.style.display  = 'none';
    card.style.borderColor = 'var(--teal)';
    if(lastPosLabels && lastHistoryNumbers.length && FX_RECOMMENDATIONS)
      renderDigitsRow('fxGen1DigitsRow', fxBuildGen1Pools(lastPosLabels, lastHistoryNumbers), lastPosLabels, 'var(--teal)');
    else renderDigitsRow('fxGen1DigitsRow', null, null, 'var(--teal)');
  }
}

// ── Render Gen 2 Lock UI per slot ──
function renderGen2LockUI(slot){
  const s     = fxGen2State[slot];
  const btn   = document.getElementById('fxGen2'+slot+'LockBtn');
  const badge = document.getElementById('fxGen2'+slot+'LockBadge');
  const note  = document.getElementById('fxGen2'+slot+'LockedNote');
  const card  = document.getElementById('fxGen2'+slot+'Card');
  const info  = document.getElementById('fxGen2'+slot+'RuleInfo');
  if(!btn) return;
  const rankLabel = 'terburuk ke-' + (WORST_RANK_BY_SLOT[slot] || 1);
  if(s.locked){
    btn.textContent = '🔓 UNLOCK 2'+slot;
    btn.style.cssText += 'border-color:var(--rose);color:var(--rose);background:rgba(217,112,122,.12);';
    badge.style.display = 'inline';
    note.style.display  = 'block';
    card.style.borderColor = 'var(--rose)';
    renderDigitsRow('fxGen2'+slot+'DigitsRow', s.pools, s.posLabels, 'var(--rose)');
    if(info){
      const r = s.rule || {};
      const trendTxt = r.trendN === 'all' ? 'semua' : r.trendN;
      const controlTxt = r.controlN === 'all' ? 'semua' : r.controlN;
      info.textContent = `Tren N:${trendTxt} · Control N:${controlTxt} · Out N:${r.outN} · peringkat ${rankLabel}`;
    }
  } else {
    btn.textContent = '🔒 LOCK 2'+slot;
    btn.style.cssText += 'border-color:rgba(217,112,122,.6);color:var(--rose);background:transparent;';
    badge.style.display = 'none';
    note.style.display  = 'none';
    card.style.borderColor = 'rgba(217,112,122,.4)';
    if(info) info.textContent = `Akan pakai Tren/Control/Out yang sedang tampil di layar · peringkat ${rankLabel}`;
    // Tampilkan live preview Gen 2 (angka peringkat terburuk ke-N sesuai slot ini)
    if(lastPosLabels && lastHistoryNumbers.length && FX_RECOMMENDATIONS)
      renderDigitsRow('fxGen2'+slot+'DigitsRow', fxBuildGen2PoolsLive(slot, lastPosLabels, lastHistoryNumbers), lastPosLabels, 'rgba(217,112,122,.7)');
    else renderDigitsRow('fxGen2'+slot+'DigitsRow', null, null, 'var(--rose)');
  }
  // Update status berapa slot terkunci
  const lockedCount = FX_GEN2_SLOTS.filter(sl => fxGen2State[sl].locked).length;
  const statusEl = document.getElementById('fxGen2LockStatus');
  if(statusEl) statusEl.textContent = lockedCount
    ? lockedCount + ' dari 3 slot Gen 2 terkunci — akan dipakai sebagai filter berlapis.'
    : 'Belum ada slot Gen 2 yang dikunci.';
}

// ── Auto-unlock semua saat pasaran berganti ──
function fxAutoUnlockAll(){
  const fp = dataFingerprint(lastHistoryNumbers);
  if(!fp) return;
  if(fxGen1Locked && !fxGen1SemiAutoLocked && fp !== fxGen1LockedFP){
    fxGen1Locked=false; fxGen1LockedPools=null; fxGen1LockedPosLabels=null; fxGen1LockedFP='';
    renderGen1LockUI();
  }
  FX_GEN2_SLOTS.forEach(sl => {
    const s = fxGen2State[sl];
    // Slot yang punya rule tersimpan (baik masih terkunci dgn fp basi, ATAU baru dimuat dari
    // preset & belum sempat dihitung karena data belum siap) — coba hitung ulang dulu.
    if(s.rule && (!s.locked || fp !== s.fp)){
      const ok = fxApplyGen2Rule(sl);
      if(!ok && s.locked){ s.locked=false; s.pools=null; s.posLabels=null; s.fp=''; }
      renderGen2LockUI(sl);
    } else if(s.locked && !s.rule && fp !== s.fp){
      // Data lama (dikunci sebelum fitur rule ini ada) — fallback ke perilaku lama: unlock.
      s.locked=false; s.pools=null; s.posLabels=null; s.fp='';
      renderGen2LockUI(sl);
    }
  });
}

// ── Tombol Lock Gen 1 ──
document.getElementById('fxGen1LockBtn').addEventListener('click', ()=>{
  if(fxGen1Locked){
    fxGen1Locked=false; fxGen1LockedPools=null; fxGen1LockedPosLabels=null; fxGen1LockedFP='';
  } else {
    if(!FX_RECOMMENDATIONS||!lastPosLabels||!lastHistoryNumbers.length){ alert('Hitung Frekuensi dulu sebelum mengunci Gen 1.'); return; }
    const p = fxBuildGen1Pools(lastPosLabels, lastHistoryNumbers);
    if(!p){ alert('Formula X belum siap — coba Hitung Ulang.'); return; }
    fxGen1Locked=true; fxGen1LockedPools=p; fxGen1LockedPosLabels=lastPosLabels.slice(); fxGen1LockedFP=dataFingerprint(lastHistoryNumbers);
  }
  renderGen1LockUI();
});

// ── Tombol Lock Gen 2A/2B/2C ──
document.querySelectorAll('.fxGen2LockBtn').forEach(btn => {
  btn.addEventListener('click', ()=>{
    const slot = btn.dataset.slot;
    const s = fxGen2State[slot];
    if(s.locked){
      s.locked=false; s.pools=null; s.posLabels=null; s.fp=''; s.rule=null;
    } else {
      if(!FX_RECOMMENDATIONS||!lastPosLabels||!lastHistoryNumbers.length){ alert('Hitung Frekuensi dulu sebelum mengunci Gen 2'+slot+'.'); return; }
      const p = fxBuildGen2PoolsLive(slot, lastPosLabels, lastHistoryNumbers);
      if(!p || p.some(x=>!x.length)){ alert('Peringkat terburuk ke-'+WORST_RANK_BY_SLOT[slot]+' belum tersedia untuk salah satu posisi — coba Hitung Ulang dulu.'); return; }
      s.locked=true; s.pools=p; s.posLabels=lastPosLabels.slice(); s.fp=dataFingerprint(lastHistoryNumbers);
      // Simpan Tren N/Control N/Out N saat ini — supaya slot ini bisa dihitung ulang persis
      // dengan kombinasi yang sama kalau data/periode berganti atau preset dimuat lagi.
      // Peringkat terburuk (WORST_RANK_BY_SLOT) sudah tetap mengikuti slotnya sendiri.
      s.rule = {
        trendN: document.getElementById('fxTrendN').value,
        controlN: document.getElementById('fxControlN').value,
        outN: document.getElementById('fxOutN').value
      };
    }
    renderGen2LockUI(slot);
  });
});

// ── Fungsi utama Auto Generate ──
function fxAutoGenerate(){
  if(!FX_RECOMMENDATIONS||!lastPosLabels||!lastHistoryNumbers.length){
    alert('Hitung Frekuensi dulu.'); return;
  }

  const withFilter = document.getElementById('fxAutoFilterWorst').checked;

  // Gen 1
  const gen1Pools = (fxGen1Locked && fxGen1LockedPools)
    ? fxGen1LockedPools
    : fxBuildGen1Pools(lastPosLabels, lastHistoryNumbers);
  if(!gen1Pools){ alert('Formula X belum siap — coba Hitung Ulang.'); return; }

  const gen1Results = cartesianProduct(gen1Pools);

  // Gen 2A/B/C — kumpulkan semua angka dari slot yang terkunci (atau live jika tidak ada yg terkunci)
  let eliminasiSet = new Set();
  let gen2Details = {}; // untuk tampilan ringkasan

  if(withFilter){
    const lockedSlots = FX_GEN2_SLOTS.filter(sl => fxGen2State[sl].locked);
    const slotsToUse  = lockedSlots.length > 0 ? lockedSlots : []; // hanya pakai yang dikunci

    // Jika tidak ada yang dikunci, pakai live pools (Gen 2 tanpa lock)
    if(slotsToUse.length === 0){
      const livePools = fxBuildGen2PoolsLive('A', lastPosLabels, lastHistoryNumbers);
      if(livePools && livePools.some(p=>p.length)){
        const liveResults = cartesianProduct(livePools);
        liveResults.forEach(n => eliminasiSet.add(n));
        gen2Details['Live'] = liveResults.length;
      }
    } else {
      slotsToUse.forEach(sl => {
        const s = fxGen2State[sl];
        if(s.pools && s.pools.some(p=>p.length)){
          const r = cartesianProduct(s.pools);
          r.forEach(n => eliminasiSet.add(n));
          gen2Details[sl] = r.length;
        }
      });
    }
  }

  const eliminasi  = gen1Results.filter(n => eliminasiSet.has(n));
  const hasilAkhir = gen1Results.filter(n => !eliminasiSet.has(n));

  // ── Update UI ──
  document.getElementById('fxAutoGenSummary').style.display  = 'block';
  document.getElementById('fxAutoGenResultBox').style.display = 'block';
  document.getElementById('fxAutoGenStats').style.display    = 'flex';
  document.getElementById('fxAutoGenActions').style.display  = 'flex';

  // Gen 1 preview
  document.getElementById('fxGen1Preview').textContent =
    gen1Results.slice(0,16).join('*') + (gen1Results.length>16?'*…':'*');
  document.getElementById('fxGen1Count').textContent =
    gen1Results.length + ' kombinasi' + (fxGen1Locked?' 🔒':'');

  // Gen 2 ringkasan per slot
  const showNoGen2 = !withFilter || Object.keys(gen2Details).length===0;
  document.getElementById('fxSumNoGen2').style.display = showNoGen2 ? 'block' : 'none';
  FX_GEN2_SLOTS.forEach(sl => {
    const box = document.getElementById('fxSumGen2'+sl);
    if(gen2Details[sl]!==undefined){
      box.style.display='block';
      document.getElementById('fxSumGen2'+sl+'Count').textContent = gen2Details[sl]+' kombinasi 🔒';
    } else {
      box.style.display='none';
    }
  });

  // Eliminasi total
  const elimBox = document.getElementById('fxEliminasiBox');
  if(eliminasi.length){
    elimBox.style.display='block';
    document.getElementById('fxEliminasiList').textContent = eliminasi.slice(0,40).join('*')+(eliminasi.length>40?'*…':'*');
    document.getElementById('fxEliminasiCount').textContent = eliminasi.length+' angka dieliminasi dari '+Object.keys(gen2Details).length+' slot Gen 2';
  } else {
    elimBox.style.display='none';
  }

  // Hasil akhir
  const hasilText = hasilAkhir.join('*')+(hasilAkhir.length?'*':'');
  document.getElementById('fxAutoGenOut').value = hasilText;
  document.getElementById('fxAutoGenCount').textContent = hasilAkhir.length;
  document.getElementById('fxAutoEliminasiCount').textContent = eliminasi.length;

  lastTop8Pools = gen1Pools;
}

document.getElementById('fxAutoGenBtn').addEventListener('click', fxAutoGenerate);

document.getElementById('fxAutoGenCopyBtn').addEventListener('click', ()=>{
  const text = document.getElementById('fxAutoGenOut').value;
  if(!text) return;
  navigator.clipboard.writeText(text).then(()=>{
    const btn = document.getElementById('fxAutoGenCopyBtn');
    const orig = btn.textContent;
    btn.textContent='Tersalin ✓';
    setTimeout(()=>btn.textContent=orig, 1400);
  }).catch(()=>{ const ta=document.getElementById('fxAutoGenOut'); ta.select(); document.execCommand('copy'); });
});

document.getElementById('fxAutoGenToFilterBtn').addEventListener('click', ()=>{
  const text = document.getElementById('fxAutoGenOut').value;
  if(!text){ alert('Generate dulu sebelum mengirim ke Filter.'); return; }
  const hasilList = text.split('*').map(s=>s.trim()).filter(Boolean);
  if(!hasilList.length){ alert('Generate dulu sebelum mengirim ke Filter.'); return; }

  document.getElementById('combineOut').value = text;
  document.getElementById('combineCountOut').textContent = hasilList.length;

  // Pakai daftar hasil AKHIR (sudah dieliminasi Gen 2) apa adanya sebagai sumber Filter —
  // bukan lastTop8Pools (pool mentah Gen 1) — supaya angka yang sudah dieliminasi tidak
  // muncul lagi begitu masuk ke Filter Pangkas Kombinasi.
  filterCustomSource = hasilList;

  document.getElementById('filterCard').style.display = 'block';
  resetFilters();
  document.getElementById('filterCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── Hook: setiap Formula X selesai → auto-unlock pasaran & refresh UI ──
(function hookAutoGenRefresh(){
  const statusEl = document.getElementById('fxStatus');
  if(!statusEl) return;
  new MutationObserver(()=>{
    fxAutoUnlockAll();
    renderGen1LockUI();
    FX_GEN2_SLOTS.forEach(renderGen2LockUI);
  }).observe(statusEl, { childList:true, characterData:true, subtree:true });
})();

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

// ===================== PRESET PENGATURAN =====================
// Daftar semua kontrol "pengaturan" di seluruh sistem (bukan data mentah/hasil).
// Tambahkan entri baru di sini kalau nanti ada filter/opsi baru yang perlu ikut preset.
const PRESET_FIELDS = [
  // Formula X
  { id:'fxTrendN',   type:'select' },
  { id:'fxControlN', type:'select' },
  { id:'fxOutN',     type:'select' },
  { id:'fxAutoFilterWorst', type:'checkbox' },
  // Jumlah & Selisih
  { id:'jsRowsShown',      type:'select' },
  { id:'jsRecoCountJumlah', type:'select' },
  { id:'jsRecoCountSelisih', type:'select' },
  { id:'jsJumlahManual',   type:'text' },
  { id:'jsSelisihManual',  type:'text' },
  // Ai Ai (Angka Ikut)
  { id:'aiRowsShown',    type:'select' },
  { id:'aiDigitCount',   type:'select' },
  { id:'aiWinACManual',  type:'text' },
  { id:'aiWinCKManual',  type:'text' },
  { id:'aiWinKEManual',  type:'text' },
  // Colok Bebas
  { id:'cbMonthHistorySelect', type:'select' },
  // Shio
  { id:'shioPickCount',  type:'select' },
  { id:'shioRowsShown',  type:'select' },
  { id:'shioManual',     type:'text' },
  { id:'filterShioAll',  type:'checkbox' },
  // Filter Pangkas Kombinasi
  { id:'filterShortAC',       type:'checkbox' },
  { id:'filterShortCK',       type:'checkbox' },
  { id:'filterShortKE',       type:'checkbox' },
  { id:'filterNoTwin',        type:'checkbox' },
  { id:'filterExcludeHistory',type:'checkbox' },
  { id:'filterCB',        type:'text' },
  { id:'filterAI',        type:'text' },
  { id:'filterAiAC',      type:'text' },
  { id:'filterAiCK',      type:'text' },
  { id:'filterJumlah',    type:'text' },
  { id:'filterSelisih',   type:'text' },
  { id:'filterHapus34',   type:'checkbox' },
  { id:'twinMode', type:'radio', name:'twinMode' },
];

const PRESET_STORAGE_KEY = 'appPresets_v1';
const PRESET_MAX_COUNT = 2; // sesuai permintaan: cukup simpan 1-2 preset saja
let presetFirebaseReady = false;

function presetLoadAll(){
  try{ return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {}; }
  catch(e){ return {}; }
}
function presetSaveAll(all){
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(all));
  if(db){
    authReadyPromise.then(isAuthed => {
      if(!isAuthed) return;
      pendingCloudSyncCount++;
      db.ref('appPresets').set(all)
        .catch(e => {
          console.error('Gagal sync preset ke cloud:', e);
          const fb = document.getElementById('presetFeedback');
          if(fb){ fb.textContent = 'Tersimpan lokal, tapi gagal sync preset ke cloud (cek koneksi).'; fb.style.color = 'var(--rose)'; }
        })
        .finally(() => { pendingCloudSyncCount--; });
    });
  }
}

// Muat preset awal dari cloud, lalu dengarkan perubahan real-time (sinkron antar HP/browser)
if(db){
  authReadyPromise.then(isAuthed => {
    if(!isAuthed) return;
    db.ref('appPresets').once('value')
      .then(snap => {
        if(snap.exists()){
          localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(snap.val()));
        }
        presetFirebaseReady = true;
        renderPresetList();
      })
      .catch(e => console.error('Gagal ambil preset dari cloud, pakai data lokal:', e));

    db.ref('appPresets').on('value', snap => {
      if(!presetFirebaseReady) return; // hindari trigger ganda saat load pertama
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(snap.exists() ? snap.val() : {}));
      renderPresetList();
    });
  });
}

// Ambil nilai semua kontrol saat ini sesuai daftar PRESET_FIELDS
function presetCollectFields(){
  const data = {};
  PRESET_FIELDS.forEach(f=>{
    if(f.type === 'radio'){
      const checked = document.querySelector(`input[name="${f.name}"]:checked`);
      data[f.id] = checked ? checked.value : null;
      return;
    }
    const el = document.getElementById(f.id);
    if(!el) return;
    data[f.id] = (f.type === 'checkbox') ? el.checked : el.value;
  });
  return data;
}

// Terapkan nilai preset ke semua kontrol, sambil trigger event change/input
// supaya listener yang sudah ada (render ulang, dsb) tetap jalan seperti biasa.
function presetApplyFields(data){
  if(!data) return;
  PRESET_FIELDS.forEach(f=>{
    if(!(f.id in data) || data[f.id] === null || data[f.id] === undefined) return;
    if(f.type === 'radio'){
      const target = document.querySelector(`input[name="${f.name}"][value="${data[f.id]}"]`);
      if(target && !target.checked){
        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles:true }));
      }
      return;
    }
    const el = document.getElementById(f.id);
    if(!el) return;
    if(f.type === 'checkbox'){
      if(el.checked !== data[f.id]){
        el.checked = data[f.id];
        el.dispatchEvent(new Event('change', { bubbles:true }));
      }
    } else {
      el.value = data[f.id];
      el.dispatchEvent(new Event('change', { bubbles:true }));
      el.dispatchEvent(new Event('input',  { bubbles:true }));
    }
  });
}

// Ambil aturan Gen2 tiap slot (hanya slot yang sedang terkunci) untuk disimpan ke preset.
// Yang disimpan snapshot LENGKAP struktur Formula X (Tren N, Control N, Out N, posisi ACKE
// yang dipilih) — BUKAN angka mentahnya — karena angka mentah pasti berubah tiap ganti data/periode.
function presetCollectGen2(){
  const data = {};
  FX_GEN2_SLOTS.forEach(sl=>{
    const s = fxGen2State[sl];
    data[sl] = (s.locked && s.rule) ? {
      trendN: s.rule.trendN, controlN: s.rule.controlN, outN: s.rule.outN
    } : null;
  });
  return data;
}

// Terapkan aturan Gen2 dari preset (paten baru): buka kunci dulu, lalu hitung ulang pakai
// Tren N/Control N/Out N yang tersimpan di preset untuk slot ini — peringkat terburuk yang
// diambil otomatis mengikuti slotnya (2A=ke-1, 2B=ke-2, 2C=ke-3, lihat WORST_RANK_BY_SLOT) —
// lalu kunci lagi. Kalau Data Historis sudah siap saat ini, langsung dihitung & dikunci;
// kalau belum, aturan tetap disimpan (s.rule) dan otomatis diterapkan begitu Data Historis
// selesai diproses (lewat fxAutoUnlockAll).
function presetApplyGen2(data){
  FX_GEN2_SLOTS.forEach(sl=>{
    const s = fxGen2State[sl];
    // 1) buka kunci dulu
    s.locked=false; s.pools=null; s.posLabels=null; s.fp='';
    const entry = data && data[sl];
    if(entry){
      // 2) set rule (Tren N/Control N/Out N seperti terakhir disimpan)
      s.rule = { trendN: entry.trendN, controlN: entry.controlN, outN: entry.outN };
      // 3) "hitung ulang" (murni, tanpa mengubah dropdown yang tampil) & 4) kunci lagi kalau berhasil
      fxApplyGen2Rule(sl);
    } else {
      s.rule=null;
    }
    renderGen2LockUI(sl);
  });
}

function presetSave(name){
  if(!name) return false;
  const all = presetLoadAll();
  if(!(name in all) && Object.keys(all).length >= PRESET_MAX_COUNT){
    alert(`Maksimal ${PRESET_MAX_COUNT} preset tersimpan. Hapus salah satu dulu sebelum menambah preset baru.`);
    return false;
  }
  all[name] = { savedAt: Date.now(), fields: presetCollectFields(), gen2: presetCollectGen2() };
  presetSaveAll(all);
  return true;
}
function presetLoad(name){
  const all = presetLoadAll();
  if(!all[name]) return false;
  presetApplyFields(all[name].fields);
  presetApplyGen2(all[name].gen2 || null);
  return true;
}
function presetDelete(name){
  const all = presetLoadAll();
  delete all[name];
  presetSaveAll(all);
}

const ACTIVE_PRESET_KEY = 'activePresetName_v1';
function getActivePresetName(){ return localStorage.getItem(ACTIVE_PRESET_KEY) || ''; }
function setActivePresetName(name){
  if(name) localStorage.setItem(ACTIVE_PRESET_KEY, name);
  else localStorage.removeItem(ACTIVE_PRESET_KEY);
}

function renderPresetList(){
  const all = presetLoadAll();
  const names = Object.keys(all);
  document.getElementById('presetCountBadge').textContent = names.length + '/' + PRESET_MAX_COUNT + ' preset';

  // Isi ulang dropdown "Preset Aktif", pertahankan pilihan yang masih valid.
  const sel = document.getElementById('activePresetSelect');
  const prevActive = getActivePresetName();
  sel.innerHTML = '<option value="">— Belum dipilih —</option>' +
    names.map(n => `<option value="${n}">${n}</option>`).join('');
  if(names.includes(prevActive)){
    sel.value = prevActive;
  } else {
    setActivePresetName('');
  }

  const wrap = document.getElementById('presetList');
  const empty = document.getElementById('presetEmptyNote');
  wrap.innerHTML = '';
  if(!names.length){ empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  names.forEach(name=>{
    const item = document.createElement('div');
    item.className = 'saveditem';
    const savedDate = new Date(all[name].savedAt).toLocaleString('id-ID');
    item.innerHTML = `
      <div class="info">
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <div class="actions">
        <button class="load">Muat</button>
        <button class="del">Hapus</button>
      </div>`;
    item.querySelector('.name').textContent = name;
    item.querySelector('.meta').textContent = savedDate;
    item.querySelector('.load').addEventListener('click', ()=>{
      presetLoad(name);
      // PENTING: preset yang dimuat lewat tombol "Muat" ini juga dijadikan "Preset Aktif" —
      // sebelumnya tombol ini cuma numpahin nilainya ke layar SEKALI tanpa mengubah Preset
      // Aktif, jadi begitu Mode Semi/Auto jalan lagi (mis. ganti pasaran), field ini ketiban
      // balik oleh preset lama yang masih tercatat aktif di background (bug: nilai yang baru
      // dimuat/disimpan seolah "balik sendiri" ke preset lain tiap ganti pasaran).
      setActivePresetName(name);
      renderPresetList();
      document.getElementById('presetFeedback').textContent = `Preset "${name}" dimuat & dijadikan Preset Aktif — semua filter sudah terisi.`;
    });
    item.querySelector('.del').addEventListener('click', ()=>{
      if(!confirm(`Hapus preset "${name}"?`)) return;
      presetDelete(name);
      document.getElementById('presetFeedback').textContent = `Preset "${name}" dihapus.`;
      renderPresetList();
    });
    wrap.appendChild(item);
  });
}

document.getElementById('activePresetSelect').addEventListener('change', (e)=>{
  setActivePresetName(e.target.value);
  document.getElementById('presetFeedback').textContent = e.target.value
    ? `Preset aktif diset ke "${e.target.value}".`
    : 'Preset aktif dikosongkan.';
});

document.getElementById('presetSaveBtn').addEventListener('click', ()=>{
  const nameInput = document.getElementById('presetNameInput');
  const name = nameInput.value.trim();
  if(!name){ alert('Isi nama preset dulu, mis. "KR Standar".'); return; }
  const ok = presetSave(name);
  if(!ok) return;
  nameInput.value = '';
  document.getElementById('presetFeedback').textContent = `Preset "${name}" tersimpan.`;
  renderPresetList();
});

renderPresetList();

// ===================== MODE: NORMAL / SEMI AUTO / AUTO =====================
const APP_MODE_KEY = 'appMode_v1';
let fxGen1SemiAutoLocked = false; // true saat Gen 1 dikunci lewat popup Semi Auto (bukan lewat formula)

function getAppMode(){ return localStorage.getItem(APP_MODE_KEY) || 'normal'; }
function setAppMode(mode){
  localStorage.setItem(APP_MODE_KEY, mode);
  document.querySelectorAll('.modeBtn').forEach(b=>{
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function unlockGen1Gen2(){
  fxGen1Locked = false; fxGen1LockedPools = null; fxGen1LockedPosLabels = null; fxGen1LockedFP = '';
  fxGen1SemiAutoLocked = false;
  renderGen1LockUI();
  FX_GEN2_SLOTS.forEach(sl=>{
    const s = fxGen2State[sl];
    s.locked = false; s.pools = null; s.posLabels = null; s.fp = ''; s.rule = null;
    renderGen2LockUI(sl);
  });
}

// ── Tombol NORMAL: reset ke default bawaan aplikasi + unlock Gen1/Gen2 + refresh (fungsi lama tombol Refresh) ──
document.getElementById('modeNormalBtn').addEventListener('click', ()=>{
  setAppMode('normal'); // set dulu SEBELUM analyze(), supaya hook auto-pipeline di analyze() tidak ikut jalan
  resetAllSettings();
  unlockGen1Gen2();
  analyze();
  document.getElementById('modeFeedback').textContent = 'Mode Normal — semua pengaturan dikembalikan ke default.';
});

// ── Alur pipeline otomatis penuh, dipakai Mode Auto & Semi Auto setelah preset aktif: ──
// Formula X → card Auto Generator (AUTO GENERATE) → Kirim ke Filter → Jumlah & Selisih →
// Ai Ai → Shi234 → Terapkan Filter. Setiap langkah memanggil persis fungsi/tombol yang sama
// dengan yang dipakai manual, supaya perilakunya identik.
//
// Dipecah 2 bagian: bagian SETELAH Formula X (runAutoPipelineAfterFormulaX) dipisah supaya
// bisa dipanggil ulang langsung dari analyze() setiap kali Periode/Data Historis berganti —
// analyze() sudah menghitung Formula X sendiri di situ, jadi tidak perlu diulang.
function runAutoPipelineAfterFormulaX(){
  // Jalankan langsung (bukan menunggu MutationObserver) supaya Gen1/Gen2 sudah dihitung
  // ulang/relock sebelum Auto Generate jalan — mencegah Gen2 masih pakai pool basi.
  fxAutoUnlockAll();
  renderGen1LockUI();
  FX_GEN2_SLOTS.forEach(renderGen2LockUI);

  // 2) Card Auto Generator → AUTO GENERATE
  fxAutoGenerate();
  if(!document.getElementById('fxAutoGenOut').value){
    return false; // Formula X/Data belum siap — fxAutoGenerate sudah kasih alert sendiri
  }

  // 3) Kirim ke Filter — CATATAN: langkah ini otomatis mereset semua kriteria di card Filter
  // Pangkas Kombinasi (checkbox & isian manual) ke kosong lewat resetFilters().
  document.getElementById('fxAutoGenToFilterBtn').click();

  // Pulihkan kriteria Filter Pangkas Kombinasi dari Preset Aktif SEKARANG (sebelum tombol
  // Cari) — ini mengisi pengaturan yang TIDAK disentuh tombol Cari (mis. Tanpa Kembar, Buang
  // yang Sudah Keluar, Angka Ikut manual, dsb). Field yang MEMANG diisi ulang oleh tombol Cari
  // di bawah (filterJumlah/filterSelisih/filterAiAC/filterAiCK/filterCB/filterShioAll) akan
  // ditimpa lagi setelah ini dengan angka segar dari periode terbaru — itu memang tujuannya.
  const _activePresetName = getActivePresetName();
  if(_activePresetName){
    const _all = presetLoadAll();
    if(_all[_activePresetName]) presetApplyFields(_all[_activePresetName].fields);
  }

  // 4) Jumlah & Selisih — cari rekomendasi cover data (langsung isi filterJumlah/filterSelisih
  // dengan angka SEGAR dari periode terbaru, menimpa nilai preset di field ini)
  document.getElementById('cariJumlahBtn').click();
  document.getElementById('cariSelisihBtn').click();

  // 5) Ai Ai — cari rekomendasi cover data tiap pasangan posisi (isi filterAiAC/filterAiCK/filterCB)
  document.getElementById('cariAiACBtn').click();
  document.getElementById('cariAiCKBtn').click();
  document.getElementById('cariAiKEBtn').click();

  // 6) Shi234 — cari rekomendasi shio cover data (centang ulang checkbox Shio & filterShioAll)
  document.getElementById('cariShioBtn').click();

  // 7) Terapkan Filter — final, memakai gabungan: pengaturan preset (yang tidak disentuh Cari)
  // + angka segar hasil Cari (yang memang harus ikut periode terbaru)
  document.getElementById('applyFilterBtn').click();

  return true;
}

function runAutoPipeline(){
  if(!lastPosLabels || !lastPosLabels.length || !lastHistoryNumbers.length){
    alert('Isi & proses Data Historis dulu (Periode) sebelum menjalankan pipeline otomatis.');
    return false;
  }
  // 1) Formula X — hitung ulang sesuai Tren N/Control N/Out N yang baru dimuat dari preset.
  computeFormulaX(lastHistoryNumbers, lastPosLabels);
  return runAutoPipelineAfterFormulaX();
}

document.getElementById('modeAutoBtn').addEventListener('click', ()=>{
  const name = getActivePresetName();
  if(!name){ alert('Pilih dulu "Preset Aktif" di card Preset Pengaturan.'); return; }
  const ok = presetLoad(name);
  if(!ok){ alert(`Preset "${name}" tidak ditemukan — pilih ulang Preset Aktif.`); return; }
  setAppMode('auto');
  const pipelineOk = runAutoPipeline();
  document.getElementById('modeFeedback').textContent = pipelineOk
    ? `Mode Auto — preset "${name}" dimuat, alur Formula X → Generate → Filter selesai otomatis.`
    : `Mode Auto — preset "${name}" dimuat, tapi alur otomatis belum jalan (cek Data Historis).`;
});

// ── Tombol SEMI AUTO: muat Preset Aktif, lalu buka popup input angka bahan Gen 1 ──
document.getElementById('modeSemiAutoBtn').addEventListener('click', ()=>{
  const name = getActivePresetName();
  if(!name){ alert('Pilih dulu "Preset Aktif" di card Preset Pengaturan.'); return; }
  const ok = presetLoad(name);
  if(!ok){ alert(`Preset "${name}" tidak ditemukan — pilih ulang Preset Aktif.`); return; }
  if(!lastPosLabels || !lastPosLabels.length){
    alert('Isi & proses Data Historis dulu (posisi A/C/K/E belum terdeteksi).');
    return;
  }
  document.getElementById('semiAutoInput').value = '';
  document.getElementById('semiAutoFeedback').textContent = '';
  document.getElementById('semiAutoModalHint').textContent =
    `Isi satu angka saja untuk mengisi semua posisi (${lastPosLabels.join(',')}), atau pisahkan tiap posisi dengan titik (.) atau koma (,) sesuai urutan: ${lastPosLabels.join(' → ')}.`;
  document.getElementById('semiAutoModal').style.display = 'flex';
});

document.getElementById('semiAutoCancelBtn').addEventListener('click', ()=>{
  document.getElementById('semiAutoModal').style.display = 'none';
});

document.getElementById('semiAutoSaveBtn').addEventListener('click', ()=>{
  const raw = document.getElementById('semiAutoInput').value.trim();
  const feedback = document.getElementById('semiAutoFeedback');
  if(!raw){ feedback.textContent = 'Isi angka bahan dulu.'; return; }
  if(!lastPosLabels || !lastPosLabels.length){ feedback.textContent = 'Posisi aktif tidak terdeteksi — proses Data Historis dulu.'; return; }

  const segments = raw.split(/[.,]/).map(s=>s.trim()).filter(s=>s.length);
  const n = lastPosLabels.length;
  let perPosition;

  if(segments.length === 1){
    // Satu baris angka saja → isi semua posisi dengan angka yang sama
    perPosition = lastPosLabels.map(()=> segments[0]);
  } else if(segments.length === n){
    perPosition = segments;
  } else {
    feedback.textContent = `Jumlah segmen (${segments.length}) tidak sesuai jumlah posisi aktif (${n}: ${lastPosLabels.join(',')}). Isi 1 angka saja, atau tepat ${n} angka dipisah titik/koma.`;
    return;
  }

  if(perPosition.some(s => !/^\d+$/.test(s))){
    feedback.textContent = 'Hanya boleh berisi angka 0-9 di tiap segmen.';
    return;
  }

  const pools = perPosition.map(s => s.split(''));
  fxGen1Locked = true;
  fxGen1SemiAutoLocked = true;
  fxGen1LockedPools = pools;
  fxGen1LockedPosLabels = lastPosLabels.slice();
  fxGen1LockedFP = dataFingerprint(lastHistoryNumbers);
  renderGen1LockUI();

  document.getElementById('semiAutoModal').style.display = 'none';
  setAppMode('semi');
  const pipelineOk = runAutoPipeline();
  document.getElementById('modeFeedback').textContent = pipelineOk
    ? 'Mode Semi Auto — Gen 1 terkunci dari angka bahan, alur Formula X → Generate → Filter selesai otomatis.'
    : 'Mode Semi Auto — Gen 1 terkunci dari angka bahan, tapi alur otomatis belum jalan (cek Data Historis).';
});

// Terapkan mode tersimpan (kalau ada) saat halaman dibuka, tanpa menjalankan ulang popup/preset.
setAppMode(getAppMode());

// ===================== TOMBOL FLOATING: KEMBALI KE ATAS =====================
(function(){
  const btn = document.getElementById('scrollTopBtn');
  if(!btn) return;
  const SHOW_AFTER_PX = 300; // muncul setelah scroll turun sejauh ini
  window.addEventListener('scroll', () => {
    btn.classList.toggle('show', window.scrollY > SHOW_AFTER_PX);
  }, { passive:true });
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
