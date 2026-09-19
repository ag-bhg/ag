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
  lastPred: null, busy: false, chat: [], sig: '', globalNote: '',
  patterns: {},          // kalimat yang sudah "diajarkan" user -> perintah asli yang dimaksud
  pendingTeach: null      // { phrase, cmd } — menunggu konfirmasi ya/tidak dari user
};

// ---------- Penyimpanan lokal (instan, cadangan offline) ----------
function loadLocal(){
  try{
    const o = JSON.parse(localStorage.getItem(LS_STATES) || 'null');
    if(o){
      A.out = o.out || 8; A.tilt = o.tilt || null; A.globalNote = o.globalNote || '';
      Object.keys(o.states || {}).forEach(k => { const st = B.deserialize(o.states[k]); if(st) A.states[k] = st; });
    }
    A.imported = JSON.parse(localStorage.getItem(LS_DATA) || '{}') || {};
  }catch(e){}
}
function saveLocal(){
  try{
    const states = {};
    Object.keys(A.states).forEach(k => { states[k] = B.serialize(A.states[k]); });
    localStorage.setItem(LS_STATES, JSON.stringify({ out: A.out, tilt: A.tilt, globalNote: A.globalNote, states }));
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
    AiMemory.savePrefs({ out: A.out, tilt: A.tilt, globalNote: A.globalNote, pin: A.pin, ban: A.ban, famOff: A.famOff, outPos: A.outPos });
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
function readFirebaseMap(){
  const out = {};
  try{
    if(typeof firebaseMarketMap === 'undefined' || !firebaseMarketMap) return out;
    const ents = (firebaseMarketMap instanceof Map) ? Array.from(firebaseMarketMap.entries()) : Object.entries(firebaseMarketMap);
    ents.forEach(([k, v]) => {
      const txt = typeof v === 'string' ? v : (v && typeof v.data === 'string' ? v.data : null);
      if(txt) out[(v && v.name) || k] = txt;
    });
  }catch(e){}
  return out;
}
function activeCode(){
  try{ if(typeof firebaseSelectedKode === 'function') return firebaseSelectedKode() || ''; }catch(e){}
  return '';
}
function collectTexts(){
  const texts = Object.assign({}, A.imported, readFirebaseMap());
  const di = document.getElementById('dataInput');
  if(di && di.value && di.value.trim()){
    const code = activeCode() || 'AKTIF';
    if(!texts[code]) texts[code] = di.value; // data yang sedang tampil, hanya kalau belum ada sumber lain
  }
  return texts;
}
function markets(){
  const texts = collectTexts(), res = {};
  Object.keys(texts).forEach(name => {
    const c = A.cache[name];
    if(!c || c.text !== texts[name]) A.cache[name] = { text: texts[name], parsed: B.parseMarketText(texts[name]) };
    const pm = A.cache[name].parsed;
    if(pm.L >= 2 && pm.C.length >= 12) res[name] = pm;
  });
  return res;
}
function pickDefaultCur(ms){
  const code = activeCode();
  if(A.cur && ms[A.cur]) return A.cur;
  if(code && ms[code]) return code;
  if(ms.AKTIF) return 'AKTIF';
  return Object.keys(ms).sort()[0] || null;
}

// ---------- Belajar ----------
function learnOne(name, ms){
  const pm = ms[name]; if(!pm) return null;
  const before = A.states[name] ? A.states[name].t : 0;
  const st = B.learnMarket(name, pm.C, pm.L, { state: A.states[name], tilt: A.tilt });
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
    for(let i = 0; i < names.length; i++){
      const pm = ms[names[i]];
      if(pm.C.length < 20) continue;
      const st = B.learnMarket(names[i], pm.C, pm.L, { tilt, state: tilt === A.tilt ? A.states[names[i]] : null });
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
  const pr = B.predict(r.st, ms[name].C, { out: outArg, pin: A.pin, ban: A.ban, famOff: hasOff() ? A.famOff : null });
  A.lastPred = pr; A.lastNew = r.newRows;
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
  { cmd: 'rapor', label: 'rapor — ringkasan hasil belajar', kw: ['rapor', 'ringkasan', 'laporan', 'progres'] }
];
function suggestCommand(t){
  let best = null, bestScore = 0;
  CANON_CMDS.forEach(c => {
    let score = 0;
    c.kw.forEach(k => { if(t.indexOf(k) >= 0) score += k.length; });
    if(score > bestScore){ bestScore = score; best = c; }
  });
  return bestScore >= 4 ? best : null; // ambang minimal supaya tidak asal tebak
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

// Jalur cadangan "ngobrol bebas" — dipanggil HANYA kalau kalimat tidak cocok perintah
// terstruktur manapun (dan tidak ada tebakan perintah yang layak). Lewat endpoint Worker
// /api/ai-chat (Cloudflare Workers AI, gratis, tanpa API key di sisi browser).
async function askAiChat(userText){
  if(typeof fetch !== 'function') return say('Ai (obrolan bebas) tidak tersedia di browser ini.');
  setBusy(true); setStatus('Ai sedang berpikir…');
  try{
    const sys = {
      role: 'system',
      content: 'Anda adalah Ai di sistem Analisa Frekuensi — asisten analisis statistik pribadi milik user. Anda HANYA membahas data di sistem ini: histori pasaran, hasil belajar Ai (aiBrain), dan hasil Formula X. Kalau ditanya topik di luar itu, tolak dengan sopan dan arahkan kembali ke topik analisa. JANGAN mengarang angka atau data yang tidak ada di konteks di bawah — kalau konteksnya kurang, katakan terus terang. Anda BUKAN peramal — untuk angka pasti, arahkan ke perintah "prediksi"/"uji". Jawab singkat, santai, Bahasa Indonesia.\n\nKONTEKS SAAT INI:\n' + contextBlock()
    };
    // Riwayat sebelum pesan ini (pesan terakhir A.chat sudah berisi userText sendiri — tidak diulang)
    const hist = A.chat.slice(-9, -1).map(m => ({ role: m.who === 'user' ? 'user' : 'assistant', content: m.text }));
    const messages = [sys].concat(hist, [{ role: 'user', content: userText }]);
    const resp = await fetch('/api/ai-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    const j = await resp.json();
    say(j && j.ok ? (j.reply || '(jawaban kosong)') : '⚠️ Ai (obrolan bebas) gagal menjawab: ' + (j && j.error ? j.error : 'tidak diketahui'));
  }catch(e){
    say('⚠️ Gagal menghubungi otak Ai: ' + (e && e.message ? e.message : e));
  }finally{
    setBusy(false); renderAll();
  }
}

async function run(text){
  const raw = String(text || '').trim(); if(!raw) return;
  say(raw, 'user');
  return handle(raw);
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
  if(/^(prediksi|angka|hasil|tebak)/.test(t)){ const r = refreshPredict(); if(r) say(predText(r)); return; }
  if(/^belajar\s*semua/.test(t)) return learnAll();
  if(/^belajar/.test(t)){
    if(!cur) return say('Belum ada data pasaran.');
    const r = learnOne(cur, ms); save(); refreshPredict(true); persistBrain(cur, r.st);
    return say(cur + ': Ai sudah belajar sampai data ke-' + ms[cur].C.length + (r.newRows ? ' (+' + r.newRows + ' data baru)' : ' (tidak ada data baru)') + '.');
  }
  if(/^uji\s*semua/.test(t)){
    const sts = Object.keys(A.states).map(k => A.states[k]);
    if(!sts.length) return say('Belum ada yang dipelajari. Ketik “belajar semua” dulu.');
    const ev = B.evalAll(sts, A.out);
    return say('UJI JUJUR semua pasaran (OUT ' + A.out + ', tiap prediksi hanya memakai data sebelumnya):\nAi kena ' + ev.pct.toFixed(2) + '% dari ' + ev.n + ' tebakan-digit; acak murni ' + ev.chance.toFixed(0) + '%; z=' + ev.z.toFixed(2) + '.\nPosisi-pasaran lolos z>1,64: ' + ev.sig + '/' + ev.trials + ' (kebetulan diperkirakan ±' + ev.sigExpected.toFixed(0) + '); lolos setelah koreksi banyak-uji: ' + ev.sigBonf + '.\n' + verdictText(ev.z, ev.sig, ev.sigExpected, ev.sigBonf));
  }
  if(/^uji/.test(t)){
    const st = cur && A.states[cur]; if(!st) return say('Pasaran ini belum dipelajari. Ketik “belajar”.');
    const rs = B.evalState(st, A.out);
    const lines = rs.map(r => r.label + ': kena ' + r.pct.toFixed(1) + '% (acak ' + r.chance.toFixed(0) + '%) dari ' + r.n + ' uji, z=' + r.z.toFixed(2) + ' · paruh awal ' + r.pctA.toFixed(0) + '% → paruh akhir ' + r.pctB.toFixed(0) + '%');
    const anySig = rs.filter(r => r.z > 1.645).length;
    return say('UJI JUJUR ' + cur + ' (OUT ' + A.out + ', mulai baris ke-' + B.EVAL_FROM + '):\n' + lines.join('\n') + '\n' + (anySig ? '🟡 ' + anySig + ' dari ' + rs.length + ' posisi terlihat di atas acak; dengan banyak posisi dan pasaran, sebagian pasti kebetulan. Bandingkan dengan “uji semua”.' : '⚪ Belum ada bukti pola di pasaran ini.'));
  }
  if(/^(eksperimen|lab)/.test(t)){
    const st = cur && A.states[cur]; if(!st) return say('Pasaran ini belum dipelajari. Ketik “belajar”.');
    const r = B.forceLab(st, ms[cur].C); save(); refreshPredict(true); persistBrain(cur, st);
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
  if(/^kirim/.test(t)) return sendToGenerator();
  if(/^rapor/.test(t)) return say(raporText());
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
  return 'Perintah:\n• out 6 / out A 7 / out reset\n• pasaran BJI\n• prediksi\n• belajar / belajar semua\n• uji / uji semua\n• tampilkan test [pasaran] (dari ingatan, tanpa hitung ulang)\n• eksperimen (lab gabung pakar)\n• kenapa / kenapa A\n• pin A 3 5 · buang C 7 · lepas\n• tanpa bhg · dengan bhg · hanya sendiri · pakar\n• kirim (ke Generator) · rapor\n\nKalau kalimat Anda tidak mirip perintah manapun, saya coba tebak & tanya konfirmasi dulu (sekali dikonfirmasi, saya ingat terus). Kalau memang bukan perintah, saya jawab santai lewat obrolan bebas.';
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

function sendToGenerator(){
  const pr = A.lastPred; if(!pr) return say('Belum ada prediksi. Ketik “prediksi”.');
  if(typeof fxGen1Locked !== 'undefined' && fxGen1Locked) return say('Gen 1 sedang terkunci (Mode Auto/Semi Auto atau LOCK GEN 1). Buka kuncinya dulu supaya angka Ai tidak bentrok.');
  const pools = pr.map(x => x.digits.map(String));
  try{ lastTop8Pools = pools; }catch(e){}
  const bo = document.getElementById('bulkOut'); if(!bo) return say('Kolom Generator (#bulkOut) tidak ditemukan.');
  bo.value = pools.map(p => p.join('')).join('.');
  try{
    if(typeof generateCombineOutput === 'function') generateCombineOutput();
    const fc = document.getElementById('filterCard');
    if(fc && fc.style.display === 'block' && typeof resetFilters === 'function') resetFilters();
  }catch(e){ return say('Angka masuk kolom Generator, tapi pembuatan kombinasi gagal: ' + e.message); }
  say('Angka Ai dikirim ke Generator: ' + bo.value);
  if(typeof window.goPage === 'function') window.goPage('generator');
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
function renderAll(){
  if(!card) return;
  const ms = markets(), names = Object.keys(ms).sort();
  const sel = card.querySelector('#aimMarket');
  A.cur = pickDefaultCur(ms);
  sel.innerHTML = names.length ? names.map(n => '<option value="' + esc(n) + '"' + (n === A.cur ? ' selected' : '') + '>' + esc(n) + (A.states[n] ? ' ✓' : '') + '</option>').join('') : '<option value="">— belum ada data —</option>';
  card.querySelector('#aimOut').value = String(A.out);
  const learned = Object.keys(A.states).length;
  setStatus(names.length + ' pasaran tersedia · ' + learned + ' sudah dipelajari' + (A.cur ? ' · aktif ' + A.cur + ' (' + ms[A.cur].C.length + ' data)' : '') + (A.globalNote ? '\n' + A.globalNote : ''));
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
  renderChat();
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
    '<div class="row" style="gap:6px; flex-wrap:wrap; margin-bottom:10px;">' +
      '<button class="btn" data-cmd="prediksi">🎯 Prediksi</button>' +
      '<button class="btn" data-cmd="belajar semua">🧠 Belajar Semua</button>' +
      '<button class="btn" data-cmd="uji">🧪 Uji</button>' +
      '<button class="btn" data-cmd="uji semua">🧪 Uji Semua</button>' +
      '<button class="btn" data-cmd="eksperimen">🔬 Eksperimen</button>' +
      '<button class="btn" data-cmd="kenapa">💬 Kenapa?</button>' +
      '<button class="btn" data-cmd="kirim">📤 Ke Generator</button>' +
      '<button class="btn" id="aimImportBtn">📥 Impor JSON</button>' +
      '<input type="file" id="aimImportFile" accept=".json,application/json" style="display:none;">' +
    '</div>' +
    '<div id="aimChat" style="max-height:260px; overflow:auto; padding:8px; border:1px solid var(--line); border-radius:10px; background:var(--panel-2);"></div>' +
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
  if(on){ A.sig = ''; syncData(true); }
}

// Data baru masuk (periode baru / ganti pasaran): Ai otomatis belajar lanjutan — inilah "meningkat sendiri".
function sigNow(){
  const di = document.getElementById('dataInput'); const v = di ? di.value : '';
  return activeCode() + '|' + v.length + '|' + v.slice(0, 60) + '|' + v.slice(-60) + '|' + Object.keys(readFirebaseMap()).length;
}
function syncData(force){
  if(!card || card.style.display === 'none' || A.busy) return;
  const s = sigNow(); if(!force && s === A.sig) return;
  const first = !A.sig; A.sig = s;
  const before = A.cur && A.states[A.cur] ? A.states[A.cur].t : 0;
  const r = predictCur(); renderAll();
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
