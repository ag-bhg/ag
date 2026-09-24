// ===================== AI RISK MANAGER (Blueprint "Sekring") =====================
// Lapis PENGAMBILAN KEPUTUSAN EKSEKUSI baru — MENGGANTIKAN Zona Aman Streak lama
// (computeStreakZones/pickExecution di aiBrain.js) sesuai 5 prinsip blueprint user:
//
//  1. WASIT CIRCUIT BREAKER: "kombinasi aktif" = draw di mana SEMUA posisi kena bareng
//     (persis makna "kombinasi" di 2D/3D/4D). Setiap baris terbaru dipantau. Aturan mutlak:
//     patah streak 1x SAJA -> trip langsung (drop kombinasi ini), prioritas pindah ke
//     kandidat cadangan di watchlist. Tidak ada toleransi di aturan ini — beda dari
//     pemicu auto-switch di poin 2 (yang memang butuh ambang, karena tugasnya beda: pindah
//     MODE, bukan mendrop kombinasi).
//
//  2. DUAL-MODE STATIS vs ZIG-ZAG:
//     - STATIS (default): 1 target streak tunggal, DIUKUR dari riwayat pasaran itu sendiri
//       (panjang streak dengan tingkat bertahan/survival tertinggi yang sampelnya cukup),
//       bukan angka tebakan tetap.
//     - Pemicu otomatis: dipantau di jendela MONITOR_WINDOW putaran terakhir. Kalau jumlah
//       kegagalan melewati batas toleransi TERUKUR (dihitung dari akurasi walk-forward asli
//       pasaran itu, mean±simpangan baku binomial — bukan tebakan), mode pindah ke ZIG-ZAG.
//     - ZIG-ZAG: target berputar mengikuti ZIGZAG_CYCLE (3->2->4->6, persis contoh blueprint),
//       maju satu langkah tiap kali trip atau target tercapai.
//     - Kembali ke STATIS hanya kalau stabil di jendela yang LEBIH PANJANG (REVERT_WINDOW) —
//       supaya tidak bolak-balik mode gara-gara satu-dua putaran kebetulan.
//
//  3. RENTANG OUTPUT DINAMIS: dibatasi ketat 6/7/8 digit per posisi (menghindari rentang
//     lebar 4-9 yang cenderung memaksa pilih sampai 9). Jangkar di 7 (sweet spot). Karena
//     rank digit di st.ranks TIDAK bergantung pada OUT, toleransi di poin 2 bisa diuji ulang
//     langsung di out=6/7/8 dari riwayat yang sama untuk memilih OUT yang paling longgar
//     yang TIDAK melanggar toleransi (default 7, hanya melebar ke 8 kalau memang perlu,
//     boleh menyempit ke 6 kalau sangat stabil — dengan histeresis supaya tidak bolak-balik).
//
//  4. SILENT BACKGROUND PROCESSING: evaluateAll() dirancang dipanggil untuk SEMUA pasaran yang
//     sudah dimuat (bukan cuma yang sedang dibuka di layar) tanpa argumen UI apa pun — modul
//     ini murni fungsi atas data (st.ranks/st.reg.lab), tidak menyentuh DOM sama sekali, jadi
//     aman dipanggil di interval latar belakang. Pemanggil (aiMode.js) yang memutuskan mana
//     yang perlu dicetak ke chat (lihat poin 5) dan mana yang cukup disimpan diam-diam.
//
//  5. AUDIT TRANSPARAN: buildAudit() mencetak status lengkap (mode+matriks, target+toleransi,
//     status breaker+watchlist) supaya keputusan tidak menjadi kotak hitam.
//
// Modul ini TIDAK mengubah cara aiBrain belajar (campuran Bayes/bobot pakar tetap utuh) — murni
// lapis keputusan EKSEKUSI di atasnya, seperti halnya Zona Aman Streak lama yang digantikannya.
// Tidak menyentuh DOM, bisa diuji di Node. Muat SETELAH aiBrain.js, SEBELUM aiMode.js.
(function(root){
'use strict';

// ---------- Konstanta blueprint ----------
const ZIGZAG_CYCLE = [3, 2, 4, 6];    // matriks rotasi target Mode Zig-Zag — persis contoh blueprint
const STATIC_TARGET_FALLBACK = 4;     // dipakai HANYA kalau riwayat belum cukup untuk mengukur target sendiri
const MONITOR_WINDOW = 10;            // "jendela pantau 10 putaran terakhir" (pemicu auto-switch mode)
const REVERT_WINDOW = 20;             // jendela lebih panjang utk kembali ke Statis (harus lebih meyakinkan drpd pemicunya)
const TOL_Z = 1.0;                    // lebar pita toleransi di atas kegagalan yang DIHARAPKAN (mu + z*sigma)
const MIN_STREAK_SAMPLE = 8;          // minimal kejadian suatu panjang streak di riwayat, baru dipercaya jadi "target paling konsisten"
const OUT_MIN = 6, OUT_DEFAULT = 7, OUT_MAX = 8; // rentang output dinamis, jangkar di 7
const WATCHLIST_K = 3;                // banyak kandidat cadangan per posisi yang disiapkan di watchlist

// ---------- Utilitas kecil (berdiri sendiri, tidak bergantung ke fungsi internal aiBrain) ----------
function hitArrFromRanks(R, out){ return (R || []).map(r => r < out); }

// Daftar kejadian tiap panjang streak: {streak, survived} — 'survived' = draw SETELAH mencapai
// streak itu ternyata kena juga (streak berlanjut). Sama persis semangatnya dengan streakEvents
// di aiBrain.js, diduplikasi kecil di sini supaya modul ini tidak bergantung ke fungsi yang tidak diekspor.
function streakEvents(hitArr){
  const ev = []; let s = 0;
  for(let i = 0; i < hitArr.length; i++){
    if(s > 0) ev.push({ streak: s, survived: !!hitArr[i] });
    s = hitArr[i] ? s + 1 : 0;
  }
  return ev;
}
function currentStreak(hitArr){
  let s = 0;
  for(let i = hitArr.length - 1; i >= 0; i--){ if(hitArr[i]) s++; else break; }
  return s;
}
function recentFails(hitArr, window){
  const w = hitArr.slice(-window);
  return w.filter(h => !h).length;
}

// Target streak "paling konsisten" = panjang streak dengan tingkat bertahan (survival) TERTINGGI
// yang sampelnya cukup (MIN_STREAK_SAMPLE) di riwayat pasaran itu SENDIRI — bukan angka tebakan.
// Fallback ke STATIC_TARGET_FALLBACK hanya kalau belum ada panjang streak dengan sampel cukup
// (pasaran/data masih baru).
function measureStaticTarget(hitArr){
  const byLen = {};
  streakEvents(hitArr).forEach(e => {
    const b = byLen[e.streak] || (byLen[e.streak] = { n: 0, surv: 0 });
    b.n++; if(e.survived) b.surv++;
  });
  let best = null;
  Object.keys(byLen).forEach(k => {
    const len = +k, b = byLen[len];
    if(b.n < MIN_STREAK_SAMPLE) return;
    const rate = b.surv / b.n;
    if(!best || rate > best.rate || (rate === best.rate && len < best.len)) best = { len, rate, n: b.n };
  });
  return best ? best.len : STATIC_TARGET_FALLBACK;
}

// Batas toleransi TERUKUR: dari tingkat gagal ASLI pasaran (akurasi walk-forward riwayat penuh),
// BUKAN asumsi out/10 — ini yang dimaksud "batas aman yang terukur" di permintaan user. mu/sigma
// dari pendekatan binomial standar (jumlah kegagalan dalam `window` percobaan Bernoulli dengan
// peluang gagal q = 1 - p_hat).
function measuredTolerance(hitArr, window){
  const n = hitArr.length;
  const pHat = n ? hitArr.reduce((a, b) => a + (b ? 1 : 0), 0) / n : (OUT_DEFAULT / 10);
  const q = Math.min(Math.max(1 - pHat, 1e-6), 1 - 1e-6);
  const mu = window * q;
  const sigma = Math.sqrt(window * q * (1 - q));
  return { pHat, mu, sigma, limit: mu + TOL_Z * sigma };
}
function overTolerance(hitArr, window){
  const tol = measuredTolerance(hitArr, window);
  return { over: recentFails(hitArr, window) > tol.limit, tol, fails: recentFails(hitArr, window) };
}

// ---------- State guard per pasaran (disimpan oleh pemanggil, lihat serializeGuard/deserializeGuard) ----------
function newGuard(){
  return { mode: 'STATIC', zigIdx: 0, out: OUT_DEFAULT, updatedAt: 0, lastSignature: '' };
}

// ---------- Evaluasi inti: 1 pasaran, sekali panggil ----------
// st       : state aiBrain (butuh st.reg.lab, st.ranks, st.L) — TIDAK diubah oleh fungsi ini.
// out      : OUT saat ini yang sedang dipakai user/sistem (dipakai sbg titik tolak rentang dinamis).
// guard    : hasil newGuard() atau guard tersimpan sebelumnya untuk pasaran ini.
// prArr    : opsional — array hasil B.predict() (r.pr) untuk pasaran ini, dipakai membangun watchlist
//            kandidat cadangan per posisi dari peringkat peluang (P) terkini. Boleh diisi null.
function evaluate(name, st, out, guard, prArr){
  guard = guard ? Object.assign(newGuard(), guard) : newGuard();
  const labels = st.reg.lab, L = st.L;
  const hitByPos = labels.map((_, p) => hitArrFromRanks(st.ranks[p], out));
  const n = hitByPos[0] ? hitByPos[0].length : 0;
  const combinedHit = [];
  for(let i = 0; i < n; i++) combinedHit.push(hitByPos.every(h => h[i]));

  // ---- 1. Circuit breaker (aturan mutlak, di level KOMBINASI = semua posisi kena bareng) ----
  const streak = currentStreak(combinedHit);
  const tripped = combinedHit.length > 0 && !combinedHit[combinedHit.length - 1]; // patah 1x = trip, titik.
  const target = guard.mode === 'ZIGZAG' ? ZIGZAG_CYCLE[guard.zigIdx % ZIGZAG_CYCLE.length] : measureStaticTarget(combinedHit);
  const reached = !tripped && streak >= target;

  // ---- 2. Pemicu auto-switch mode (ambang TERUKUR, bukan angka tebakan) ----
  const ot10 = overTolerance(combinedHit, MONITOR_WINDOW);
  let mode = guard.mode, zigIdx = guard.zigIdx, switched = null;
  if(mode === 'STATIC' && ot10.over){
    mode = 'ZIGZAG'; zigIdx = 0; switched = 'STATIS \u2192 ZIG-ZAG';
  } else if(mode === 'ZIGZAG'){
    const stable20 = !overTolerance(combinedHit, REVERT_WINDOW).over;
    if(stable20 && n >= REVERT_WINDOW){
      mode = 'STATIC'; zigIdx = 0; switched = 'ZIG-ZAG \u2192 STATIS';
    } else if(tripped || reached){
      zigIdx = (guard.zigIdx + 1) % ZIGZAG_CYCLE.length; // maju satu langkah siklus tiap trip/target tercapai
    }
  }

  // ---- 3. Rentang OUT dinamis (6/7/8, jangkar 7) ----
  // rank di st.ranks tidak bergantung OUT, jadi toleransi bisa diuji ulang langsung di kandidat lain
  // dari riwayat yang SAMA (bukan re-learn) untuk memilih OUT paling longgar yang masih aman.
  function combinedHitAt(o){
    const h = labels.map((_, p) => hitArrFromRanks(st.ranks[p], o));
    const c = []; for(let i = 0; i < n; i++) c.push(h.every(x => x[i]));
    return c;
  }
  function safeAt(o){ return !overTolerance(combinedHitAt(o), MONITOR_WINDOW).over; }
  let outSel = Math.min(Math.max(guard.out || OUT_DEFAULT, OUT_MIN), OUT_MAX);
  if(outSel === OUT_DEFAULT && !safeAt(OUT_DEFAULT) && safeAt(OUT_MAX)) outSel = OUT_MAX;       // melebar krn volatilitas terukur
  else if(outSel === OUT_MAX && safeAt(OUT_DEFAULT) && overTolerance(combinedHitAt(OUT_MAX), REVERT_WINDOW).over === false && overTolerance(combinedHitAt(OUT_DEFAULT), REVERT_WINDOW).over === false) outSel = OUT_DEFAULT; // sudah stabil lama, kembali ke jangkar
  else if(outSel === OUT_DEFAULT && !overTolerance(combinedHitAt(OUT_MIN), REVERT_WINDOW).over) outSel = OUT_MIN;    // stabil lama bahkan di rentang sempit -> boleh menyempit
  else if(outSel === OUT_MIN && overTolerance(combinedHitAt(OUT_MIN), MONITOR_WINDOW).over) outSel = OUT_DEFAULT;    // menyempit ternyata gagal -> balik ke jangkar

  // ---- diagnostik per-posisi (untuk watchlist/penentuan posisi mana yang bermasalah) ----
  const perPos = {};
  labels.forEach((lab, p) => {
    const h = hitByPos[p];
    perPos[lab] = { streak: currentStreak(h), fails10: recentFails(h, MONITOR_WINDOW), n: h.length };
  });
  const worstPos = labels.slice().sort((a, b) => perPos[b].fails10 - perPos[a].fails10)[0];

  // ---- watchlist kandidat cadangan (dari peringkat peluang TERKINI, kalau prArr disediakan) ----
  let watchlist = [];
  if(Array.isArray(prArr)){
    watchlist = labels.map((lab, p) => {
      const x = prArr[p]; if(!x || !x.P) return { label: lab, backups: [] };
      const order = Array.from({ length: 10 }, (_, d) => d).sort((a, b) => x.P[b] - x.P[a]);
      const pool = order.slice(0, outSel), backups = order.slice(outSel, outSel + WATCHLIST_K);
      return { label: lab, pool, backups };
    });
  }

  // ---- tangga prioritas formula (tie-breaker & tampilan saja — lihat definisi di bawah) ----
  let ladder = null;
  try{ ladder = computeFormulaLadderAll(st); }catch(e){ ladder = null; } // pasaran tanpa registry formula (mis. data uji sintetis) tetap aman

  const guardOut = {
    mode, zigIdx, out: outSel, updatedAt: Date.now(),
    lastSignature: [mode, zigIdx, tripped, outSel, streak].join(':')
  };
  const changed = guardOut.lastSignature !== guard.lastSignature;

  return {
    name, mode, zigIdx, target, streak, tripped, reached, switched,
    tolerance: ot10.tol, fails10: ot10.fails,
    out: outSel, outChanged: outSel !== (guard.out || OUT_DEFAULT),
    perPos, worstPos, watchlist, ladder, guard: guardOut, changed, n
  };
}

// Panggil untuk SEMUA pasaran yang sudah dimuat (dipakai di background sweep, poin 4 blueprint).
// states: { name -> st (aiBrain state) }, guards: { name -> guard tersimpan }, outs: { name -> out aktif }.
function evaluateAll(states, guards, outs, prArrs){
  const res = {};
  Object.keys(states || {}).forEach(name => {
    try{
      res[name] = evaluate(name, states[name], (outs && outs[name]) || OUT_DEFAULT, (guards && guards[name]) || null, prArrs && prArrs[name]);
    }catch(e){ /* pasaran ini dilewati diam-diam, tidak boleh menghentikan sweep pasaran lain */ }
  });
  return res;
}

// ---------- Tangga Prioritas Formula (TAMBAHAN atas permintaan user — tie-breaker & tampilan SAJA) ----------
// Rancangan user: tiap putaran HIT -> tingkat +1 (naik lagi kalau hit lagi); tiap putaran MISS -> tingkat
// -1 (turun lagi kalau gagal lagi). Diterapkan di sini PERSIS begitu (net skor hit-miss), TAPI:
//   - dihitung dari data yang SUDAH direkam aiBrain sendiri (st.fxLog[p][e], walk-forward, tidak bocor),
//     bukan mekanisme belajar baru — jadi TIDAK menyentuh st.lw/bobot Bayes sama sekali.
//   - dibatasi ke jendela yang aiBrain rekam (~60 putaran terakhir per pakar formula) supaya tingkatnya
//     tetap mencerminkan performa BARU-BARU INI, bukan angka yang menumpuk tak terbatas bertahun-tahun.
//   - HANYA dipakai untuk: (a) tampilan/laporan, dan (b) memecah seri kalau 2 formula bobot Bayes-nya
//     nyaris sama (selisih <= LADDER_TIE_EPS) — pemilihan digit aktual TETAP 100% dari bobot Bayes.
const FORMULA_FAMS = ['NRL', 'ML', 'MB', 'IDX', 'BHG', 'PK', 'RDM']; // 7 "formula" sesuai istilah yang dipakai user
const LADDER_TIE_EPS = 0.03; // bobot Bayes dianggap "seri" kalau selisihnya <= 3 poin persen probabilitas

function softmaxArr(lw){
  let mx = -Infinity; for(let i = 0; i < lw.length; i++) if(lw[i] > mx) mx = lw[i];
  const w = new Array(lw.length); let s = 0;
  for(let i = 0; i < lw.length; i++){ w[i] = Math.exp(lw[i] - mx); s += w[i]; }
  for(let i = 0; i < lw.length; i++) w[i] /= (s || 1);
  return w;
}
// Pemecah seri: urutkan dulu berdasar bobot Bayes (desc, ini yg dipakai aiBrain sesungguhnya); lalu,
// HANYA untuk pasangan bertetangga yang selisih bobotnya <= epsW (dianggap seri), boleh ditukar kalau
// yang di belakang tingkatnya lebih tinggi. Beberapa lintasan (bubble-limited) supaya kelompok seri
// 3-formula pun ikut terurut rapi oleh tingkat.
function ladderTieBreak(items, epsW){
  const order = items.slice().sort((a, b) => b.w - a.w);
  let changed = false;
  for(let pass = 0; pass < order.length; pass++){
    let didSwap = false;
    for(let i = 0; i < order.length - 1; i++){
      if(Math.abs(order[i].w - order[i + 1].w) <= epsW && order[i + 1].tier > order[i].tier){
        const t = order[i]; order[i] = order[i + 1]; order[i + 1] = t; didSwap = true; changed = true;
      }
    }
    if(!didSwap) break;
  }
  return { order, changed };
}
// 1 posisi: untuk tiap keluarga formula (NRL/ML/MB/IDX/BHG/PK/RDM), wakilnya adalah VARIAN (ctrl N,
// kalau ada) yang bobot Bayes-nya SEDANG tertinggi — itulah varian yang benar-benar dipakai aiBrain
// sekarang, jadi tangganya relevan (bukan varian acak/basi dari keluarga yang sama).
function computeFormulaLadder(st, p){
  const reg = st.reg, E0 = reg.ex.length, lwRaw = st.lw[p] || [];
  const w = softmaxArr(lwRaw.length ? lwRaw : new Array(E0).fill(0));
  const byFam = {};
  for(let e = 0; e < E0; e++){
    const x = reg.ex[e]; if(!x || !x.fx) continue;
    const cur = byFam[x.fam];
    if(!cur || w[e] > cur.w) byFam[x.fam] = { e, w: w[e] };
  }
  const items = FORMULA_FAMS.filter(f => byFam[f]).map(fam => {
    const rep = byFam[fam], hitArr = (st.fxLog[p] && st.fxLog[p][rep.e]) || [];
    const tier = hitArr.reduce((s, h) => s + (h ? 1 : -1), 0);
    return { fam, id: reg.ex[rep.e].id, name: reg.ex[rep.e].name, w: rep.w, tier, streak: currentStreak(hitArr), n: hitArr.length };
  });
  const { order, changed } = ladderTieBreak(items, LADDER_TIE_EPS);
  return { label: reg.lab[p], items, order, tieBroken: changed };
}
function computeFormulaLadderAll(st){ return st.reg.lab.map((_, p) => computeFormulaLadder(st, p)); }
// Ringkasan 1 baris (dipakai di buildAudit) — pemenang tiap posisi SETELAH pemecah seri; tanda * = seri Bayes, dimenangkan lewat tingkat.
function topFormulaLine(laddersAll){
  return laddersAll.map(l => l.label + '=' + (l.order[0] ? l.order[0].fam + (l.order[0].tier >= 0 ? '+' : '') + (l.order[0] ? l.order[0].tier : '') + (l.tieBroken ? '*' : '') : '-')).join(' ');
}
// Laporan detail (dipakai perintah manual "tangga"/"prioritas formula") — seluruh keluarga per posisi.
function buildLadderReport(name, laddersAll){
  const lines = ['\uD83E\uDE9C Tangga Prioritas Formula ' + name + ' (tie-breaker & tampilan \u2014 TIDAK mengubah bobot Bayes/pemilihan digit):'];
  laddersAll.forEach(l => {
    lines.push('\u2022 Posisi ' + l.label + ':');
    l.order.forEach((it, i) => {
      lines.push('   ' + (i + 1) + '. ' + it.fam + ' \u2014 bobot ' + (it.w * 100).toFixed(1) + '% \u00B7 tingkat ' + (it.tier >= 0 ? '+' : '') + it.tier + ' (streak ' + it.streak + ', dr ' + it.n + ' putaran terekam)');
    });
    if(l.tieBroken) lines.push('   \u2194\uFE0F urutan di atas sudah dipecah-seri pakai tingkat (bobot Bayes teratas nyaris sama, selisih \u2264 ' + (LADDER_TIE_EPS * 100).toFixed(0) + ' poin%).');
  });
  return lines.join('\n');
}

// ---------- Audit transparan (poin 5) ----------
function buildAudit(res){
  const lines = [];
  const modeTxt = res.mode === 'ZIGZAG'
    ? 'ZIG-ZAG (siklus ' + ZIGZAG_CYCLE.join('\u2192') + ', sekarang giliran target ' + res.target + 'x)'
    : 'STATIS (target diukur dari riwayat sendiri: ' + res.target + 'x)';
  lines.push('\uD83D\uDEE1\uFE0F Audit Risiko ' + res.name + (res.switched ? ' \u2014 mode baru saja pindah: ' + res.switched : ''));
  lines.push('\u2022 Mode aktif: ' + modeTxt);
  lines.push('\u2022 Target & toleransi: target ' + res.target + 'x streak; jendela pantau ' + MONITOR_WINDOW +
    ' putaran, batas gagal aman \u2248 ' + res.tolerance.limit.toFixed(1) + ' (terukur dari akurasi asli pasaran ini, bukan tebakan) \u2014 gagal terkini ' + res.fails10 + '/' + MONITOR_WINDOW + '.');
  lines.push('\u2022 Circuit Breaker: ' + (res.tripped
    ? '\uD83D\uDD34 TRIP \u2014 kombinasi terakhir patah, pindah ke kandidat cadangan.'
    : (res.reached ? '\uD83D\uDFE1 target ' + res.target + 'x tercapai (streak ' + res.streak + ') \u2014 rotasi ke kandidat segar.' : '\uD83D\uDFE2 AMAN \u2014 streak berjalan ' + res.streak + '/' + res.target + 'x.')));
  lines.push('\u2022 OUT aktif: ' + res.out + ' (jangkar 7, rentang 6\u20138)' + (res.outChanged ? ' \u2014 baru saja disesuaikan otomatis krn volatilitas terukur.' : '.'));
  if(res.worstPos) lines.push('\u2022 Posisi paling sering lepas (' + MONITOR_WINDOW + ' putaran terakhir): ' + res.worstPos + ' (' + res.perPos[res.worstPos].fails10 + 'x gagal) \u2014 kandidat pertama utk digeser ke cadangan.');
  if(res.watchlist && res.watchlist.length){
    const wl = res.watchlist.map(w => w.label + '[' + w.backups.join(',') + ']').join(' ');
    lines.push('\u2022 Watchlist cadangan per posisi: ' + wl);
  }
  if(res.ladder && res.ladder.length){
    lines.push('\u2022 Prioritas formula (bobot Bayes, dipecah-seri pakai tingkat +/-): ' + topFormulaLine(res.ladder) + ' \u2014 detail: ketik "tangga".');
  }
  return lines.join('\n');
}

const API = {
  ZIGZAG_CYCLE, MONITOR_WINDOW, REVERT_WINDOW, OUT_MIN, OUT_DEFAULT, OUT_MAX,
  newGuard, evaluate, evaluateAll, buildAudit,
  measureStaticTarget, measuredTolerance, // diekspor supaya bisa diuji/ditampilkan terpisah kalau perlu
  FORMULA_FAMS, LADDER_TIE_EPS, computeFormulaLadder, computeFormulaLadderAll, buildLadderReport, topFormulaLine
};
if(typeof module !== 'undefined' && module.exports) module.exports = API;
root.AiRiskManager = API;
})(typeof window !== 'undefined' ? window : globalThis);
