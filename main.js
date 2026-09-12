// ===================== MAIN =====================
// Pengaturan (kumpul/pulihkan semua opsi), Preset Pengaturan, UI umum (tab, fade-in,
// badge sync), dan tombol Kembali ke Atas.

// ===================== NILAI DEFAULT RESMI SISTEM =====================
// Satu-satunya sumber kebenaran untuk "pengaturan default" seluruh sistem.
// resetAllSettings() di bawah SELALU ambil dari sini (lewat presetApplyFields) —
// supaya kalau nanti default berubah, cukup ubah di SATU tempat ini saja.
const SETTINGS_DEFAULTS = {
  // Formula X
  fxTrendN: '30',
  fxControlN: '10',
  fxOutN: '8',
  fxAutoFilterWorst: false,
  fxDataSource: 'default',
  // Jumlah & Selisih
  jsRowsShown: '30',
  jsRecoCountJumlah: '6',
  jsRecoCountSelisih: '6',
  jsJumlahManual: '',
  jsSelisihManual: '',
  // Ai Ai (Angka Ikut)
  aiDataSource: 'default',
  aiRowsShown: '30',
  aiDigitCount: '6',
  aiWinACManual: '',
  aiWinCKManual: '',
  aiWinKEManual: '',
  // Colok Bebas (referensi Ai Bulanan)
  cbMonthHistorySelect: '',
  // Shio
  shioPickCount: '6',
  shioRowsShown: '30',
  shioManual: ''
};

function resetAllSettings(){
  // Top Posisi: kosongkan pilihan internal supaya balik ke default (Kuat) saat dihitung ulang
  // — ini state di memori, bukan kontrol HTML, jadi tidak bisa ikut lewat presetApplyFields().
  // FX_SELECTED SENGAJA TIDAK direset manual di sini lagi: computeFormulaX() (dipanggil analyze()
  // tepat setelah resetAllSettings() di semua pemanggilnya) SELALU meng-overwrite FX_SELECTED ke
  // rangking akurasi tertinggi tiap posisi (lihat formula.js). Reset ganda di sini cuma tumpang
  // tindih dengan itu — dan berisiko konflik kalau nanti Preset ikut mengisi FX_SELECTED.
  FX_TOUCHED = {};
  TOP_POSISI_SELECTED = {};

  // Mode Normal WAJIB lepas dari kendali Preset — kalau tidak, aturan per-posisi preset yang
  // masih "aktif" akan dipasang lagi otomatis lewat hook di automode.js tiap Formula X dihitung.
  presetPendingExtra = null;

  // Generator: lepas kunci Gen 1/Gen 2 & sumber kustom Auto Generator (state internal juga).
  if(typeof unlockGen1Gen2 === 'function') unlockGen1Gen2();
  filterCustomSource = null;

  // Semua kontrol Formula X / Ai Ai / Jumlah & Selisih / Shio / Colok Bebas -> balik ke SETTINGS_DEFAULTS.
  presetApplyFields(SETTINGS_DEFAULTS);

  // Filter Pangkas Kombinasi sudah punya reset sendiri yang lengkap (checkbox, manual,
  // Twin Murni, Shio pick) dan nilainya sudah persis default yang disepakati -> pakai itu,
  // tidak perlu ditulis ulang di sini.
  if(typeof resetFilters === 'function') resetFilters();
}

// ---------- Kumpulkan & pulihkan SEMUA opsi/pengaturan di seluruh menu (Formula X, Kontrol Ai, Generator, Filter) ----------
// Dipakai oleh tombol Simpan/Muat supaya setiap data tersimpan membawa persis pilihan & input manual/otomatis
// yang sedang aktif di semua menu, bukan cuma teks Data Historis-nya saja.

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
  { id:'aiDataSource',   type:'radio', name:'aiDataSource' },
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

// ── Pengaturan per-posisi & Generator yang TIDAK bisa ikut lewat PRESET_FIELDS (bukan kontrol
// HTML statis dengan id/value tetap — FX_SELECTED & TOP_POSISI_SELECTED adalah state di memori,
// sedangkan checkbox Twin Murni dibangun ULANG tiap analyze() jadi tidak selalu ada di DOM). ──
function presetCollectExtra(){
  return {
    fxSelected: { ...FX_SELECTED },
    topPosisiSelected: { ...TOP_POSISI_SELECTED },
    twinPairs: (typeof getSelectedTwinMurniPairs === 'function') ? getSelectedTwinMurniPairs() : [],
    shio: [...document.querySelectorAll('.shioPick:checked')].map(el => el.dataset.shio),
    generator: { bulkOut: document.getElementById('bulkOut').value }
  };
}

