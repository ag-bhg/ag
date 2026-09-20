// ===================== MODE AI (panel + obrolan) =====================
// Dimuat SETELAH automode.js, main.js dan aiBrain.js. Tidak mengubah file lain: tombol mode, kartu panel dan
// pembungkus showModeView() semuanya dipasang dari sini. Mode "ai" hanya mode TAMPILAN (tidak menulis appMode_v1),
// jadi logika Normal/Semi Auto/Auto tidak tersentuh.
(function(){
'use strict';
if(typeof AiBrain === 'undefined' || typeof document === 'undefined') return;
const B = AiBrain;
const LS_STATES = 'aiBrain_v1', LS_DATA = 'aiBrain_data_v1';

const A = {
  imported: {},          // name -> teks data (dari impor JSON)
  cache: {},             // name -> { text, parsed }
  states: {},            // name -> state otak
  tilt: null,            // bobot awal hasil belajar antar pasaran
  cur: null, out: 8, outPos: {}, pin: {}, ban: {}, famOff: {},
  lastPred: null, busy: false, chat: [], resultLog: [], sig: '', globalNote: '',
  alias: {}, src: {}, lastActive: '', activeMiss: '',
  patterns: {},          // kalimat yang sudah "diajarkan" user -> perintah asli yang dimaksud
  pendingTeach: null,    // { phrase, cmd } — menunggu konfirmasi ya/tidak dari user
  xrefNames: [],         // nama pasaran "kunci" yg diuji sbg referensi silang-pasaran (kosong = mati)
  nIkut: 4,              // banyak digit filter "Angka Ikut" (filter ini tidak punya dropdown di tab Analisis)
  lastFilter: null       // angka filter hasil Ai untuk prediksi terakhir (lihat B.filterNumbers)
};

// ---------- Penyimpanan lokal (instan, cadangan offline) ----------
function loadLocal(){
  try{
    const o = JSON.parse(localStorage.getItem(LS_STATES) || 'null');
    if(o){
      A.out = o.out || 8; A.tilt = o.tilt || null; A.globalNote = o.globalNote || ''; A.xrefNames = o.xrefNames || []; A.nIkut = o.nIkut || 4;
      Object.keys(o.states || {}).forEach(k => { const st = B.deserialize(o.states[k]); if(st) A.states[k] = st; });
    }
    A.imported = JSON.parse(localStorage.getItem(LS_DATA) || '{}') || {};
  }catch(e){}
}
function saveLocal(){
  try{
    const states = {};
    Object.keys(A.states).forEach(k => { states[k] = B.serialize(A.states[k]); });
    localStorage.setItem(LS_STATES, JSON.stringify({ out: A.out, tilt: A.tilt, globalNote: A.globalNote, xrefNames: A.xrefNames, nIkut: A.nIkut, states }));
  }catch(e){ say('⚠️ Memori browser penuh, hasil belajar tidak tersimpan (tetap jalan selama halaman terbuka).'); }
}
function saveData(){ try{ localStorage.setItem(LS_DATA, JSON.stringify(A.imported)); }catch(e){} }

// ---------- Penyimpanan ingatan (Firebase lewat aiMemory.js, fallback localStorage otomatis) ----------
// load() dipanggil sekali saat init(): ambil cadangan lokal dulu (instan), lalu timpa dengan versi
// cloud kalau berhasil didapat (supaya ingatan sama persis di semua perangkat).
async function load(){
  loadLocal();
  if(typeof AiMemory === 'undefined') return;
  try{
    const mem = await AiMemory.loadAll();
    const p = mem.prefs || {};
    if('out' in p) A.out = p.out;
    if('tilt' in p) A.tilt = p.tilt;
    if('globalNote' in p) A.globalNote = p.globalNote;
    if('xrefNames' in p) A.xrefNames = p.xrefNames || [];
    if('nIkut' in p) A.nIkut = p.nIkut || 4;
    if('pin' in p) A.pin = p.pin || {};
    if('ban' in p) A.ban = p.ban || {};
    if('famOff' in p) A.famOff = p.famOff || {};
    if('outPos' in p) A.outPos = p.outPos || {};
    A.patterns = mem.patterns || {};
    if(mem.chat && mem.chat.length) A.chat = mem.chat;
    Object.keys(mem.brain || {}).forEach(k => {
      const entry = mem.brain[k]; if(!entry || !entry.state || !entry.name) return;
      const st = B.deserialize(entry.state); if(st) A.states[entry.name] = st;
    });
  }catch(e){ console.error('Mode Ai: gagal memuat ingatan cloud, pakai cadangan lokal', e); }
}
// save() dipanggil dari banyak tempat di seluruh file ini (tiap kali pengaturan berubah) — tetap
// simpan lokal seperti semula, plus kirim preferensi (bukan seluruh otak, itu berat) ke cloud.
function save(){
  saveLocal();
  if(typeof AiMemory !== 'undefined'){
    AiMemory.savePrefs({ out: A.out, tilt: A.tilt, globalNote: A.globalNote, pin: A.pin, ban: A.ban, famOff: A.famOff, outPos: A.outPos, xrefNames: A.xrefNames, nIkut: A.nIkut });
  }
}
// Kirim HASIL BELAJAR 1 pasaran ke cloud — dipanggil hanya di titik-titik yang benar mengubah otak
// (bukan tiap render), supaya tidak boros nulis. Ditimpa (bukan ditumpuk) tiap kali dipanggil ulang.
function persistBrain(name, st){
  if(typeof AiMemory === 'undefined' || !name || !st) return;
  try{
    const ev = B.evalAll([st], A.out);
    AiMemory.saveBrainResult(name, { state: B.serialize(st), pct: ev.pct, z: ev.z, n: ev.n });
  }catch(e){ console.error('Mode Ai: gagal simpan hasil belajar ' + name + ' ke cloud', e); }
}

// ---------- Sumber data pasaran ----------
// A.alias: kode/kunci peta Firebase -> nama pasaran yang dipakai Ai (nama bisa beda dari kode).
// A.src: nama pasaran -> asal datanya (Firebase / impor JSON / kotak Data Historis), ditampilkan di status.
function readFirebaseMap(){
  const out = {}; A.alias = {};
  try{
    if(typeof firebaseMarketMap === 'undefined' || !firebaseMarketMap) return out;
    const ents = (firebaseMarketMap instanceof Map) ? Array.from(firebaseMarketMap.entries()) : Object.entries(firebaseMarketMap);
    ents.forEach(([k, v]) => {
      const txt = typeof v === 'string' ? v : (v && typeof v.data === 'string' ? v.data : null);
      if(!txt) return;
      const name = (v && v.name) || k;
      out[name] = txt;
      A.alias[String(k).toUpperCase()] = name;
    });
  }catch(e){}
  return out;
}
function activeCode(){
  try{ if(typeof firebaseSelectedKode === 'function') return firebaseSelectedKode() || ''; }catch(e){}
  return '';
}
// Label pasaran yang sedang dipilih di dropdown "Periode" (mis. "MICHIGAN MID · 23j 30m" -> "MICHIGAN MID")
function activeLabels(){
  const c = [], code = activeCode(); if(code) c.push(code);
  const sel = document.getElementById('analisisPeriodeSelect');
  if(sel){
    if(sel.value) c.push(sel.value);
    const o = sel.options && sel.options[sel.selectedIndex];
    if(o && o.text){ c.push(o.text.split('·')[0].trim()); c.push(o.text.trim()); }
  }
  return c.filter(Boolean);
}
// Cari pasaran aktif di daftar pasaran Ai. Kembalikan { name } kalau ketemu, { miss: label } kalau ada
// pasaran aktif tapi tidak ada/kurang data di Ai, atau {} kalau tidak ada pasaran aktif sama sekali.
function resolveActive(ms){
  const names = Object.keys(ms), up = x => String(x == null ? '' : x).trim().toUpperCase();
  const find = q => { q = up(q); return q ? names.find(n => up(n) === q) : undefined; };
  const cands = activeLabels();
  for(let i = 0; i < cands.length; i++){
    const n = find(cands[i]) || find(A.alias[up(cands[i])]);
    if(n) return { name: n };
  }
  return cands.length ? { miss: cands.length > 2 ? cands[cands.length - 2] : cands[cands.length - 1] } : {};
}
function collectTexts(){
  const texts = {}, src = {};
  Object.keys(A.imported).forEach(k => { texts[k] = A.imported[k]; src[k] = 'impor JSON'; });
  const fb = readFirebaseMap();
  Object.keys(fb).forEach(k => { texts[k] = fb[k]; src[k] = 'Firebase'; });
  const di = document.getElementById('dataInput');
  if(di && di.value && di.value.trim()){
    const code = activeCode() || 'AKTIF';
    if(!texts[code]){ texts[code] = di.value; src[code] = 'kotak Data Historis'; }
  }
  A.src = src;
  return texts;
}

// ---------- Selaras tanggal lintas-pasaran (khusus pakar XMKT) ----------
// Parser tanggal DD-MM-YYYY sejajar dengan B.parseMarketText, untuk buildRefSeriesFor.
function parseMarketTextDated(text){
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const rows = []; let skipped = 0;
  lines.forEach(line => {
    const cols = line.split('\t');
    const n = cols[cols.length - 1].trim();
    if(/^\d{2,8}$/.test(n)){
      const tgl = cols.length >= 3 ? cols[0].trim() : '';
      rows.push({ tanggal: /^\d{2}-\d{2}-\d{4}$/.test(tgl) ? tgl : null, nomor: n });
    } else skipped++;
  });
  const cnt = {}; rows.forEach(r => { cnt[r.nomor.length] = (cnt[r.nomor.length] || 0) + 1; });
  let L = 0, best = 0;
  Object.keys(cnt).forEach(k => { if(cnt[k] > best){ best = cnt[k]; L = +k; } });
  const kept = rows.filter(r => r.nomor.length === L).reverse(); // lama -> baru
  return { L, C: kept.map(r => r.nomor.split('').map(Number)), dates: kept.map(r => r.tanggal), skipped: skipped + (rows.length - kept.length) };
}
// Tanggal hari ini "DD-MM-YYYY" zona WIB
function todayStrWIB(){
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
  const get = k => (parts.find(p => p.type === k) || {}).value || '';
  return get('day') + '-' + get('month') + '-' + get('year');
}
// Bangun {extRefs, refSeries} untuk pasaran curName dari pasaran "kunci" (A.xrefNames).
// FAIL-SAFE: kalau A.xrefNames kosong atau tanggal tidak lengkap, kembalikan extRefs:[], refSeries:{}.
function buildRefSeriesFor(curName, texts){
  const names = (A.xrefNames || []).filter(n => n && n !== curName && texts[n]);
  if(!names.length) return { extRefs: [], refSeries: {} };
  const tgt = parseMarketTextDated(texts[curName]);
  if(!tgt.C.length || tgt.dates.some(d => !d)) return { extRefs: [], refSeries: {} };
  const allDates = tgt.dates.concat([todayStrWIB()]);
  const extRefs = [], refSeries = {};
  names.forEach(refName => {
    const ref = parseMarketTextDated(texts[refName]);
    if(!ref.L || !ref.C.length) return;
    const byDate = {};
    for(let i = 0; i < ref.C.length; i++){ if(ref.dates[i]) byDate[ref.dates[i]] = ref.C[i]; }
    const perPos = [];
    for(let r = 0; r < ref.L; r++) perPos.push(allDates.map(d => (d && byDate[d]) ? byDate[d][r] : -1));
    extRefs.push({ name: refName, L: ref.L });
    refSeries[refName] = perPos;
  });
  return { extRefs, refSeries };
}
function markets(){
  const texts = collectTexts(), res = {};
  Object.keys(texts).forEach(name => {
    const c = A.cache[name];
    if(!c || c.text !== texts[name]) A.cache[name] = { text: texts[name], parsed: B.parseMarketText(texts[name]) };
    const pm = A.cache[name].parsed;
    if(pm.L >= 2 && pm.C.length >= 12) res[name] = pm;
  });
  // pakar HYPE membaca hasil SEMUA pasaran pada tanggal-tanggal terakhir; daftarkan lagi hanya kalau datanya berubah
  const sig = Object.keys(res).sort().map(n => n + ':' + res[n].C.length + ':' + ((res[n].dates || [])[res[n].C.length - 1] || '')).join('|');
  if(sig !== A._hypeSig && typeof B.setHypeMarkets === 'function'){ B.setHypeMarkets(res); A._hypeSig = sig; }
  return res;
}
// Pasaran yang dipakai Ai MENGIKUTI pasaran aktif di dropdown Periode: begitu pasaran aktif berganti,
// A.cur ikut berpindah. Pilihan manual tetap dihormati sampai pasaran aktif berganti lagi.
function pickDefaultCur(ms){
  const act = resolveActive(ms);
  A.activeMiss = act.miss || '';
  if(act.name){
    if(act.name !== A.lastActive){ A.lastActive = act.name; A.cur = act.name; A.pin = {}; A.ban = {}; }
    if(A.cur && ms[A.cur]) return A.cur;
    return act.name;
  }
  if(A.cur && ms[A.cur]) return A.cur;
  if(ms.AKTIF) return 'AKTIF';
  return Object.keys(ms).sort()[0] || null;
}

// ---------- Belajar ----------
function learnOne(name, ms){
  const pm = ms[name]; if(!pm) return null;
  const before = A.states[name] ? A.states[name].t : 0;
  const { extRefs, refSeries } = buildRefSeriesFor(name, collectTexts());
  const st = B.learnMarket(name, pm.C, pm.L, { state: A.states[name], tilt: A.tilt, dates: pm.dates, extRefs, refSeries });
  A.states[name] = st;
  return { st, newRows: Math.max(0, st.t - Math.max(before, B.T0)) };
}
const persistBrainSoon = (() => {
  const timers = {};
  return (name) => {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(() => { if(A.states[name]) persistBrain(name, A.states[name]); }, 1500);
  };
})();
const tick = () => new Promise(r => setTimeout(r, 0));
async function learnAll(){
  const ms = markets(), names = Object.keys(ms).sort();
  if(!names.length){ say('Belum ada data pasaran. Pilih pasaran di Beranda atau impor JSON export (tombol 📥).'); return; }
  A.busy = true; setBusy(true);
  try{
  say('Mulai belajar ' + names.length + ' pasaran: dari 10 data terlama, maju satu-satu sampai data terakhir…');
  const run = async (tilt) => {
    const states = [];
    const texts = collectTexts();
    for(let i = 0; i < names.length; i++){
      const pm = ms[names[i]];
      if(pm.C.length < 20) continue;
      const { extRefs, refSeries } = buildRefSeriesFor(names[i], texts);
      const st = B.learnMarket(names[i], pm.C, pm.L, { tilt, state: tilt === A.tilt ? A.states[names[i]] : null, dates: pm.dates, extRefs, refSeries });
      A.states[names[i]] = st; states.push(st);
      if(i % 4 === 0){ setStatus('Belajar ' + (i + 1) + '/' + names.length + ' · ' + names[i]); await tick(); }
    }
    return states;
  };
  let states = await run(A.tilt);
  const rep = B.globalReport(states);
  const tilt = B.tiltFromReport(rep);
  if(JSON.stringify(tilt) !== JSON.stringify(A.tilt)){
    A.tilt = tilt;
    if(tilt){ say('Pola lintas-pasaran terdeteksi (' + Object.keys(tilt).join(', ') + '). Belajar ulang memakai temuan itu…'); states = await run(tilt); }
  }
  const ev = B.evalAll(states, A.out);
  A.globalNote = 'Semua pasaran, OUT ' + A.out + ': Ai kena ' + ev.pct.toFixed(2) + '% vs acak ' + ev.chance.toFixed(0) + '% (z=' + ev.z.toFixed(2) + ').';
  save();
  states.forEach(st => persistBrain(st.name, st)); // "belajar semua" diminta manual — simpan semua ke cloud sekaligus
  const top = rep[0] && rep[0].z > 0
    ? 'Pakar terbaik lintas pasaran: ' + rep.slice(0, 3).map(r => r.id + ' (z=' + r.z.toFixed(1) + (r.pass ? ', LOLOS' : '') + ')').join(', ') + '.'
    : 'Tidak ada satu pakar pun (formula maupun milik Ai) yang mengalahkan tebakan acak secara konsisten lintas pasaran.';
  say('Selesai belajar ' + states.length + ' pasaran.\n' + A.globalNote + '\nPosisi-pasaran yang “lolos” z>1,64: ' + ev.sig + ' dari ' + ev.trials + ' (kebetulan murni diperkirakan ±' + ev.sigExpected.toFixed(0) + ').\n' + top + '\n' + verdictText(ev.z, ev.sig, ev.sigExpected, ev.sigBonf));
  A.cur = pickDefaultCur(ms);
  }catch(e){
    say('⚠️ Belajar terhenti karena error: ' + (e && e.message ? e.message : e));
  }finally{
    A.busy = false; setBusy(false);
  }
  refreshPredict(true);
}

function verdictText(z, sig, sigExp, sigBonf){
  if(sigBonf > 0) return '✅ Ada ' + sigBonf + ' posisi-pasaran yang tetap signifikan setelah koreksi banyak-uji → kemungkinan pola nyata. Cek dengan “uji”.';
  if(z >= 3) return '✅ Hasil gabungan jauh di atas acak — kemungkinan ada pola nyata.';
  if(z >= 1.645 || sig > sigExp * 1.5) return '🟡 Ada indikasi tipis, tapi belum cukup kuat untuk dipercaya. Terus belajar dengan data baru.';
  return '⚪ Belum ada bukti pola: hasil Ai setara tebakan acak. Ini jawaban jujur dari data saat ini, bukan kegagalan program.';
}

// ---------- Prediksi ----------
function predictCur(){
  const ms = markets(); const name = pickDefaultCur(ms);
  if(!name) return null;
  A.cur = name;
  const r = learnOne(name, ms);
  if(!r) return null;
  const outArg = r.st.L === 0 ? A.out : Array.from({ length: r.st.L }, (_, p) => A.outPos[p] || A.out);
  const pr = B.predict(r.st, ms[name].C, { out: outArg, pin: A.pin, ban: A.ban, famOff: hasOff() ? A.famOff : null, dates: ms[name].dates });
  // dates diteruskan supaya HYPE pakai tanggal yang benar untuk periode berikutnya
  A.lastPred = pr; A.lastNew = r.newRows;
  try{
    const fc = filterCounts(), sg = filterSig(name, ms[name], fc, outArg);
    // hasil filter yang sudah dipelajari + diuji (perintah "filter") dipertahankan selama data/pengaturannya sama; kalau tidak, tampilkan versi model saja
    if(!(A.lastFilter && A.lastFilter.src === 'belajar' && A.lastFilter.sig === sg)){ A.lastFilter = B.filterNumbers(pr, fc); A.lastFilter.src = 'model'; }
  }catch(e){ A.lastFilter = null; console.error('Mode Ai: gagal menghitung angka filter', e); }
  return { name, st: r.st, pr, newRows: r.newRows, n: ms[name].C.length };
}
function hasOff(){ return Object.keys(A.famOff).some(k => A.famOff[k]); }
function refreshPredict(silent){
  const r = predictCur();
  renderAll();
  if(!r && !silent) say('Belum ada data pasaran untuk diprediksi.');
  return r;
}

// ---------- Perintah ----------
const FAMS = { nrl: ['NRL'], ml: ['ML'], mb: ['MB'], idx: ['IDX'], bhg: ['BHG'], pk: ['PK'], sendiri: ['OWN'], own: ['OWN'],
  kombinasi: ['COMBO'], combo: ['COMBO'], formula: ['NRL', 'ML', 'MB', 'IDX', 'BHG', 'PK'] };
function posIdx(ch, L){ const lab = B.posLabels(L); const i = lab.indexOf(String(ch).toUpperCase()); return i; }
function digitsIn(s){ return (String(s).match(/[0-9]/g) || []).map(Number).filter((d, i, a) => a.indexOf(d) === i); }

// Daftar perintah baku (tanpa parameter) yang boleh "diajarkan" lewat kalimat bebas — dipakai
// untuk menebak maksud user saat kalimatnya tidak cocok pola manapun (lihat suggestCommand()).
const CANON_CMDS = [
  { cmd: 'bantuan', label: 'bantuan — lihat daftar perintah', kw: ['bantuan', 'help', 'tolong', 'panduan', 'perintah'] },
  { cmd: 'belajar semua', label: 'belajar semua — Ai belajar semua pasaran', kw: ['belajar', 'pelajari', 'ajari', 'semua', 'sinau'] },
  { cmd: 'belajar', label: 'belajar — pasaran yang aktif saja', kw: ['belajar', 'pelajari', 'update'] },
  { cmd: 'prediksi', label: 'prediksi — tampilkan angka', kw: ['prediksi', 'tebak', 'angka', 'hasil', 'keluaran'] },
  { cmd: 'uji semua', label: 'uji semua — cek akurasi semua pasaran', kw: ['uji', 'tes', 'test', 'cek', 'akurasi', 'semua'] },
  { cmd: 'uji', label: 'uji — cek akurasi pasaran aktif', kw: ['uji', 'tes', 'test', 'cek', 'akurasi'] },
  { cmd: 'eksperimen', label: 'eksperimen — coba gabungan pakar baru', kw: ['eksperimen', 'coba', 'gabung', 'lab'] },
  { cmd: 'kirim', label: 'kirim — kirim angka ke Generator', kw: ['kirim', 'generator', 'pindah', 'transfer'] },
  { cmd: 'isi generator', label: 'isi generator — sekali jalan isi Gen 1, Gen 2, & Filter', kw: ['isi', 'generator', 'penuh', 'gen1', 'gen2', 'lengkap'] },
  { cmd: 'isi gen2', label: 'isi gen2 [A/B/C/semua] — kunci Gen 2 pakai digit terlemah Ai', kw: ['isi', 'gen2', 'gen 2', 'lemah', 'eliminasi'] },
  { cmd: 'filter', label: 'filter — hasilkan & isi semua angka filter Generator', kw: ['filter', 'saring', 'pangkas'] },
  { cmd: 'uji filter', label: 'uji filter — cek akurasi angka filter', kw: ['uji filter', 'tes filter', 'akurasi filter'] },
  { cmd: 'rapor', label: 'rapor — ringkasan hasil belajar', kw: ['rapor', 'ringkasan', 'laporan', 'progres'] }
];
function suggestCommand(t){
  let best = null, bestScore = 0;
  CANON_CMDS.forEach(c => {
    let score = 0;
    c.kw.forEach(k => { if(t.indexOf(k) >= 0) score += k.length; });
    if(score > bestScore){ bestScore = score; best = c; }
  });
  return bestScore >= 6 ? best : null; // dinaikkan dari 4->6: kata umum sehari-hari tidak salah terpicu
}

// Ringkasan Formula X (posisi terpilih + 3 teratas) untuk konteks obrolan bebas — dibaca dari
// formulax.js (FX_RECOMMENDATIONS/FX_SELECTED, dimuat SEBELUM aiMode.js). CATATAN: ini hasil
// perhitungan Formula X untuk pasaran/periode yang SEDANG DIBUKA di tab Formula X — kalau beda
// dari pasaran aktif di chat Mode Ai (A.cur), hasilnya bisa tidak nyambung; disebutkan apa adanya
// supaya AI (dan Anda) tahu itu, bukan dianggap selalu sinkron.
function formulaXSummary(){
  if(typeof FX_RECOMMENDATIONS === 'undefined' || !FX_RECOMMENDATIONS) return 'Formula X: belum pernah dihitung di tab Formula X.';
  const labels = Object.keys(FX_RECOMMENDATIONS);
  if(!labels.length) return 'Formula X: belum pernah dihitung di tab Formula X.';
  const lines = labels.map(label => {
    const recs = FX_RECOMMENDATIONS[label] || [];
    if(!recs.length) return 'Posisi ' + label + ': data belum cukup.';
    const idx = (typeof FX_SELECTED[label] === 'number') ? FX_SELECTED[label] : 0;
    const sel = recs[idx] || recs[0];
    const alt = recs.slice(0, 3).map(r => r.label + ' ' + r.pct.toFixed(1) + '%').join(', ');
    return 'Posisi ' + label + ': terpilih ' + sel.label + ' (' + sel.source + ') ' + sel.pct.toFixed(1) + '% dari ' + sel.hit + '/' + sel.total + ' uji. 3 teratas: ' + alt + '.';
  });
  return 'Formula X (hasil tab Formula X, pasaran/periode yang sedang dibuka di sana):\n' + lines.join('\n');
}
// Ringkasan konteks lengkap (histori + hasil aiBrain + Formula X) — disisipkan ke system prompt
// tiap kali obrolan bebas dipanggil, supaya AI menjawab berdasar data nyata, bukan mengarang.
function contextBlock(){
  const ms = markets();
  const parts = [];
  if(A.cur && ms[A.cur]) parts.push('Pasaran aktif di chat: ' + A.cur + ' (' + ms[A.cur].C.length + ' data histori), OUT=' + A.out + '.');
  else parts.push('Belum ada pasaran aktif dengan data yang cukup di chat.');
  if(A.cur && A.states[A.cur]){
    const ev = B.evalAll([A.states[A.cur]], A.out);
    parts.push('Hasil belajar Ai (aiBrain) di pasaran ini: kena ' + ev.pct.toFixed(1) + '% dari ' + ev.n + ' uji, acak ' + ev.chance.toFixed(0) + '%, z=' + ev.z.toFixed(2) + '.');
  } else {
    parts.push('Ai belum pernah belajar pasaran ini (ketik "belajar").');
  }
  parts.push(formulaXSummary());
  return parts.join('\n');
}

// Tindakan NYATA yang boleh dipicu OTOMATIS lewat tag saran dari LLM (lihat askAiChat di bawah) —
// SENGAJA dibatasi hanya ke 4 aksi yang sudah ada perintah manualnya sendiri dan tidak mengubah
// data pasaran/Generator. LLM boleh "mengajak" ngecek sesuatu, tapi angka selalu dari aiBrain asli.
function runTaggedAction(action, ms, cur){
  if(action === 'prediksi'){
    const r = refreshPredict();
    if(!r) return 'Belum ada data pasaran untuk diprediksi.';
    pushLog('prediksi', r.name, 'OUT ' + A.out + ' · ' + r.pr.length + ' posisi' + (r.newRows ? ' · +' + r.newRows + ' baru' : ''),
      r.pr.map(x => ({ k: x.label, v: x.digits.join(' ') + ' · ' + (x.mass * 100).toFixed(1) + '% vs ' + (x.chance * 100).toFixed(0) + '%' })));
    return predText(r);
  }
  if(action === 'uji'){
    const st = cur && A.states[cur];
    if(!st) return 'Pasaran ini belum dipelajari — ketik "belajar" dulu baru bisa diuji.';
    const rs = B.evalState(st, A.out);
    const lines = rs.map(r => r.label + ': kena ' + r.pct.toFixed(1) + '% (acak ' + r.chance.toFixed(0) + '%) dari ' + r.n + ' uji, z=' + r.z.toFixed(2));
    const anySig = rs.filter(r => r.z > 1.645).length;
    const avgPct = rs.length ? rs.reduce((s, r) => s + r.pct, 0) / rs.length : 0;
    pushLog('uji', cur, 'kena rata² ' + avgPct.toFixed(1) + '% (acak ' + (rs[0] ? rs[0].chance.toFixed(0) : '-') + '%) · ' + anySig + '/' + rs.length + ' lolos',
      rs.map(r => ({ k: r.label, v: 'kena ' + r.pct.toFixed(1) + '% z=' + r.z.toFixed(2) })));
    return 'UJI JUJUR ' + cur + ' (OUT ' + A.out + '):\n' + lines.join('\n') + '\n' + (anySig ? '🟡 ' + anySig + ' dari ' + rs.length + ' posisi terlihat di atas acak — tapi dengan banyak posisi, sebagian wajar kebetulan.' : '⚪ Belum ada bukti pola di pasaran ini, masih setara acak.');
  }
  if(action === 'eksperimen'){
    const st = cur && A.states[cur];
    if(!st) return 'Pasaran ini belum dipelajari — ketik "belajar" dulu baru bisa eksperimen.';
    const r = B.forceLab(st, ms[cur].C); save(); refreshPredict(true); persistBrain(cur, st);
    pushLog('eksperimen', cur, 'dicoba ' + r.tried + ' · diterima ' + r.admitted, [
      { k: 'OUT', v: String(A.out) },
      { k: 'Diterima', v: r.admitted ? 'kombinasi baru dipakai' : 'tidak ada yang lolos' }
    ]);
    return 'Lab eksperimen ' + cur + ': mencoba ' + r.tried + ' gabungan pakar, diterima ' + r.admitted + ' (hanya yang untung nyata di data latih DAN validasi). ' + (r.admitted ? 'Kombinasi baru ikut dipertimbangkan.' : 'Tidak ada yang lolos — wajar kalau datanya memang acak.');
  }
  if(action === 'rapor') return raporText();
  return null;
}

// Jalur cadangan "ngobrol bebas" — dipanggil HANYA kalau kalimat tidak cocok perintah
// terstruktur manapun (dan tidak ada tebakan perintah yang layak). Lewat endpoint Worker
// /api/ai-chat (Cloudflare Workers AI, gratis, tanpa API key di sisi browser).
async function askAiChat(userText){
  if(typeof fetch !== 'function') return say('Ai (obrolan bebas) tidak tersedia di browser ini.');
  setBusy(true); setStatus('Ai sedang berpikir…');
  try{
    const ms = markets(), cur = pickDefaultCur(ms);
    const sys = {
      role: 'system',
      content: 'Anda adalah Ai di sistem Analisa Frekuensi — teman ngobrol sekaligus asisten analisis statistik pribadi milik user. Anda BOLEH ngobrol topik apa saja (hobi, curhat, ide, pertanyaan umum, becanda, dll) — jangan kaku, ikuti alur obrolan dan tanggapi dengan tertarik seperti teman diskusi, bukan cuma mesin jawab-perintah. Kalau obrolan menyenggol data pasaran/Formula X/hasil belajar Ai, pakai KONTEKS di bawah biar nyambung dan akurat.\n\nDua rambu yang WAJIB dijaga apa pun topiknya: (1) JANGAN PERNAH mengarang angka/data yang tidak ada di konteks — kalau tidak tahu/kurang data, bilang terus terang; (2) Anda BUKAN peramal — kalau obrolan mengarah ke "angka apa yang bakal keluar", boleh diskusi santai tapi jangan klaim pasti/yakin di luar apa yang benar-benar terbukti dari data.\n\nFITUR AJAK-CEK: kalau dalam obrolan Anda merasa pas untuk BENERAN mengecek sesuatu di sistem — misal user penasaran "emang beneran ada pola?", atau Anda mau menunjukkan bukti — akhiri balasan Anda dengan SATU baris persis format ini di baris PALING BAWAH (akan disembunyikan dari user, sistem yang akan menjalankan & menunjukkan hasil ASLINYA): [[JALANKAN:uji]] atau [[JALANKAN:eksperimen]] atau [[JALANKAN:prediksi]] atau [[JALANKAN:rapor]]. Pakai HANYA kalau relevan — jangan tiap balasan, dan JANGAN PERNAH menuliskan angka hasil cekannya sendiri (biar sistem yang isi angka aslinya). Di luar itu, jawab senatural mungkin, singkat-santai, Bahasa Indonesia.\n\nKONTEKS SAAT INI:\n' + contextBlock()
    };
    const hist = A.chat.slice(-9, -1).map(m => ({ role: m.who === 'user' ? 'user' : 'assistant', content: m.text }));
    const messages = [sys].concat(hist, [{ role: 'user', content: userText }]);
    const resp = await fetch('/api/ai-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    const j = await resp.json();
    if(!j || !j.ok){ say('⚠️ Ai (obrolan bebas) gagal menjawab: ' + (j && j.error ? j.error : 'tidak diketahui')); return; }
    const rawReply = j.reply || '(jawaban kosong)';
    // Pisahkan tag [[JALANKAN:xxx]] dari teks yang ditampilkan — tag tidak pernah ditampilkan ke user
    const tagMatch = rawReply.match(/\[\[JALANKAN:(uji|eksperimen|prediksi|rapor)\]\]\s*$/i);
    const cleanReply = tagMatch ? rawReply.slice(0, tagMatch.index).trim() : rawReply;
    say(cleanReply);
    if(tagMatch){
      const action = tagMatch[1].toLowerCase();
      const realResult = runTaggedAction(action, ms, cur);
      if(realResult) say('📊 (dicek langsung, ini hasil asli dari data — bukan kata Ai obrolan)\n' + realResult);
    }
  }catch(e){
    say('⚠️ Gagal menghubungi otak Ai: ' + (e && e.message ? e.message : e));
  }finally{
    setBusy(false); renderAll();
  }
}

async function run(text){
  const raw = String(text || '').trim(); if(!raw) return;
  say(raw, 'user');
  try{ return await handle(raw); }
  catch(e){ console.error('Mode Ai: error saat menjalankan perintah', e); say('⚠️ Ada error saat menjalankan perintah: ' + (e && e.message ? e.message : e)); }
}

async function handle(rawText){
  const t = String(rawText || '').trim().toLowerCase(); if(!t) return;
  const ms = markets(); const cur = pickDefaultCur(ms); const L = (cur && ms[cur]) ? ms[cur].L : 4;
  let m;

  // 1) Ada saran yang menunggu konfirmasi ("Maksud Anda...? ya/tidak")
  if(A.pendingTeach){
    const pt = A.pendingTeach; A.pendingTeach = null;
    if(/^(ya|iya|y|benar|betul|ok|oke)$/.test(t)){
      A.patterns[pt.phrase] = pt.cmd;
      if(typeof AiMemory !== 'undefined') AiMemory.savePatterns(A.patterns);
      say('Oke, sudah saya ingat — lain kali cukup ketik seperti itu lagi, saya langsung mengerti.');
      return handle(pt.cmd);
    }
    if(/^(tidak|bukan|no|nggak|gak)$/.test(t)) return say('Baik, diabaikan. Ketik “bantuan” untuk lihat daftar perintah.');
    // bukan jawaban ya/tidak — anggap ini perintah baru, lanjut proses seperti biasa di bawah
  }

  // 2) Kalimat yang sudah pernah "diajarkan" sebelumnya — langsung jalankan perintah aslinya
  if(A.patterns[t]) return handle(A.patterns[t]);

  if(/^(bantuan|help|\?)$/.test(t)) return say(helpText());
  if((m = t.match(/^out\s+(reset|semua)$/))){ A.outPos = {}; A.out = 8; refreshPredict(true); return say('OUT dikembalikan ke 8 untuk semua posisi.'); }
  if((m = t.match(/^out\s+(?:([a-z])\s+)?([1-9])$/))){
    const n = +m[2]; if(n < 4 || n > 9) return say('OUT harus 4–9.');
    if(m[1]){ const i = posIdx(m[1], L); if(i < 0) return say('Posisi “' + m[1] + '” tidak ada. Posisi: ' + B.posLabels(L).join(', ')); A.outPos[i] = n; }
    else { A.out = n; A.outPos = {}; }
    save(); refreshPredict(true); return say('Siap, OUT ' + (m[1] ? m[1].toUpperCase() + ' = ' : 'semua posisi = ') + n + '.');
  }
  if((m = t.match(/^(?:pasaran|ganti|pilih)\s+(.+)$/))){
    const q = m[1].trim().toUpperCase(); const name = Object.keys(ms).find(k => k.toUpperCase() === q);
    if(!name) return say('Pasaran “' + q + '” tidak ada di data. Contoh: ' + Object.keys(ms).slice(0, 6).join(', ') + '…');
    A.cur = name; A.pin = {}; A.ban = {}; refreshPredict(true); return say('Pindah ke pasaran ' + name + '.');
  }
  if(/^(prediksi|angka(?!\s+filter)|hasil|tebak)/.test(t)){
    const r = refreshPredict();
    if(r){
      say(predText(r));
      pushLog('prediksi', r.name, 'OUT ' + A.out + ' · ' + r.pr.length + ' posisi' + (r.newRows ? ' · +' + r.newRows + ' baru' : ''),
        r.pr.map(x => ({ k: x.label, v: x.digits.join(' ') + ' · ' + (x.mass * 100).toFixed(1) + '% vs ' + (x.chance * 100).toFixed(0) + '%' })));
    }
    return;
  }
  if(/^belajar\s*semua/.test(t)) return learnAll();
  if(/^belajar/.test(t)){
    if(!cur) return say('Belum ada data pasaran.');
    const r = learnOne(cur, ms); save(); refreshPredict(true); persistBrain(cur, r.st);
    return say(cur + ': Ai sudah belajar sampai data ke-' + ms[cur].C.length + (r.newRows ? ' (+' + r.newRows + ' data baru)' : ' (tidak ada data baru)') + '.');
  }
  if(/^uji\s+filter/.test(t)) return runFilterTest();
  if(/^uji\s*semua/.test(t)){
    const sts = Object.keys(A.states).map(k => A.states[k]);
    if(!sts.length) return say('Belum ada yang dipelajari. Ketik “belajar semua” dulu.');
    const ev = B.evalAll(sts, A.out);
    pushLog('uji_semua', sts.length + ' pasaran', 'kena ' + ev.pct.toFixed(2) + '% dari ' + ev.n + ' uji · lolos ' + ev.sig + '/' + ev.trials, [
      { k: 'Acak', v: ev.chance.toFixed(0) + '%' },
      { k: 'z', v: ev.z.toFixed(2) },
      { k: 'Lolos Bonferroni', v: String(ev.sigBonf) },
      { k: 'Top', v: ev.top.map(r => r.name + ' ' + r.label + ' z=' + r.z.toFixed(1)).join(' · ') || '-' }
    ]);
    return say('UJI JUJUR semua pasaran (OUT ' + A.out + ', tiap prediksi hanya memakai data sebelumnya):\nAi kena ' + ev.pct.toFixed(2) + '% dari ' + ev.n + ' tebakan-digit; acak murni ' + ev.chance.toFixed(0) + '%; z=' + ev.z.toFixed(2) + '.\nPosisi-pasaran lolos z>1,64: ' + ev.sig + '/' + ev.trials + ' (kebetulan diperkirakan ±' + ev.sigExpected.toFixed(0) + '); lolos setelah koreksi banyak-uji: ' + ev.sigBonf + '.\n' + verdictText(ev.z, ev.sig, ev.sigExpected, ev.sigBonf));
  }
  if(/^uji/.test(t)){
    const st = cur && A.states[cur]; if(!st) return say('Pasaran ini belum dipelajari. Ketik “belajar”.');
    const rs = B.evalState(st, A.out);
    const lines = rs.map(r => r.label + ': kena ' + r.pct.toFixed(1) + '% (acak ' + r.chance.toFixed(0) + '%) dari ' + r.n + ' uji, z=' + r.z.toFixed(2) + ' · paruh awal ' + r.pctA.toFixed(0) + '% → paruh akhir ' + r.pctB.toFixed(0) + '%');
    const anySig = rs.filter(r => r.z > 1.645).length;
    const avgPct = rs.length ? rs.reduce((s, r) => s + r.pct, 0) / rs.length : 0;
    pushLog('uji', cur, 'kena rata² ' + avgPct.toFixed(1) + '% (acak ' + (rs[0] ? rs[0].chance.toFixed(0) : '-') + '%) · ' + anySig + '/' + rs.length + ' lolos',
      rs.map(r => ({ k: r.label, v: 'kena ' + r.pct.toFixed(1) + '% z=' + r.z.toFixed(2) + ' · awal ' + r.pctA.toFixed(0) + '%→akhir ' + r.pctB.toFixed(0) + '%' })));
    return say('UJI JUJUR ' + cur + ' (OUT ' + A.out + ', mulai baris ke-' + B.EVAL_FROM + '):\n' + lines.join('\n') + '\n' + (anySig ? '🟡 ' + anySig + ' dari ' + rs.length + ' posisi terlihat di atas acak; dengan banyak posisi dan pasaran, sebagian pasti kebetulan. Bandingkan dengan “uji semua”.' : '⚪ Belum ada bukti pola di pasaran ini.'));
  }
  if(/^(eksperimen|lab)/.test(t)){
    const st = cur && A.states[cur]; if(!st) return say('Pasaran ini belum dipelajari. Ketik “belajar”.');
    const r = B.forceLab(st, ms[cur].C); save(); refreshPredict(true); persistBrain(cur, st);
    pushLog('eksperimen', cur, 'dicoba ' + r.tried + ' · diterima ' + r.admitted, [
      { k: 'OUT', v: String(A.out) },
      { k: 'Diterima', v: r.admitted ? 'kombinasi baru dipakai' : 'tidak ada yang lolos' }
    ]);
    return say('Lab eksperimen ' + cur + ': mencoba ' + r.tried + ' gabungan pakar, diterima ' + r.admitted + ' (hanya yang untung nyata di data latih DAN validasi). ' + (r.admitted ? 'Kombinasi baru ikut dipertimbangkan, tapi bobotnya tetap ditentukan hasil nyata ke depan.' : 'Tidak ada yang lolos — itu wajar kalau datanya memang acak.'));
  }
  if((m = t.match(/^(?:kenapa|alasan|jelaskan)(?:\s+([a-z]))?/))){
    const st = cur && A.states[cur]; if(!st) return say('Pasaran ini belum dipelajari.');
    const idxs = m[1] ? [posIdx(m[1], L)] : Array.from({ length: L }, (_, i) => i);
    if(idxs.some(i => i < 0)) return say('Posisi tidak dikenal. Posisi: ' + B.posLabels(L).join(', '));
    return say(idxs.map(i => explainText(B.explain(st, i, ms[cur].C))).join('\n\n'));
  }
  if((m = t.match(/^pin\s+([a-z])\s+(.+)$/))){
    const i = posIdx(m[1], L), d = digitsIn(m[2]); if(i < 0 || !d.length) return say('Format: pin A 3 5');
    A.pin[i] = d; if(A.ban[i]) A.ban[i] = A.ban[i].filter(x => d.indexOf(x) < 0);
    refreshPredict(true); return say('Siap. Posisi ' + m[1].toUpperCase() + ' wajib memuat ' + d.join(', ') + '.');
  }
  if((m = t.match(/^buang\s+([a-z])\s+(.+)$/))){
    const i = posIdx(m[1], L), d = digitsIn(m[2]); if(i < 0 || !d.length) return say('Format: buang C 7');
    A.ban[i] = d; if(A.pin[i]) A.pin[i] = A.pin[i].filter(x => d.indexOf(x) < 0);
    refreshPredict(true); return say('Siap. Posisi ' + m[1].toUpperCase() + ' tidak memuat ' + d.join(', ') + '.');
  }
  if(/^(lepas|reset)/.test(t)){ A.pin = {}; A.ban = {}; A.famOff = {}; A.outPos = {}; refreshPredict(true); return say('Semua perintah khusus (pin/buang/matikan pakar/OUT per posisi) dilepas.'); }
  if((m = t.match(/^tanpa\s+(\w+)/))){
    const f = FAMS[m[1]]; if(!f) return say('Kelompok pakar: ' + Object.keys(FAMS).join(', '));
    f.forEach(x => { A.famOff[x] = true; }); refreshPredict(true); return say('Siap. Ai tidak memakai ' + m[1].toUpperCase() + ' untuk prediksi.');
  }
  if((m = t.match(/^dengan\s+(\w+)/))){
    const f = FAMS[m[1]]; if(!f) return say('Kelompok pakar: ' + Object.keys(FAMS).join(', '));
    f.forEach(x => { delete A.famOff[x]; }); refreshPredict(true); return say('Siap. ' + m[1].toUpperCase() + ' dipakai lagi.');
  }
  if((m = t.match(/^hanya\s+(\w+)/))){
    const f = FAMS[m[1]]; if(!f) return say('Kelompok pakar: ' + Object.keys(FAMS).join(', '));
    A.famOff = {}; ['NRL', 'ML', 'MB', 'IDX', 'BHG', 'PK', 'OWN', 'COMBO'].forEach(x => { if(f.indexOf(x) < 0) A.famOff[x] = true; });
    refreshPredict(true); return say('Siap. Ai hanya memakai ' + m[1].toUpperCase() + '.');
  }
  if(/^pakar/.test(t)){
    const off = Object.keys(A.famOff).filter(k => A.famOff[k]);
    return say('Kelompok pakar: NRL, ML, MB, IDX, BHG, PK (formula Formula X), SENDIRI (frekuensi, jarak, transisi, pengulangan), KOMBINASI (hasil lab). Dimatikan: ' + (off.length ? off.join(', ') : 'tidak ada') + '.');
  }
  if((m = t.match(/^filter\s+ikut\s+(\d+)$/))){
    const n = +m[1]; if(n < 1 || n > 9) return say('Angka Ikut harus 1–9 digit.');
    A.nIkut = n; save(); refreshPredict(true); return say('Siap. Filter Angka Ikut sekarang ' + n + ' digit. Ketik “filter” untuk mengisinya ke Generator.');
  }
  if(/^(?:angka\s+)?filter/.test(t)) return runFilter();
  if(/^(isi\s*generator|generator\s*penuh|isi\s*semua)/.test(t)) return fillGeneratorFull();
  if((m = t.match(/^isi\s*gen\s*2\s*(a|b|c|semua|all)?$/))) return fillGen2FromAi(m[1]);
  if(/^kirim\s*semua/.test(t)) return sendToGenerator(true);
  if(/^kirim/.test(t)) return sendToGenerator();
  if(/^rapor/.test(t)) return say(raporText());
  if(/^sumber/.test(t)){
    const fb = readFirebaseMap(), fbN = Object.keys(fb).length, imN = Object.keys(A.imported).length;
    const dup = Object.keys(A.imported).filter(k => k in fb).length;
    let shape = '(peta Firebase kosong / tidak ditemukan)';
    try{
      const ents = (typeof firebaseMarketMap !== 'undefined' && firebaseMarketMap) ? ((firebaseMarketMap instanceof Map) ? Array.from(firebaseMarketMap.entries()) : Object.entries(firebaseMarketMap)) : [];
      if(ents.length){ const [k, v] = ents[0]; shape = 'contoh entri: kunci "' + k + '" → ' + (typeof v === 'string' ? 'teks' : 'objek {' + Object.keys(v || {}).slice(0, 6).join(', ') + '}') + (v && v.name ? ', name "' + v.name + '"' : ''); }
    }catch(e){}
    const act = resolveActive(ms);
    return say('SUMBER DATA Ai:\n• Pasaran aktif di Periode: ' + (activeLabels().join(' | ') || '(tidak ada)') + '\n• Cocok di Ai: ' + (act.name ? act.name + ' (sumber ' + (A.src[act.name] || '?') + ')' : '⚠️ TIDAK ADA' + (act.miss ? ' (label "' + act.miss + '")' : '')) + '\n• Ai sedang memakai: ' + (cur || '-') + (cur ? ' (' + (A.src[cur] || '?') + ', ' + ms[cur].C.length + ' data)' : '') + '\n• Pasaran dari Firebase: ' + fbN + ' · dari impor JSON: ' + imN + (dup ? ' (' + dup + ' nama sama dgn Firebase → Firebase yang dipakai)' : '') + '\n• ' + shape);
  }
  if((m = t.match(/^kunci(?:\s+(.*))?$/))){
    const arg = (m[1] || '').trim();
    if(!arg){
      return say(A.xrefNames.length
        ? 'Pasaran kunci (referensi silang) saat ini: ' + A.xrefNames.join(', ') + '. Ketik "kunci NAMA1,NAMA2" utk ganti, atau "kunci mati" utk matikan.'
        : 'Belum ada pasaran kunci diatur (fitur silang-pasaran mati). Ketik mis. "kunci HK,SDY,SGP" utk mengaktifkan.');
    }
    if(/^(mati|off|nonaktif|kosong|hapus)$/.test(arg)){
      A.xrefNames = []; A.states = {}; save();
      return say('Pasaran kunci dimatikan. Semua hasil belajar direset bersih (supaya susunan pakar konsisten) — ketik "belajar semua" utk mulai lagi.');
    }
    const names = arg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    A.xrefNames = names; A.states = {}; save();
    return say('Pasaran kunci diset: ' + names.join(', ') + '. Semua hasil belajar direset bersih (supaya susunan pakar konsisten dgn kunci baru) — ketik "belajar semua" utk mulai lagi. Nama yang tidak ketemu datanya otomatis dilewati saat belajar.');
  }
  if((m = t.match(/^(?:tampilkan|lihat)\s+test\s+(.+)$/))){
    const q = m[1].trim().toUpperCase();
    const name = Object.keys(A.states).find(k => k.toUpperCase() === q);
    if(!name) return say('Pasaran “' + m[1].trim() + '” belum pernah dipelajari Ai (tidak ada di ingatan). Ketik “belajar semua” dulu, atau buka datanya lalu ketik “belajar”.');
    const st = A.states[name], rs = B.evalState(st, A.out);
    const lines = rs.map(r => r.label + ': kena ' + r.pct.toFixed(1) + '% (acak ' + r.chance.toFixed(0) + '%) dari ' + r.n + ' uji, z=' + r.z.toFixed(2));
    return say('Hasil test tersimpan untuk ' + name + ' (OUT ' + A.out + '), langsung dari ingatan — tidak dihitung ulang:\n' + lines.join('\n'));
  }

  // Tidak ada pola yang cocok — coba tebak dulu sebelum menyerah, supaya bisa "diajarkan"
  const guess = suggestCommand(t);
  if(guess){
    A.pendingTeach = { phrase: t, cmd: guess.cmd };
    return say('Perintah belum saya kenali. Maksud Anda “' + guess.label + '”? (jawab ya/tidak)');
  }
  // Bukan perintah & tidak mirip perintah manapun — anggap obrolan bebas, lempar ke otak Ai
  return askAiChat(rawText);
}

function helpText(){
  return 'Perintah:\n• out 6 / out A 7 / out reset\n• pasaran BJI\n• prediksi\n• belajar / belajar semua\n• uji / uji semua\n• tampilkan test [pasaran] (dari ingatan, tanpa hitung ulang)\n• eksperimen (lab gabung pakar)\n• kenapa / kenapa A\n• pin A 3 5 · buang C 7 · lepas\n• tanpa bhg · dengan bhg · hanya sendiri · pakar\n• kunci HK,SDY,SGP (referensi silang-pasaran) · kunci mati\n• sumber (cek data mana yang dipakai Ai)\n• filter (belajar + uji + isi semua angka filter) · uji filter (hanya uji) · filter ikut 5\n• kirim (ke Generator) · kirim semua (pool + filter) · isi generator (sekali jalan: Gen 1 → Gen 2 → Filter) · isi gen2 A/B/C/semua (kunci Gen 2 pakai digit terlemah Ai) · rapor\n\nKalau kalimat Anda tidak mirip perintah manapun, saya coba tebak & tanya konfirmasi dulu (sekali dikonfirmasi, saya ingat terus). Kalau memang bukan perintah, saya jawab santai lewat obrolan bebas.';
}
function predText(r){
  return 'Pasaran ' + r.name + ' (' + r.n + ' data' + (r.newRows ? ', +' + r.newRows + ' baru dipelajari' : '') + '):\n' + r.pr.map(x => x.label + ' [' + x.digits.join(' ') + '] · peluang gabungan ' + (x.mass * 100).toFixed(1) + '% vs acak ' + (x.chance * 100).toFixed(0) + '%' + (x.wNull > 0.5 ? ' ≈ acak' : '')).join('\n') + '\n' + (r.pr.every(x => x.wNull > 0.5) ? 'Ai sendiri menilai belum ada pola yang terbukti di pasaran ini — angka di atas hampir setara pilihan acak.' : 'Selisih kecil dari acak itu normal; cek “uji” untuk bukti ke belakang.');
}
function backtestLine(r){
  const st = r.st; if(!st) return '';
  const outs = r.pr.map(x => x.out);
  const rs = B.evalState(st, A.out);
  let n = 0, h = 0, ch = 0;
  rs.forEach((x, i) => { n += x.n; h += x.hits; ch += x.n * outs[i] / 10; });
  return n ? 'Uji ke belakang di pasaran ini: kena ' + (h / n * 100).toFixed(1) + '% dari ' + n + ' tebakan-digit (acak ±' + (ch / n * 100).toFixed(1) + '%).' : '';
}
function explainText(e){
  const top = e.top.map(t => t.name + ' ' + (t.w * 100).toFixed(0) + '%').join(', ');
  const best = e.best.map(t => t.name + ' (' + (t.adv >= 0 ? '+' : '') + (t.adv * 1000).toFixed(1) + ')').join(', ');
  return 'Posisi ' + e.label + ': bobot terbesar → ' + top + '.\nBobot “acak murni”: ' + (e.wNull * 100).toFixed(0) + '%' + (e.wNull > 0.5 ? ' — Ai ragu: belum ada pakar yang terbukti mengalahkan acak.' : ' — Ai condong ke pakar di atas. Catatan: di data sesedikit ini kecenderungan itu bisa kebetulan; nilai sebenarnya dilihat dari “uji”.') + '\nKeuntungan terkini terbaik (satuan ‰ log-peluang vs acak): ' + best + '.' + (e.combos ? '\nKombinasi buatan Ai aktif: ' + e.combos + '.' : '');
}
function raporText(){
  const sts = Object.keys(A.states).map(k => A.states[k]);
  if(!sts.length) return 'Belum ada yang dipelajari.';
  let sa = 0, sb = 0, c = 0;
  sts.forEach(st => B.evalState(st, A.out).forEach(r => { if(r.n > 20){ sa += r.pctA; sb += r.pctB; c++; } }));
  const chance = A.out * 10;
  return 'RAPOR BELAJAR (OUT ' + A.out + ', ' + sts.length + ' pasaran): paruh awal masa uji ' + (sa / c).toFixed(2) + '% → paruh akhir ' + (sb / c).toFixed(2) + '% (acak ' + chance + '%).\n' + (Math.abs(sb / c - chance) < 0.7 && Math.abs(sa / c - chance) < 0.7 ? 'Keduanya masih setara acak: Ai belum menemukan pola yang membuatnya lebih baik dari tebakan.' : 'Ada selisih dari acak; pastikan dengan “uji semua” (memakai uji signifikansi).') + '\nTiap data baru yang masuk otomatis dipelajari (tanpa mengulang dari awal).';
}

async function sendToGenerator(withFilter){
  const pr = A.lastPred; if(!pr) return say('Belum ada prediksi. Ketik “prediksi”.');
  await ensureGen1Ready();
  const pools = pr.map(x => x.digits.map(String));
  try{ lastTop8Pools = pools; }catch(e){}
  const bo = document.getElementById('bulkOut'); if(!bo) return say('Kolom Generator (#bulkOut) tidak ditemukan.');
  bo.value = pools.map(p => p.join('')).join('.');
  try{
    if(typeof generateCombineOutput === 'function') generateCombineOutput();
    const fc = document.getElementById('filterCard');
    if(fc && fc.style.display === 'block' && typeof resetFilters === 'function') resetFilters();
  }catch(e){ return say('Angka masuk kolom Generator, tapi pembuatan kombinasi gagal: ' + e.message); }
  const lockRes = lockGen1FromAi(pr);
  const lockNote = lockRes.ok ? '🔒 Gen 1 dikunci pakai angka ini (tidak akan ditimpa Formula X).' : '⚠️ Gen 1 belum bisa dikunci: ' + lockRes.msg;
  say('Angka Ai dikirim ke Generator: ' + bo.value + '\n' + lockNote);
  if(withFilter) await runFilter();
  if(typeof window.goPage === 'function') window.goPage('generator');
}

// ---------- Isi Generator sekali jalan: Gen 1 -> Gen 2 -> Filter ----------
// Dipicu perintah "isi generator". Memakai jalur resmi yang sama dengan tombol manual di UI
// (fxAutoGenerate/fxManualGenerateFromGen1, fxAutoGenToFilterBtn) supaya perilakunya identik
// dengan dipakai manual — tidak menduplikasi logika Gen1/Gen2, cuma mengurutkan pemanggilannya.
// Kalau Mode Auto sedang aktif, matikan dulu — bukan buka kunci Gen 1 lalu dibiarkan terbuka
// (yang lama), karena Gen 1 mau langsung DIKUNCI ULANG pakai pool Ai (lihat lockGen1FromAi).
// Kalau dibiarkan Mode Auto tetap jalan, siklus fxAutoLockGen1FromPreset berikutnya akan
// menimpa balik kunci Ai ini.
async function ensureGen1Ready(){
  if(typeof getAppMode !== 'function' || getAppMode() !== 'auto') return;
  say('Mode Auto sedang aktif — mematikan dulu supaya kunci Gen 1 dari Ai tidak ditimpa balik…');
  if(typeof stopAutoMode === 'function') stopAutoMode('normal');
  for(let i = 0; i < 25 && getAppMode() === 'auto'; i++) await new Promise(res => setTimeout(res, 80));
}

// Kunci Gen 1 pakai pool prediksi Ai sendiri — mirror tombol manual "🔒 LOCK GEN 1", tapi
// poolnya dari A.lastPred (bukan dihitung ulang lewat fxBuildGen1Pools/Formula X). Diperlakukan
// sebagai kunci MANUAL (fxGen1SemiAutoLocked & fxGen1AutoLocked tetap false) supaya kebal dari
// render Formula X biasa — cuma lepas kalau user klik 🔓 UNLOCK GEN 1 sendiri, ganti
// pasaran/periode, atau ganti mode. TIDAK say()/pushLog sendiri, sama pola dengan
// lockGen2SlotsFromAi, supaya pemanggil bebas menyusun pesannya sendiri.
function lockGen1FromAi(pr){
  if(typeof fxGen1Locked === 'undefined') return { ok: false, msg: 'Fitur Lock Gen 1 tidak ditemukan di halaman ini.' };
  if(!pr || !pr.length) return { ok: false, msg: 'Belum ada prediksi Ai untuk dijadikan Gen 1.' };
  if(typeof lastPosLabels === 'undefined' || !lastPosLabels || pr.length !== lastPosLabels.length){
    return { ok: false, msg: 'Jumlah posisi prediksi Ai (' + pr.length + ') tidak cocok dengan Generator (' + (typeof lastPosLabels !== 'undefined' && lastPosLabels ? lastPosLabels.length : '?') + ').' };
  }
  const pools = pr.map(x => x.digits.map(String));
  fxGen1AutoLocked = false;
  fxGen1Locked = true;
  fxGen1LockedPools = pools;
  fxGen1LockedPosLabels = lastPosLabels.slice();
  fxGen1LockedFP = (typeof dataFingerprint === 'function' && typeof lastHistoryNumbers !== 'undefined') ? dataFingerprint(lastHistoryNumbers) : '';
  fxGen1LockedRule = { trendN: '-', controlN: '-', outN: '-', stats: '-' }; // bukan dari Formula X, tidak relevan
  if(typeof fxClearStreakGen1List === 'function') fxClearStreakGen1List();
  if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
  return { ok: true, pools };
}
async function fillGeneratorFull(){
  if(typeof lastTop8Pools === 'undefined' || !document.getElementById('bulkOut')){
    return say('Fitur Generator tidak ditemukan di halaman ini.');
  }
  if(!A.lastPred){ const r = refreshPredict(); if(!r) return say('Belum ada data pasaran untuk diisi ke Generator.'); }
  const pr = A.lastPred;

  await ensureGen1Ready();

  // 1) Pool Ai -> Generator ("Kombinasi Acak")
  const pools = pr.map(x => x.digits.map(String));
  try{ lastTop8Pools = pools; }catch(e){}
  const bo = document.getElementById('bulkOut'); if(!bo) return say('Kolom Generator (#bulkOut) tidak ditemukan.');
  bo.value = pools.map(p => p.join('')).join('.');
  try{ if(typeof generateCombineOutput === 'function') generateCombineOutput(); }
  catch(e){ return say('Angka masuk kolom Generator, tapi pembuatan kombinasi gagal: ' + e.message); }

  // 2) Kunci Gen 1 pakai pool Ai (supaya kebal ditimpa Formula X), lalu Gen 2 (kartu Auto
  // Generator Formula X), kalau Formula X sudah dihitung di halaman ini.
  const gen1LockRes = lockGen1FromAi(pr);
  const gen1LockNote = gen1LockRes.ok ? '🔒 Gen 1 dikunci pakai angka Ai.' : '⚠️ Gen 1 belum bisa dikunci: ' + gen1LockRes.msg + ' (angka tetap dikirim, tapi bisa ditimpa Formula X kalau data berganti)';
  let gen12Note = 'Formula X belum dihitung di halaman ini — kartu Gen 1/Gen 2 dilewati, cuma pool & filter yang diisi.';
  let elimCount = 0, finalCount = pools.reduce((a, p) => a * (p.length || 1), 1);
  if(typeof lastPosLabels !== 'undefined' && lastPosLabels && typeof lastHistoryNumbers !== 'undefined' && lastHistoryNumbers.length){
    try{
      // Isi Gen 2 (2A/2B/2C) dulu pakai digit terlemah Ai, sebelum pipeline eliminasi dijalankan —
      // sama seperti "isi gen2 semua", tapi jadi satu paket dengan "isi generator".
      const gen2Res = lockGen2SlotsFromAi(['A', 'B', 'C']);
      const gen2Note = gen2Res.ok ? gen2Res.lines.join(' · ') : '⚠️ Gen 2: ' + gen2Res.msg;

      // Gen 1 sudah terkunci (gen1LockRes.ok) -> pakai fxAutoGenerate (baca fxGen1LockedPools,
      // sama pool yang barusan dikunci). Kalau lock gagal, fallback ke jalur lama
      // (fxManualGenerateFromGen1, baca lastTop8Pools) supaya fitur tetap jalan.
      if(gen1LockRes.ok && typeof fxAutoGenerate === 'function') fxAutoGenerate();
      else if(typeof fxManualGenerateFromGen1 === 'function') fxManualGenerateFromGen1();
      const out = document.getElementById('fxAutoGenOut');
      if(out && out.value){
        const fb = document.getElementById('fxAutoGenToFilterBtn'); if(fb) fb.click();
        const cntEl = document.getElementById('fxAutoGenCount'), elimEl = document.getElementById('fxAutoEliminasiCount');
        finalCount = cntEl ? parseInt(cntEl.textContent, 10) || finalCount : finalCount;
        elimCount = elimEl ? parseInt(elimEl.textContent, 10) || 0 : 0;
        gen12Note = gen1LockNote + '\nGen 1 diisi ' + pools.length + ' posisi dari angka Ai → ' + finalCount + ' kombinasi' + (elimCount ? ' (' + elimCount + ' dieliminasi Gen 2).' : ' (Gen 2 tidak mengeliminasi apa pun).') + '\nGen 2: ' + gen2Note;
      } else {
        gen12Note = gen1LockNote + '\nGen 1 diisi dari angka Ai, tapi proses Generate belum menghasilkan apa-apa (cek posisi Formula X).\nGen 2: ' + gen2Note;
      }
    }catch(e){ gen12Note = '⚠️ Gen 1/Gen 2 gagal diisi: ' + (e && e.message ? e.message : e); }
  } else {
    gen12Note = gen1LockNote + '\n' + gen12Note;
  }
  say('🧩 Isi Generator: pool Ai dikirim (' + bo.value + ').\n' + gen12Note);

  // 3) Filter Pangkas Kombinasi (isi + terapkan, pakai fungsi Ai yang sudah ada)
  await runFilter();

  pushLog('generator', A.cur || '-', gen12Note, [
    { k: 'Pool Gen 1', v: bo.value },
    { k: 'Kombinasi akhir', v: String(finalCount) + (elimCount ? ' (−' + elimCount + ' Gen 2)' : '') }
  ]);
  if(typeof window.goPage === 'function') window.goPage('generator');
}

// ---------- Isi Gen 2 (2A/2B/2C) pakai digit PALING LEMAH menurut Ai ----------
// Beda arah dari prediksi biasa: predict() sudah menghitung peluang SEMUA 10 digit per posisi
// (bukan cuma top-N yang ditampilkan) lewat field x.P — di sini diambil yang paling KECIL
// peluangnya, karena Gen 2 memang dipakai untuk ELIMINASI (bukan pilihan utama).
// Jumlah digit/posisi mengikuti pola bawaan app (WORST_RANK_BY_SLOT: 2A=1, 2B=2, 2C=3) supaya
// konsisten dengan makna "peringkat terburuk ke-N" yang sudah ada di Formula X.
function weakDigitsPools(n){
  const pr = A.lastPred; if(!pr) return null;
  return pr.map(x => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].slice().sort((a, b) => x.P[a] - x.P[b]); // lemah -> kuat
    return order.slice(0, n).sort((a, b) => a - b).map(String);
  });
}
// Inti pengisian Gen 2 (dipakai bareng oleh "isi generator" & "isi gen2") — TIDAK say()/pushLog
// sendiri, cuma mengunci state + render kartu, supaya pemanggil bebas menyusun pesannya sendiri.
function lockGen2SlotsFromAi(slots){
  if(typeof fxGen2State === 'undefined') return { ok: false, msg: 'Fitur Gen 2 tidak ditemukan di halaman ini.' };
  if(!A.lastPred) return { ok: false, msg: 'Belum ada prediksi Ai untuk dijadikan Gen 2.' };
  if(typeof lastPosLabels === 'undefined' || !lastPosLabels || A.lastPred.length !== lastPosLabels.length){
    return { ok: false, msg: 'Jumlah posisi prediksi Ai (' + A.lastPred.length + ') tidak cocok dengan Generator (' + (typeof lastPosLabels !== 'undefined' && lastPosLabels ? lastPosLabels.length : '?') + ').' };
  }
  const NBY = { A: 1, B: 2, C: 3 };
  const lines = [];
  slots.forEach(sl => {
    const n = NBY[sl];
    const pools = weakDigitsPools(n);
    const s = fxGen2State[sl];
    s.locked = true; s.pools = pools; s.posLabels = lastPosLabels.slice();
    s.fp = (typeof dataFingerprint === 'function' && typeof lastHistoryNumbers !== 'undefined') ? dataFingerprint(lastHistoryNumbers) : '';
    s.rule = null; s.picks = null; s.formulaInfo = null; s.method = 'ai-weak';
    if(typeof renderGen2LockUI === 'function') renderGen2LockUI(sl);
    const info = document.getElementById('fxGen2' + sl + 'RuleInfo');
    if(info) info.textContent = 'Sumber: Ai (' + n + ' digit terlemah/posisi)';
    lines.push('2' + sl + ': ' + n + ' digit terlemah/posisi → ' + pools.map(p => p.join('')).join('.'));
  });
  return { ok: true, lines };
}
async function fillGen2FromAi(arg){
  if(!A.lastPred){ const r = refreshPredict(); if(!r) return say('Belum ada data pasaran untuk dijadikan Gen 2.'); }
  const a = (arg || '').trim().toUpperCase();
  let slots;
  if(!a || a === 'A') slots = ['A'];
  else if(a === 'B') slots = ['B'];
  else if(a === 'C') slots = ['C'];
  else if(a === 'SEMUA' || a === 'ALL') slots = ['A', 'B', 'C'];
  else return say('Slot Gen 2 tidak dikenal. Pakai: isi gen2 A / B / C / semua.');

  const res = lockGen2SlotsFromAi(slots);
  if(!res.ok) return say(res.msg);
  say('🧩 Gen 2 diisi dari Ai (digit paling lemah/jarang keluar per posisi):\n' + res.lines.join('\n'));
  pushLog('generator', A.cur || '-', 'Gen 2 diisi Ai: ' + slots.map(sl => '2' + sl).join(', '),
    slots.map(sl => ({ k: '2' + sl, v: fxGen2State[sl].pools.map(p => p.join('')).join('.') })));
}

// ---------- Angka filter (Filter Pangkas Kombinasi di Generator) ----------
// Banyak nilai per filter mengikuti dropdown yang sudah ada di tab Analisis (Output Ai AC/CK/KE, rekomendasi
// Jumlah/Selisih, jumlah Shio) supaya hasil Ai sebanding dengan tombol Cari/Prediksi bawaan; Angka Ikut pakai A.nIkut.
function filterCounts(){
  const num = (id, def) => { const el = document.getElementById(id); const v = el ? parseInt(el.value, 10) : NaN; return (Number.isInteger(v) && v >= 1 && v <= 11) ? v : def; };
  const ai = part => { let v = null; try{ if(typeof getAiDigitCount === 'function') v = getAiDigitCount(part); }catch(e){} return v || 5; };
  return { AC: ai('AC'), CK: ai('CK'), KE: ai('KE'), jumlah: Math.min(9, num('jsRecoCountJumlah', 5)), selisih: Math.min(9, num('jsRecoCountSelisih', 5)), shio: num('shioPickCount', 5), ikut: A.nIkut || 4 };
}
function applyFilterNumbers(fn){
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  fn.items.forEach(it => {
    if(it.id === 'AC') set('filterAiAC', it.digits.join(''));
    else if(it.id === 'CK') set('filterAiCK', it.digits.join(''));
    else if(it.id === 'KE') set('filterCB', it.digits.join(''));
    else if(it.id === 'IKUT') set('filterAI', it.digits.join(''));
    else if(it.id === 'JUMLAH') set('filterJumlah', it.digits.join(','));
    else if(it.id === 'SELISIH') set('filterSelisih', it.digits.join(','));
    else if(it.id === 'SHIO'){
      const pick = new Set(it.digits), boxes = document.querySelectorAll('.shioPick');
      boxes.forEach(cb => { cb.checked = pick.has(parseInt(cb.dataset.shio, 10)); });
      const all = document.getElementById('filterShioAll');
      if(all) all.checked = (boxes.length > 0 && document.querySelectorAll('.shioPick:checked').length === boxes.length);
      try{ if(typeof updateShioPickNote === 'function') updateShioPickNote(); }catch(e){}
    }
  });
  try{ if(typeof lastTop8Pools !== 'undefined' && lastTop8Pools.length && typeof applyFilters === 'function') applyFilters(); }catch(e){ console.error('Mode Ai: gagal menerapkan filter', e); }
}
function fmtSet(it){ return it.id === 'SHIO' ? it.digits.join(', ') : ((it.id === 'JUMLAH' || it.id === 'SELISIH') ? it.digits.join(',') : it.digits.join('')); }
// Tanda pengenal hasil filter: berubah kalau pasaran / data terakhir / jumlah opsi / OUT / pin-buang berubah -> hasil belajar lama dianggap basi
function filterSig(name, pm, counts, outArg){
  const C = pm && pm.C ? pm.C : [];
  return [name, C.length, C.length ? C[C.length - 1].join('') : '', JSON.stringify(counts), JSON.stringify(outArg), JSON.stringify(A.pin), JSON.stringify(A.ban)].join('|');
}
function testLine(it, detail){
  const t = it.test;
  let s = it.label + ' [' + fmtSet(it) + '] · kena ' + t.pct.toFixed(0) + '% vs acak ' + t.chance.toFixed(0) + '%, z=' + t.z.toFixed(1);
  if(it.useless) s += ' (hampir semua kombinasi ikut lolos → nyaris tidak memangkas)';
  if(detail) s += '\n   pakar: ' + it.experts.map(e => e.id + ' ' + e.pct.toFixed(0) + '%').join(' · ') + ' · bobot acak ' + (it.wNull * 100).toFixed(0) + '%';
  return s;
}
function filterVerdict(fl){
  if(fl.sigBonf > 0) return '✅ ' + fl.sigBonf + ' filter tetap signifikan setelah koreksi banyak-uji → kemungkinan ada pola nyata. Ulangi setelah ada data baru untuk memastikan.';
  if(fl.sig >= 2) return '🟡 ' + fl.sig + ' dari ' + fl.trials + ' filter terlihat di atas acak (kebetulan murni diperkirakan ±' + fl.sigExpected.toFixed(1) + '), tapi belum cukup kuat untuk dipercaya.';
  return '⚪ Belum ada bukti pola di filter mana pun: hasil Ai setara acak. Ini jawaban jujur dari data saat ini, bukan kegagalan program.';
}
function filterReport(name, fl, filled){
  const outTxt = Array.isArray(fl.out) ? fl.out.join('/') : A.out;
  let txt = (filled ? 'ANGKA FILTER ' : 'UJI FILTER ') + name + ' (' + fl.K + ' baris terakhir, tiap baris hanya memakai data sebelumnya; OUT ' + outTxt + '):\n' +
    fl.items.map(it => testLine(it, !filled)).join('\n') +
    '\n“acak” = porsi kombinasi pool yang ikut lolos filter itu (peluang lolos kalau tebakan digit pool acak).\n' + filterVerdict(fl);
  if(filled){
    const hasGen = (typeof lastTop8Pools !== 'undefined' && lastTop8Pools.length);
    txt += '\nAngka filter (hasil suara pakar berbobot: Model, Cover 15, Cover 30, Frekuensi 30) sudah diisi ke kotak Filter Pangkas Kombinasi' + (hasGen ? ' dan diterapkan.' : ' (belum ada pool di Generator — ketik “kirim semua” supaya pool ikut dikirim).');
    if(fl.L !== 4) txt += '\nCatatan: filter Ai AC/CK/KE, Jumlah, Selisih, dan Shio hanya untuk data 4D — pasaran ini ' + fl.L + ' digit, jadi hanya Angka Ikut yang diisi.';
  } else {
    txt += '\n(Tidak mengisi filter Generator — ketik “filter” untuk mengisinya.) Pakar terbaik dipilih setelah hasil dilihat, jadi jangan dipercaya sendirian.';
  }
  return txt;
}
// Belajar + uji jalan-maju filter untuk pasaran aktif. Bahan uji (st.recP = peluang prediksi yang disimpan SEBELUM hasil
// diketahui, REC_K baris terakhir) ikut tersimpan di otak; kalau belum ada (otak lama), pasaran itu dipelajari ulang sekali dari awal.
async function computeFilterLearn(){
  const ms = markets(), name = pickDefaultCur(ms);
  if(!name){ say('Belum ada data pasaran untuk dipelajari.'); return null; }
  A.cur = name;
  const pm = ms[name];
  A.busy = true; setBusy(true);
  try{
    let r = predictCur();   // pastikan otak sudah belajar sampai data terakhir
    if(!r){ say('Belum ada data pasaran untuk diprediksi.'); return null; }
    let st = r.st;
    const need = Math.min(B.REC_K, st.t - B.T0);
    if(!(st.recP && st.recP[0] && st.recP[0].length >= need)){
      say('Bahan uji filter untuk ' + name + ' belum ada di ingatan Ai — belajar ulang pasaran ini dari awal (cukup sekali)…');
      setStatus('Belajar ulang ' + name + ' untuk uji filter…'); await tick();
      const { extRefs, refSeries } = buildRefSeriesFor(name, collectTexts());
      st = B.learnMarket(name, pm.C, pm.L, { tilt: A.tilt, dates: pm.dates, extRefs, refSeries });   // tanpa state -> mulai bersih
      A.states[name] = st; save(); persistBrainSoon(name);
      r = predictCur(); st = r.st;
    }
    const counts = filterCounts();
    const outArg = st.L === 0 ? A.out : Array.from({ length: st.L }, (_, p) => A.outPos[p] || A.out);
    setStatus('Menguji filter ' + name + '…'); await tick();
    const fl = B.filterLearn(st, pm.C, counts, outArg, { pr: r.pr });
    if(!fl){ say('Data ' + name + ' belum cukup untuk menguji filter (butuh minimal ' + (B.T0 + 10) + ' baris yang sudah dipelajari).'); return null; }
    fl.src = 'belajar'; fl.out = outArg; fl.name = name; fl.sig = filterSig(name, pm, counts, outArg);
    A.lastFilter = fl;
    return { name, fl };
  }catch(e){
    console.error('Mode Ai: gagal belajar/uji filter', e);
    say('⚠️ Belajar/uji filter terhenti karena error: ' + (e && e.message ? e.message : e));
    return null;
  }finally{
    A.busy = false; setBusy(false);
  }
}
async function runFilter(){
  const res = await computeFilterLearn();
  if(!res){ renderAll(); return; }
  applyFilterNumbers(res.fl);
  renderAll();
  say(filterReport(res.name, res.fl, true));
}
async function runFilterTest(){
  const res = await computeFilterLearn();
  renderAll();
  if(res) say(filterReport(res.name, res.fl, false));
}

// ---------- Impor JSON export ----------
function importJson(file){
  const fr = new FileReader();
  fr.onload = () => {
    try{
      const o = JSON.parse(fr.result); let n = 0;
      const put = (name, data) => { if(typeof data === 'string' && name){ A.imported[name] = data; n++; } };
      if(Array.isArray(o)) o.forEach(x => x && put(x.name, x.data));
      else Object.keys(o).forEach(k => put((o[k] && o[k].name) || k, o[k] && o[k].data));
      saveData(); A.cache = {};
      say('Impor selesai: ' + n + ' pasaran. Ketik “belajar semua” supaya Ai mempelajarinya.');
      A.cur = pickDefaultCur(markets()); renderAll();
    }catch(e){ say('Gagal membaca JSON: ' + e.message); }
  };
  fr.readAsText(file);
}

// ---------- Tampilan ----------
let card = null;
function esc(s){ return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
let chatSyncTimer = null;
function say(text, who){
  A.chat.push({ who: who || 'ai', text: String(text) });
  if(A.chat.length > 60) A.chat.shift();
  renderChat();
  if(typeof AiMemory !== 'undefined'){
    clearTimeout(chatSyncTimer);
    chatSyncTimer = setTimeout(() => AiMemory.saveChat(A.chat), 1200); // ditunda dikit, kalau say() dipanggil beruntun cukup 1x kirim
  }
}
function setStatus(t){ const el = card && card.querySelector('#aimStatus'); if(el) el.textContent = t; }
function setBusy(b){ if(card) card.querySelectorAll('button').forEach(x => { x.disabled = b; }); }
function renderChat(){
  const el = card && card.querySelector('#aimChat'); if(!el) return;
  el.innerHTML = A.chat.map(m => '<div style="margin:0 0 8px; text-align:' + (m.who === 'user' ? 'right' : 'left') + ';"><span style="display:inline-block; max-width:92%; white-space:pre-wrap; text-align:left; padding:7px 10px; border-radius:10px; font-size:12.5px; line-height:1.4; background:' + (m.who === 'user' ? 'var(--panel-2)' : 'rgba(45,212,191,.08)') + '; border:1px solid var(--line);">' + esc(m.text) + '</span></div>').join('');
  el.scrollTop = el.scrollHeight;
}

// ---------- Log Hasil (uji / uji semua / eksperimen / prediksi) ----------
// Ditampilkan sebagai tabel di bawah #aimChat. Kolom utama sama untuk semua jenis (Waktu/Jenis/
// Pasaran/Ringkasan) supaya tabelnya tetap rapi; field yang berbeda tiap sumber (per-posisi, per-pakar,
// dll) disimpan di entry.detail dan baru dirender saat baris di-expand ("▾ detail").
const MAX_LOG = 20;
const LOG_TYPE_LABEL = { prediksi: '🎯 Prediksi', uji: '🧪 Uji', uji_semua: '🧪 Uji Semua', eksperimen: '🔬 Eksperimen', generator: '🧩 Generator' };
function pushLog(type, market, summary, detail){
  A.resultLog.unshift({ ts: Date.now(), type, market: market || '-', summary, detail: detail || [] });
  if(A.resultLog.length > MAX_LOG) A.resultLog.length = MAX_LOG;
  renderResultLog();
}
function renderResultLog(){
  const el = card && card.querySelector('#aimResultLog'); if(!el) return;
  if(!A.resultLog.length){ el.innerHTML = '<p class="hint" style="margin:0; padding:8px;">Belum ada hasil uji/eksperimen/prediksi.</p>'; return; }
  const rows = A.resultLog.map((e, i) => {
    const time = new Date(e.ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const detailRows = e.detail.map(d => '<div style="display:flex; gap:6px; padding:2px 0;"><b style="min-width:70px; color:var(--amber); font-size:11px;">' + esc(d.k) + '</b><span style="font-size:11px; font-family:var(--mono);">' + esc(d.v) + '</span></div>').join('');
    return '<tr style="border-bottom:1px solid var(--line);">' +
      '<td style="padding:6px 8px; font-size:11px; white-space:nowrap; vertical-align:top;">' + time + '</td>' +
      '<td style="padding:6px 8px; font-size:11px; white-space:nowrap; vertical-align:top;">' + esc(LOG_TYPE_LABEL[e.type] || e.type) + '</td>' +
      '<td style="padding:6px 8px; font-size:11px; white-space:nowrap; vertical-align:top;">' + esc(e.market) + '</td>' +
      '<td style="padding:6px 8px; font-size:11px; vertical-align:top;">' + esc(e.summary) +
        (detailRows ? '<div class="aimLogToggle" data-i="' + i + '" style="margin-top:3px; font-size:10.5px; color:var(--teal); cursor:pointer; user-select:none;">▾ detail</div><div class="aimLogDetail" data-i="' + i + '" style="display:none; margin-top:4px; padding-top:4px; border-top:1px dashed var(--line);">' + detailRows + '</div>' : '') +
      '</td></tr>';
  }).join('');
  el.innerHTML = '<table style="width:100%; border-collapse:collapse; min-width:480px;"><thead><tr style="border-bottom:1px solid var(--line);">' +
    '<th style="padding:6px 8px; text-align:left; font-size:10.5px; text-transform:uppercase; color:var(--ink-dim); white-space:nowrap;">Waktu</th>' +
    '<th style="padding:6px 8px; text-align:left; font-size:10.5px; text-transform:uppercase; color:var(--ink-dim); white-space:nowrap;">Jenis</th>' +
    '<th style="padding:6px 8px; text-align:left; font-size:10.5px; text-transform:uppercase; color:var(--ink-dim); white-space:nowrap;">Pasaran</th>' +
    '<th style="padding:6px 8px; text-align:left; font-size:10.5px; text-transform:uppercase; color:var(--ink-dim);">Ringkasan</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
  el.querySelectorAll('.aimLogToggle').forEach(t => t.addEventListener('click', () => {
    const d = el.querySelector('.aimLogDetail[data-i="' + t.dataset.i + '"]');
    if(d) d.style.display = d.style.display === 'none' ? '' : 'none';
  }));
}
function renderAll(){
  if(!card) return;
  const ms = markets(), names = Object.keys(ms).sort();
  const sel = card.querySelector('#aimMarket');
  A.cur = pickDefaultCur(ms);
  sel.innerHTML = names.length ? names.map(n => '<option value="' + esc(n) + '"' + (n === A.cur ? ' selected' : '') + '>' + esc(n) + (A.states[n] ? ' ✓' : '') + '</option>').join('') : '<option value="">— belum ada data —</option>';
  card.querySelector('#aimOut').value = String(A.out);
  const learned = Object.keys(A.states).length;
  setStatus(names.length + ' pasaran tersedia · ' + learned + ' sudah dipelajari' + (A.cur ? ' · aktif ' + A.cur + ' (' + ms[A.cur].C.length + ' data, sumber: ' + (A.src[A.cur] || '?') + ')' : '') + (A.activeMiss && A.activeMiss.toUpperCase() !== String(A.cur).toUpperCase() ? '\n⚠️ Pasaran aktif di Periode "' + A.activeMiss + '" tidak ditemukan di data Ai (atau datanya < 12 baris) — ketik "sumber" untuk cek.' : '') + (A.globalNote ? '\n' + A.globalNote : ''));
  const box = card.querySelector('#aimResult');
  if(!A.lastPred || !A.cur){ box.innerHTML = '<p class="hint" style="margin:0;">Belum ada prediksi. Tekan “🎯 Prediksi”.</p>'; }
  else {
    box.innerHTML = A.lastPred.map(x => {
      const chips = x.digits.map(d => '<span style="display:inline-block; min-width:22px; text-align:center; padding:3px 0; margin:2px; border-radius:6px; background:var(--panel-2); border:1px solid var(--line); font-family:var(--mono); font-weight:700;">' + d + '</span>').join('');
      const edge = (x.edge * 100);
      const tag = x.wNull > 0.5 ? 'hampir acak' : ('yakin ' + (edge >= 0 ? '+' : '') + edge.toFixed(1) + '%');
      return '<div style="display:flex; align-items:center; gap:8px; margin:4px 0;"><b style="width:18px; color:var(--amber);">' + x.label + '</b><div style="flex:1; min-width:0;">' + chips + '</div><span class="hint" style="margin:0; font-size:11px; white-space:nowrap;">' + tag + '</span></div>';
    }).join('');
  }
  const fbox = card.querySelector('#aimFilter');
  if(fbox){
    const f = A.lastFilter;
    if(!f || !f.items || !f.items.length || !A.cur){ fbox.innerHTML = ''; }
    else {
      const head = f.src === 'belajar' ? 'Angka filter · sudah diuji ' + f.K + ' baris (kena vs acak)' : 'Angka filter · model saja, belum diuji (tekan 🎛️ untuk belajar + uji)';
      fbox.innerHTML = '<div class="hint" style="margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.06em;">' + esc(head) + '</div>' + f.items.map(it =>
        '<div style="display:flex; align-items:center; gap:8px; margin:3px 0;"><b style="min-width:74px; color:var(--amber); font-size:12px;">' + esc(it.label) + '</b><span style="flex:1; min-width:0; font-family:var(--mono); font-weight:700;">' + esc(fmtSet(it)) + '</span><span class="hint" style="margin:0; font-size:11px; white-space:nowrap;">' + (it.p * 100).toFixed(0) + '% vs ' + (it.chance * 100).toFixed(0) + '%</span></div>'
      ).join('');
    }
  }
  renderChat();
  renderResultLog();
}

function buildCard(){
  card = document.createElement('div');
  card.className = 'card modeInfoCard'; card.id = 'modeInfoAi'; card.style.display = 'none';
  card.innerHTML =
    '<div class="modeInfoHead"><div class="modeInfoIcon">🧠</div><div class="modeInfoBody">' +
    '<h2 style="margin:0;">Mode Ai <span class="pill" style="background:rgba(45,212,191,.15); color:var(--teal);">BELAJAR</span></h2>' +
    '<p class="hint" style="margin:2px 0 0;">Ai mempelajari semua formula & pasaran, memilih sendiri kombinasinya, dan patuh pada perintah OUT Anda.</p></div></div>' +
    '<div class="statusBox" id="aimStatus" style="margin:10px 0; white-space:pre-wrap; font-size:12px;"></div>' +
    '<div class="row" style="gap:6px; margin-bottom:8px;">' +
      '<select id="aimMarket" class="fxSelect" style="flex:1; min-width:0;"></select>' +
      '<select id="aimOut" class="fxSelect" style="width:78px;">' + [4,5,6,7,8,9].map(n => '<option value="' + n + '">OUT ' + n + '</option>').join('') + '</select>' +
    '</div>' +
    '<div id="aimResult" style="margin:6px 0 10px;"></div>' +
    '<div id="aimFilter" style="margin:0 0 10px;"></div>' +
    '<div class="row" style="gap:6px; flex-wrap:wrap; margin-bottom:10px;">' +
      '<button class="btn" data-cmd="prediksi">🎯 Prediksi</button>' +
      '<button class="btn" data-cmd="belajar semua">🧠 Belajar Semua</button>' +
      '<button class="btn" data-cmd="uji">🧪 Uji</button>' +
      '<button class="btn" data-cmd="uji semua">🧪 Uji Semua</button>' +
      '<button class="btn" data-cmd="eksperimen">🔬 Eksperimen</button>' +
      '<button class="btn" data-cmd="kenapa">💬 Kenapa?</button>' +
      '<button class="btn" data-cmd="isi generator">🧩 Isi Generator</button>' +
      '<button class="btn" data-cmd="uji filter">🧪 Uji Filter</button>' +
      '<button class="btn" id="aimImportBtn">📥 Impor JSON</button>' +
      '<input type="file" id="aimImportFile" accept=".json,application/json" style="display:none;">' +
    '</div>' +
    '<div id="aimChat" style="max-height:260px; overflow:auto; padding:8px; border:1px solid var(--line); border-radius:10px; background:var(--panel-2);"></div>' +
    '<div style="margin-top:10px;">' +
      '<div class="hint" style="margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.06em;">📊 Log Hasil</div>' +
      '<div id="aimResultLog" style="max-height:220px; overflow:auto; border:1px solid var(--line); border-radius:10px; background:var(--panel-2);"></div>' +
    '</div>' +
    '<div class="row" style="gap:6px; margin-top:8px;">' +
      '<input type="text" id="aimCmd" placeholder="Ketik perintah… (bantuan)" autocomplete="off" style="flex:1; min-width:0; background:var(--panel-2); border:1px solid var(--line); color:var(--ink); font-size:14px; padding:9px 12px; border-radius:9px;">' +
      '<button class="btn" id="aimSend">Kirim</button>' +
    '</div>';
  const anchor = document.getElementById('modeInfoAuto') || document.getElementById('modeCard');
  anchor.insertAdjacentElement('afterend', card);

  card.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('click', () => { if(A.busy) say('Sedang belajar… tunggu sebentar sampai selesai.'); else run(b.dataset.cmd); }));
  const send = () => { const i = card.querySelector('#aimCmd'); const v = i.value; i.value = ''; if(!v.trim()) return; if(A.busy) say('Sedang belajar… tunggu sebentar sampai selesai.'); else run(v); };
  card.querySelector('#aimSend').addEventListener('click', send);
  card.querySelector('#aimCmd').addEventListener('keydown', e => { if(e.key === 'Enter') send(); });
  card.querySelector('#aimMarket').addEventListener('change', e => { A.cur = e.target.value; A.pin = {}; A.ban = {}; refreshPredict(true); });
  card.querySelector('#aimOut').addEventListener('change', e => { A.out = +e.target.value; A.outPos = {}; save(); refreshPredict(true); });
  card.querySelector('#aimImportBtn').addEventListener('click', () => card.querySelector('#aimImportFile').click());
  card.querySelector('#aimImportFile').addEventListener('change', e => { if(e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
}

function addPill(id, homeId){
  [['modeCard', id], ['modeAnalisaHomeCard', homeId]].forEach(([cid, bid]) => {
    const tray = document.querySelector('#' + cid + ' .segTray'); if(!tray || document.getElementById(bid)) return;
    const b = document.createElement('button');
    b.className = 'btn modeBtn'; b.id = bid; b.dataset.mode = 'ai';
    b.innerHTML = '<span class="modeBtnIcon">🧠</span><span>Ai</span>';
    tray.appendChild(b);
  });
}

function applyView(mode){
  if(!card) return;
  const on = (mode === 'ai');
  card.style.display = on ? '' : 'none';
  const pa = document.getElementById('pengaturanAnalisaSection');
  if(on && pa) pa.style.display = 'none';
  if(on){ A.sig = ''; try{ syncData(true); }catch(e){ console.error('Mode Ai: gagal sinkron data', e); } }
}

// Data baru masuk (periode baru / ganti pasaran): Ai otomatis belajar lanjutan — inilah "meningkat sendiri".
function sigNow(){
  const di = document.getElementById('dataInput'); const v = di ? di.value : '';
  return activeLabels().join('/') + '|' + v.length + '|' + v.slice(0, 60) + '|' + v.slice(-60) + '|' + Object.keys(readFirebaseMap()).length;
}
function syncData(force){
  if(!card || card.style.display === 'none' || A.busy) return;
  const s = sigNow(); if(!force && s === A.sig) return;
  const first = !A.sig; A.sig = s;
  let r = null;
  try{ r = predictCur(); }catch(e){ console.error('Mode Ai: gagal memperbarui prediksi', e); }
  renderAll();
  if(r && A.states[r.name]){
    save();
    if(!first && r.newRows > 0){
      say('Data baru di ' + r.name + ' (+' + r.newRows + '). Ai sudah belajar lanjutan dan memperbarui angka.');
      persistBrainSoon(r.name); // otomatis, bukan diminta manual — cukup dicatat, tidak perlu buru-buru
    }
  }
}

function init(){
  buildCard();
  addPill('modeAiBtn', 'modeAiBtnHome');
  const b = document.getElementById('modeAiBtn'); if(b) b.addEventListener('click', () => showModeView('ai'));
  const bh = document.getElementById('modeAiBtnHome');
  if(bh) bh.addEventListener('click', () => { showModeView('ai'); if(typeof window.goPage === 'function') window.goPage('analisis'); });
  if(typeof window.showModeView === 'function' && !window.showModeView.__aiWrapped){
    const orig = window.showModeView;
    const wrapped = function(mode){ const r = orig.apply(this, arguments); applyView(mode); return r; };
    wrapped.__aiWrapped = true;
    window.showModeView = wrapped;
  }
  setStatus('Memuat ingatan…');
  renderAll();
  load().then(() => {
    say(A.chat.length
      ? 'Selamat datang kembali — ingatan sebelumnya sudah dimuat. Ketik “bantuan” untuk daftar perintah.'
      : 'Halo! Saya Ai. Beri tahu OUT yang Anda mau (mis. “out 6”), lalu “belajar semua” supaya saya mempelajari semua pasaran. Ketik “bantuan” untuk daftar perintah. Saya akan jujur menunjukkan hasil ujinya — termasuk kalau datanya ternyata belum punya pola.');
    setInterval(() => syncData(false), 2000);
    renderAll();
  });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
