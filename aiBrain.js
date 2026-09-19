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
const SHARE = 0.01;       // fixed-share: peluang pindah pakar
const DECAY = 0.97;       // peluruhan skor "keuntungan terkini"
const LAB_START = 40, LAB_EVERY = 20, MAX_COMBOS = 6, LAB_TOPK = 8, LAB_ADMIT = 2;
const LAB_MIN_T = 2.5;    // ambang uji-t kombinasi baru di tiap potongan waktu
const GATE_Z = 3.5;       // ambang z global (kira-kira p<0,01 setelah koreksi ~50 pakar)
const LN_UNI = Math.log(0.1);

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
function parseMarketText(text){
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const nums = [];
  let skipped = 0;
  lines.forEach(line => {
    const cols = line.split('\t');
    const n = cols[cols.length - 1].trim();
    if(/^\d{2,8}$/.test(n)) nums.push(n); else skipped++;
  });
  // panjang dominan
  const cnt = {};
  nums.forEach(n => { cnt[n.length] = (cnt[n.length] || 0) + 1; });
  let L = 0, best = 0;
  Object.keys(cnt).forEach(k => { if(cnt[k] > best){ best = cnt[k]; L = +k; } });
  const rows = nums.filter(n => n.length === L).reverse(); // lama -> baru
  return { L, C: rows.map(n => n.split('').map(Number)), skipped: skipped + (nums.length - rows.length) };
}
function parseNumberList(newestFirstStrings){
  const nums = (newestFirstStrings || []).filter(n => /^\d{2,8}$/.test(String(n)));
  const cnt = {}; nums.forEach(n => { cnt[n.length] = (cnt[n.length] || 0) + 1; });
  let L = 0, best = 0; Object.keys(cnt).forEach(k => { if(cnt[k] > best){ best = cnt[k]; L = +k; } });
  const rows = nums.filter(n => n.length === L).reverse();
  return { L, C: rows.map(n => String(n).split('').map(Number)), skipped: nums.length - rows.length };
}

// ---------- Registry pakar ----------
function makeRegistry(L){
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
  const idx = {}; ex.forEach((e, i) => { idx[e.id] = i; });
  return { L, lab, ex, idx };
}

// ---------- Peluang tiap pakar untuk baris ke-t (hanya memakai baris < t) ----------
// Hasil: Float64Array(E0 * L * 10), indeks ((e*L)+p)*10 + digit
function baseP(C, t, reg){
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
function initLw(reg, tilt){
  const E = reg.ex.length, lw = new Array(E);
  const wOther = 0.5 / (E - 1);
  let s = 0; const w = new Array(E);
  for(let i = 0; i < E; i++){
    w[i] = i === 0 ? 0.5 : wOther * Math.exp((tilt && tilt[reg.ex[i].id]) || 0);
    s += w[i];
  }
  for(let i = 0; i < E; i++) lw[i] = Math.log(w[i] / s);
  return lw;
}
function newState(name, L, tilt){
  const reg = makeRegistry(L), E = reg.ex.length;
  const st = { v: 1, name, L, t: T0, head: '', tail: '', reg, tilt: tilt || null,
    lw: [], adv: [], combos: [], ranks: [], cumS: [], cumS2: [], cumN: 0, labLog: [] };
  for(let p = 0; p < L; p++){
    st.lw.push(initLw(reg, tilt));
    st.adv.push(new Array(E).fill(0));
    st.combos.push([]);
    st.ranks.push([]);
    st.cumS.push(new Array(E).fill(0));
    st.cumS2.push(new Array(E).fill(0));
  }
  return st;
}
function rowKey(r){ return r.join(''); }

function stepPos(st, bp, p, y){
  const reg = st.reg, dists = posDists(bp, reg, p, st.combos[p]), E = dists.length;
  const lw = st.lw[p], w = softmaxInto(lw, new Float64Array(E));
  const P = mixP(w, dists, null);
  const r = rankOf(P, y);
  const E0 = reg.ex.length, adv = st.adv[p];
  for(let e = 0; e < E; e++){
    const ll = Math.log(Math.max(dists[e][y], EPS));
    lw[e] += ETA * ll;
    const dl = ll - LN_UNI;
    adv[e] = DECAY * adv[e] + (1 - DECAY) * dl;
    if(e < E0){ st.cumS[p][e] += dl; st.cumS2[p][e] += dl * dl; }
  }
  softmaxInto(lw, w);
  for(let e = 0; e < E; e++){ w[e] = (1 - SHARE) * w[e] + SHARE / E; lw[e] = Math.log(w[e]); }
  return r;
}

function processStep(st, C, t){
  const bp = baseP(C, t, st.reg);
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
  for(let t = T0; t < tau; t++) store.push(baseP(C, t, reg));
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
  if(!stateMatches(st, C) || st.L !== L || (('tilt' in opts) && JSON.stringify(opts.tilt || null) !== JSON.stringify(st.tilt || null))){
    st = newState(name, L, opts.tilt);
    st.head = C.slice(0, T0).map(rowKey).join('|');
  }
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
  const bp = baseP(C, t, reg), res = [];
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

function serialize(st){
  const r4 = a => a.map(x => Math.round(x * 1e4) / 1e4);
  return { v: 1, name: st.name, L: st.L, t: st.t, head: st.head, tail: st.tail, tilt: st.tilt,
    lw: st.lw.map(r4), adv: st.adv.map(r4), combos: st.combos, ranks: st.ranks.map(a => a.join('')),
    cumS: st.cumS.map(r4), cumS2: st.cumS2.map(r4), cumN: st.cumN, labLog: st.labLog };
}
function deserialize(o){
  if(!o || o.v !== 1) return null;
  const st = newState(o.name, o.L, o.tilt);
  Object.assign(st, { t: o.t, head: o.head, tail: o.tail, lw: o.lw, adv: o.adv, combos: o.combos, ranks: o.ranks.map(x => String(x).split('').map(Number)),
    cumS: o.cumS, cumS2: o.cumS2, cumN: o.cumN, labLog: o.labLog || [] });
  return st;
}

const API = { T0, EVAL_FROM, GATE_Z, posLabels, parseMarketText, parseNumberList, makeRegistry, baseP, newState,
  learnMarket, forceLab, predict, explain, evalState, evalAll, globalReport, tiltFromReport, serialize, deserialize, pOneSided };
if(typeof module !== 'undefined' && module.exports) module.exports = API;
root.AiBrain = API;
})(typeof window !== 'undefined' ? window : globalThis);