// State "extra" milik preset yang SEDANG aktif dimuat — dipakai untuk dipasang ULANG tiap kali
// Formula X selesai dihitung (lihat hook fxStatus di automode.js), karena FX_SELECTED ditimpa
// otomatis ke rangking #1 dan checkbox Twin Murni dibangun ulang dari nol tiap computeFormulaX()/
// analyze() — persis alasan yang sama kenapa Gen2 butuh presetApplyGen2/fxApplyGen2Rule.
// Mode Normal (resetAllSettings) WAJIB mengosongkan ini supaya tidak diam-diam dipasang lagi.
let presetPendingExtra = null;

function presetApplyExtraNow(extra){
  if(!extra) return;

  // Generator: Kombinasi Acak manual/otomatis — aman dipasang kapan saja, tidak tergantung data.
  if(extra.generator && extra.generator.bulkOut != null){
    document.getElementById('bulkOut').value = extra.generator.bulkOut;
  }

  // Sisanya butuh Data Historis sudah diproses (posisi & Formula X sudah ada).
  if(!lastPosLabels || !lastPosLabels.length) return;

  // Formula X per posisi: timpa lagi rangking #1 bawaan computeFormulaX() dengan pilihan preset —
  // hanya kalau key formula itu masih valid untuk data saat ini.
  if(extra.fxSelected && FX_RECOMMENDATIONS){
    let changed = false;
    lastPosLabels.forEach(label => {
      const key = extra.fxSelected[label];
      const recs = FX_RECOMMENDATIONS[label] || [];
      if(key && recs.some(r => r.key === key)){
        FX_SELECTED[label] = key;
        FX_TOUCHED[label] = true;
        changed = true;
      }
    });
    if(changed){
      renderFormulaX(lastPosLabels);
      renderFxTrendNumbers(lastPosLabels, lastHistoryNumbers);
      renderFxBacktestTable(lastPosLabels, lastHistoryNumbers);
      if(typeof renderGen1LockUI === 'function') renderGen1LockUI();
      if(typeof renderGen2LockUI === 'function' && typeof FX_GEN2_SLOTS !== 'undefined') FX_GEN2_SLOTS.forEach(renderGen2LockUI);
      if(typeof fxApplyToGenerator === 'function') fxApplyToGenerator(true);
    }
  }

  // Top Posisi per posisi (Kuat/Sedang) — tidak ditimpa otomatis oleh computeFormulaX, jadi
  // cukup di-set langsung lalu render ulang.
  if(extra.topPosisiSelected){
    TOP_POSISI_SELECTED = { ...extra.topPosisiSelected };
    if(typeof renderTopPosisi === 'function') renderTopPosisi(lastPosLabels, lastHistoryNumbers);
  }

  // Twin Murni: checkbox-nya dibangun ulang tiap analyze(), jadi harus dicentang lagi di sini.
  (extra.twinPairs || []).forEach(([i, j]) => {
    const cb = document.querySelector(`.twinMurniPick[data-i="${i}"][data-j="${j}"]`);
    if(cb) cb.checked = true;
  });

  // Shio pick individual (checkbox statis, tapi disatukan di sini biar konsisten dengan yang lain).
  (extra.shio || []).forEach(s => {
    const cb = document.querySelector(`.shioPick[data-shio="${s}"]`);
    if(cb) cb.checked = true;
  });
  if(typeof updateShioPickNote === 'function') updateShioPickNote();
}

function presetSave(name){
  if(!name) return false;
  const all = presetLoadAll();
  if(!(name in all) && Object.keys(all).length >= PRESET_MAX_COUNT){
    alert(`Maksimal ${PRESET_MAX_COUNT} preset tersimpan. Hapus salah satu dulu sebelum menambah preset baru.`);
    return false;
  }
  all[name] = { savedAt: Date.now(), fields: presetCollectFields(), extra: presetCollectExtra(), gen2: presetCollectGen2() };
  presetSaveAll(all);
  return true;
}
function presetLoad(name, {refreshCoverData = true} = {}){
  const all = presetLoadAll();
  if(!all[name]) return false;
  presetApplyFields(all[name].fields);
  presetApplyGen2(all[name].gen2 || null);

  // Simpan sebagai "aturan aktif" supaya dipasang ulang otomatis tiap Formula X selesai dihitung
  // (lihat hook di automode.js), lalu langsung coba pasang sekarang juga kalau data sudah siap.
  presetPendingExtra = all[name].extra || null;
  presetApplyExtraNow(presetPendingExtra);

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
