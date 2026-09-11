// ===================== MAIN =====================
// Pengaturan (kumpul/pulihkan semua opsi), Preset Pengaturan, UI umum (tab, fade-in,
// badge sync), dan tombol Kembali ke Atas.

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
  // Sumber Data Formula X: Mode Normal selalu balik ke Data Default (radio ini hanya mengikuti
  // Preset Aktif di Mode Auto/Semi Auto — lihat presetApplyFields di bawah).
  const fxDataSourceDefault = document.getElementById('fxDataSourceDefault');
  if(fxDataSourceDefault) fxDataSourceDefault.checked = true;
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
  window.gotoTab = activate;

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


// ===================== PRESET PENGATURAN =====================
// Daftar semua kontrol "pengaturan" di seluruh sistem (bukan data mentah/hasil).
// Tambahkan entri baru di sini kalau nanti ada filter/opsi baru yang perlu ikut preset.
const PRESET_FIELDS = [
  // Formula X
  { id:'fxTrendN',   type:'select' },
  { id:'fxControlN', type:'select' },
  { id:'fxOutN',     type:'select' },
  { id:'fxAutoFilterWorst', type:'checkbox' },
  { id:'fxDataSource', type:'radio', name:'fxDataSource' },
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
function presetLoad(name, {refreshCoverData = true} = {}){
  const all = presetLoadAll();
  if(!all[name]) return false;
  presetApplyFields(all[name].fields);
  presetApplyGen2(all[name].gen2 || null);

  // Segarkan Cover Data (Jumlah&Selisih/Ai Ai/Shio 234) & Filter pakai Data Historis yang
  // SEDANG aktif sekarang — supaya field-field itu tidak kebawa angka basi dari saat preset
  // ini terakhir disimpan. Dilewati kalau refreshCoverData=false (dipakai Mode Auto/Semi Auto,
  // yang sudah punya pipeline sendiri buat ini setelah Formula X dihitung ulang — lihat
  // runAutoPipelineAfterFormulaX di automode.js — supaya tidak dobel klik Cari+Filter).
  if(refreshCoverData && lastPosLabels && lastPosLabels.length && lastHistoryNumbers && lastHistoryNumbers.length){
    document.getElementById('cariJumlahBtn').click();
    document.getElementById('cariSelisihBtn').click();
    document.getElementById('cariAiACBtn').click();
    document.getElementById('cariAiCKBtn').click();
    document.getElementById('cariAiKEBtn').click();
    document.getElementById('cariShioBtn').click();
    document.getElementById('applyFilterBtn').click();
  }
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
      document.getElementById('presetFeedback').textContent = `Preset "${name}" dimuat — semua filter sudah terisi.`;
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


// ===================== BOTTOM NAV + HALAMAN PENUH (Beranda/Analisis/Generator/Rekap) =====================
(function(){
  const body = document.body;
  if('scrollRestoration' in history){
    // Matikan restorasi scroll otomatis bawaan browser — supaya saat
    // history.back() dipanggil (tombol Kembali / back HP), browser tidak
    // ikut memaksa scroll ke posisi lama (biasanya ke atas).
    history.scrollRestoration = 'manual';
  }
  const navBtns = Array.from(document.querySelectorAll('.bottomnav .navBtn'));
  const chevRows = Array.from(document.querySelectorAll('#analisisMenu .chevRow'));
  const backBtn = document.getElementById('subpageBackBtn');
  const subTitleEl = document.getElementById('subpageTitle');
  const oldTabButtons = Array.from(document.querySelectorAll('#navTabs .tabbtn'));
  let subpageHistoryPushed = false;

  function closeSubpage(){
    delete body.dataset.subpageOpen;
    subpageHistoryPushed = false;
    const floatBtn = document.getElementById('subpageFloatBackBtn');
    if(floatBtn) floatBtn.classList.remove('show');
    // Sengaja tidak scroll ke atas — biarkan posisi scroll seperti semula
    // supaya user tidak "terlempar" ke atas halaman saat menekan Kembali.
  }

  const titleByTab = {
    formulax: 'Formula X',
    jumlahselisih: 'Jumlah & Selisih',
    angkaikut: 'Ai Ai',
    shio234: 'Shio 234'
  };

  function setNavActive(page){
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.page === page));
  }

  function goPage(page){
    body.dataset.page = page;
    delete body.dataset.subpageOpen; // selalu mulai dari menu/awal halaman itu
    setNavActive(page);
    if(page === 'generator' || page === 'rekap'){
      const btn = oldTabButtons.find(b => b.dataset.tab === page);
      if(btn) btn.click(); // pastikan tabpanel-nya diberi class active oleh sistem tab lama
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  navBtns.forEach(b => b.addEventListener('click', () => goPage(b.dataset.page)));
  window.goPage = goPage;

  chevRows.forEach(row => {
    row.addEventListener('click', () => {
      const target = row.dataset.target;
      const btn = oldTabButtons.find(b => b.dataset.tab === target);
      if(btn) btn.click(); // reuse sistem tab lama supaya panel yang benar jadi .active
      body.dataset.subpageOpen = '1';
      if(subTitleEl) subTitleEl.textContent = titleByTab[target] || '';
      history.pushState({ subpageOpen: true, tab: target }, '', location.href);
      subpageHistoryPushed = true;
      // Arahkan pandangan ke konten yang baru dibuka (header sub-halaman + isinya),
      // BUKAN ke paling atas halaman Analisis (yang isinya kartu Mode Analisa dkk).
      const header = document.getElementById('subpageHeader');
      if(header) header.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  });

  function goBackFromSubpage(){
    if(subpageHistoryPushed){
      history.back(); // akan memicu popstate → closeSubpage()
    } else {
      closeSubpage();
    }
  }

  if(backBtn){
    backBtn.addEventListener('click', goBackFromSubpage);
  }

  // Tombol Kembali floating: muncul kalau sedang di subpage Analisis DAN
  // sudah discroll ke bawah melewati batas tertentu (tombol Kembali di header
  // sudah tidak kelihatan lagi), supaya user tak perlu scroll balik ke atas dulu.
  const floatBackBtn = document.getElementById('subpageFloatBackBtn');
  if(floatBackBtn){
    const FLOAT_BACK_SHOW_AFTER_PX = 160;
    window.addEventListener('scroll', () => {
      const active = body.dataset.page === 'analisis' && body.dataset.subpageOpen === '1';
      floatBackBtn.classList.toggle('show', active && window.scrollY > FLOAT_BACK_SHOW_AFTER_PX);
    }, { passive: true });
    floatBackBtn.addEventListener('click', goBackFromSubpage);
  }

  // Tangkap tombol back bawaan HP/browser: kalau subpage Analisis (Formula X,
  // Jumlah & Selisih, Ai Ai, Shio234) sedang terbuka, tutup subpage-nya saja
  // dan tetap di situs — jangan sampai keluar/mundur dari halaman web.
  window.addEventListener('popstate', () => {
    if(body.dataset.subpageOpen){
      closeSubpage();
    }
  });

  // Cerminkan status "belum siap" (data-locked) dari tombol tab lama ke baris chevron baru
  function refreshChevLocks(){
    chevRows.forEach(row => {
      const btn = oldTabButtons.find(b => b.dataset.tab === row.dataset.target);
      if(!btn) return;
      row.toggleAttribute('data-locked', btn.hasAttribute('data-locked'));
    });
  }
  refreshChevLocks();
  new MutationObserver(refreshChevLocks).observe(
    document.getElementById('navTabs') || document.body,
    { attributes: true, attributeFilter: ['data-locked'], subtree: true }
  );

  setNavActive('beranda'); // state awal: Beranda aktif
})();

// ===================== BERANDA: akordeon Data Historis + tap Top Candidate -> Formula X =====================
(function(){
  const accordion = document.getElementById('dataAccordion');
  const header = document.getElementById('dataAccordionHeader');
  if(accordion && header){
    header.addEventListener('click', () => accordion.classList.toggle('open'));
  }

  const topArrow = document.getElementById('topCandidateArrow');
  if(topArrow){
    topArrow.addEventListener('click', () => {
      // Pindah ke halaman Analisis lalu buka langsung sub-halaman Formula X
      const bottomBtn = document.querySelector('.bottomnav .navBtn[data-page="analisis"]');
      if(bottomBtn) bottomBtn.click();
      const chevRow = document.querySelector('#analisisMenu .chevRow[data-target="formulax"]');
      if(chevRow) chevRow.click();
    });
  }
})();
