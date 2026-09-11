// ===================== GENERATOR =====================
// Generate kombinasi, Filter Pangkas Kombinasi (termasuk Twin Murni), dan Bagikan Link.

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

