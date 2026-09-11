// ===================== REKAP =====================
// Rekap prediksi otomatis (dibuat tiap tombol Salin ditekan) + auto-fill hasil dari Firebase.

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

  const mode = (typeof getAppMode === 'function') ? getAppMode() : 'normal';

  return {
    id: 'rk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    tanggal: rekapTodayStr(),
    market,
    sourceMarket,
    baseCount,
    mode, // 'normal' | 'semi' | 'auto' — mode yang sedang aktif saat rekap ini dibuat
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
// Menang jika SEMUA posisi Formula X yang tercatat di entry ini kena (digit hasil ada di pool
// posisi yang sama) — logika sama persis dengan yang dipakai untuk highlight hijau di atas,
// hanya diringkas jadi satu status ya/tidak. Kalau entry tidak punya data Formula X sama sekali
// (fxLabels kosong), status tidak bisa ditentukan -> null (tampil netral, bukan Win/Lose).
function rekapComputeWinLose(entry, resultDigits){
  if(!entry.fxLabels || !entry.fxLabels.length || !resultDigits) return null;
  for(let i = 0; i < entry.fxLabels.length; i++){
    const label = entry.fxLabels[i];
    const pool = entry.fxPools[i] || '';
    const target = resultDigits[label];
    if(!target || !pool.includes(target)) return 'lose';
  }
  return 'win';
}

const REKAP_MODE_LABEL = { normal: 'Normal', semi: 'Semi', auto: 'Auto' };

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
    const winLose = entry.hasil ? rekapComputeWinLose(entry, resultDigits) : null;
    const winLoseChip = winLose === 'win'
      ? `<span class="pill pill-win">✓ Win</span>`
      : winLose === 'lose'
        ? `<span class="pill pill-lose">✕ Lose</span>`
        : '';
    const modeChip = entry.mode
      ? `<span class="pill pill-mode-${entry.mode}">${REKAP_MODE_LABEL[entry.mode] || entry.mode}</span>`
      : '';
    const statusChip = entry.hasil
      ? `<span class="rekapStatus done">${rekapEscapeHtml(entry.hasil)}</span>`
      : `<span class="rekapStatus waiting">menunggu</span>`;
    return `
      <div class="rekapItem" data-id="${entry.id}">
        <div class="rekapHead" data-action="toggle">
          <div class="rekapTitle">${rekapEscapeHtml(entry.market)}</div>
          <div class="rekapHeadRight">
            ${statusChip}
            ${winLoseChip}
            ${modeChip}
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

