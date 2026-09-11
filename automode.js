// ===================== AUTOMODE =====================
// Auto Generator Formula X (Gen1/Gen2 A/B/C) + Mode Normal/Semi Auto/Auto (pipeline penuh).

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


// ===================== MODE: NORMAL / SEMI AUTO / AUTO =====================
const APP_MODE_KEY = 'appMode_v1';
let fxGen1SemiAutoLocked = false; // true saat Gen 1 dikunci lewat popup Semi Auto (bukan lewat formula)

function getAppMode(){ return localStorage.getItem(APP_MODE_KEY) || 'normal'; }

// Bagian TAMPILAN saja (pill aktif + kartu info yang ditampilkan) — dipisah dari commit mode
// supaya pill "Semi Auto" bisa dipakai untuk PREVIEW halaman pengaturan tanpa langsung
// mengaktifkan mode (mode Semi baru benar-benar commit saat tombol "Aktifkan Semi Auto" ditekan).
function showModeView(mode){
  document.querySelectorAll('.modeBtn').forEach(b=>{
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  // Tampilkan kartu info & info box sesuai mode yang dipilih (Normal/Semi/Auto) di halaman Analisis
  ['normal', 'semi', 'auto'].forEach(m => {
    const suffix = (m === 'semi' ? 'Semi' : m === 'auto' ? 'Auto' : 'Normal');
    const card = document.getElementById('modeInfo' + suffix);
    const box = document.getElementById('modeInfoBox' + suffix);
    if(card) card.style.display = (m === mode) ? '' : 'none';
    if(box) box.style.display = (m === mode) ? '' : 'none';
  });
  const semiPanel = document.getElementById('semiAutoSettingsPanel');
  if(semiPanel) semiPanel.style.display = (mode === 'semi') ? '' : 'none';
  // Semi Auto: pengaturan sudah otomatis (Preset Strategi + Angka Bahan Gen 1), jadi menu
  // "Pengaturan Analisa" (Formula X/Jumlah & Selisih/Ai Ai/Shio 234) disembunyikan.
  const pengaturanAnalisa = document.getElementById('pengaturanAnalisaSection');
  if(pengaturanAnalisa) pengaturanAnalisa.style.display = (mode === 'semi') ? 'none' : '';
}

function setAppMode(mode){
  localStorage.setItem(APP_MODE_KEY, mode);
  showModeView(mode);
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

  // 8) Pipeline auto/semi auto selesai — arahkan user ke tab Generator dan sorot tombol
  // Salin (Filter Pangkas Kombinasi) sebagai hasil akhir yang siap disalin.
  if(typeof window.goPage === 'function') window.goPage('generator');
  else if(typeof window.gotoTab === 'function') window.gotoTab('generator', true);
  const _copyBtn = document.getElementById('filterCopyBtn');
  if(_copyBtn){
    _copyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    _copyBtn.classList.remove('autoPipelineHighlight');
    void _copyBtn.offsetWidth; // reset animasi kalau sebelumnya masih jalan
    _copyBtn.classList.add('autoPipelineHighlight');
    setTimeout(() => _copyBtn.classList.remove('autoPipelineHighlight'), 3500);
  }

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
  const ok = presetLoad(name, {refreshCoverData: false});
  if(!ok){ alert(`Preset "${name}" tidak ditemukan — pilih ulang Preset Aktif.`); return; }
  setAppMode('auto');
  document.getElementById('modeFeedback').textContent =
    `Mode Auto — preset "${name}" dimuat. Pilih pasaran/periode di bawah untuk menjalankan alur Formula X → Generate → Filter otomatis.`;

  // Jangan langsung jalankan pipeline di sini — arahkan dulu ke pemilihan
  // pasaran/periode di halaman Analisis. Pipeline otomatis akan jalan sendiri (lihat
  // analyze() di formula.js) begitu pasaran/periode benar-benar dipilih.
  if(typeof window.goPage === 'function') window.goPage('analisis');
  const periodeSel = document.getElementById('analisisPeriodeSelect');
  if(periodeSel){
    periodeSel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    periodeSel.classList.remove('autoPipelineHighlight');
    void periodeSel.offsetWidth;
    periodeSel.classList.add('autoPipelineHighlight');
    setTimeout(() => periodeSel.classList.remove('autoPipelineHighlight'), 3500);
  }
});

// ── Pill SEMI AUTO: cuma pindah tampilan ke panel Pengaturan Semi Auto — TIDAK langsung
// mengaktifkan mode. Mode baru benar-benar commit saat tombol "Aktifkan Semi Auto" ditekan. ──
document.getElementById('modeSemiAutoBtn').addEventListener('click', ()=>{
  showModeView('semi');
  document.getElementById('semiAutoFeedback').textContent = '';
  const hint = document.getElementById('semiAutoModalHint');
  hint.textContent = (lastPosLabels && lastPosLabels.length)
    ? `Isi satu angka saja untuk mengisi semua posisi (${lastPosLabels.join(',')}), atau pisahkan tiap posisi dengan titik (.) atau koma (,) sesuai urutan: ${lastPosLabels.join(' → ')}.`
    : 'Isi satu angka saja untuk mengisi semua posisi, atau pisahkan tiap posisi dengan titik (.) atau koma (,) sesuai urutan posisi aktif. (Proses Data Historis dulu supaya posisi terdeteksi.)';
});

// ── Tombol "Aktifkan Semi Auto": validasi Preset Aktif & Data Historis, kunci Gen 1 dari
// Angka Bahan, baru commit mode Semi (fungsinya sama persis dengan tombol Save popup lama). ──
document.getElementById('semiAutoActivateBtn').addEventListener('click', ()=>{
  const feedback = document.getElementById('semiAutoFeedback');
  const name = getActivePresetName();
  if(!name){ feedback.textContent = 'Pilih dulu Preset Strategi.'; return; }
  const ok = presetLoad(name, {refreshCoverData: false});
  if(!ok){ feedback.textContent = `Preset "${name}" tidak ditemukan — pilih ulang Preset Strategi.`; return; }
  if(!lastPosLabels || !lastPosLabels.length){
    feedback.textContent = 'Isi & proses Data Historis dulu (posisi A/C/K/E belum terdeteksi).';
    return;
  }

  const raw = document.getElementById('semiAutoInput').value.trim();
  if(!raw){ feedback.textContent = 'Isi Angka Bahan Gen 1 dulu.'; return; }

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

  setAppMode('semi');
  const pipelineOk = runAutoPipeline();
  feedback.textContent = pipelineOk
    ? 'Mode Semi Auto aktif — Gen 1 terkunci dari Angka Bahan, alur Formula X → Generate → Filter selesai otomatis.'
    : 'Mode Semi Auto aktif — Gen 1 terkunci dari Angka Bahan, tapi alur otomatis belum jalan (cek Data Historis).';
  document.getElementById('modeFeedback').textContent = feedback.textContent;
});

// Terapkan mode tersimpan (kalau ada) saat halaman dibuka, tanpa menjalankan ulang popup/preset.
setAppMode(getAppMode());

// ── Tombol Mode Analisa di halaman Beranda: teruskan ke tombol asli di halaman Analisis ──
// (bukan logika baru — supaya validasi Preset Aktif/Data Historis & popup Semi Auto tetap
// satu sumber kebenaran, tidak dobel dan tidak bisa beda perilaku antara Beranda & Analisis)
document.getElementById('modeNormalBtnHome').addEventListener('click', ()=>{
  document.getElementById('modeNormalBtn').click();
});
document.getElementById('modeSemiAutoBtnHome').addEventListener('click', ()=>{
  document.getElementById('modeSemiAutoBtn').click();
  if(typeof window.goPage === 'function') window.goPage('analisis');
});
document.getElementById('modeAutoBtnHome').addEventListener('click', ()=>{
  document.getElementById('modeAutoBtn').click();
});

