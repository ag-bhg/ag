// ===================== FORMULA =====================
// Jumlah & Selisih, Ai Ai (Angka Ikut 4D + Ai Bulanan), Shio 234, dan analyze()
// (fungsi inti yang merender ulang semua panel analisis setiap kali data historis diproses).
// Formula X sudah dipindah ke formulax.js (dimuat SETELAH file ini).

function setupSectionToggle(headId, wrapId, iconId){
  document.getElementById(headId).addEventListener('click', () => {
    const wrap = document.getElementById(wrapId);
    const icon = document.getElementById(iconId);
    const isHidden = wrap.style.display === 'none';
    wrap.style.display = isHidden ? 'block' : 'none';
    icon.textContent = isHidden ? '▾' : '▸';
  });
}
setupSectionToggle('jsToggle', 'jsWrap', 'jsToggleIcon');
setupSectionToggle('cbToggle', 'cbWrap', 'cbToggleIcon');
setupSectionToggle('shioToggle', 'shioWrap', 'shioToggleIcon');
setupSectionToggle('genToggle', 'genWrap', 'genToggleIcon');

function analyze(){
  // ── Aturan tetap: ganti pasaran/periode (analyze() ini selalu dipanggil ulang tiap kali
  // Data Historis/Periode berubah) -> daftar hasil Status Streak (fxStreakGen1List) SELALU
  // dibersihkan, tanpa syarat status lock Gen 1. Taruh paling atas supaya pasti kena walau
  // nanti di bawah ada jalur early-return lain. ──
  if(typeof fxClearStreakGen1List === 'function') fxClearStreakGen1List();

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

  // Kalau Mode Auto/Semi Auto sedang aktif, setiap kali Periode/Data Historis diproses ulang
  // (fungsi analyze() ini), langsung lanjutkan sisa alurnya (Auto Generate → ... → Terapkan
  // Filter) TANPA perlu klik tombol Auto lagi — jadi kontrol berikutnya benar-benar dari
  // Periode. computeFormulaX sudah dipanggil di atas, jadi lewati ulang bagian itu.
  if(typeof getAppMode === 'function'){
    const _mode = getAppMode();
    if(_mode === 'auto' || _mode === 'semi'){
      // Sengaja tidak di-await: fungsi ini sekarang async (retry Gen 2 sampai 3x sebelum
      // Auto Generate jalan). analyze() tidak perlu menunggu; sisa alur (Auto Generate →
      // Filter) jalan sendiri di background, termasuk alert reload kalau retry gagal.
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
  const NJumlah = parseInt(document.getElementById('jsRecoCountJumlah').value, 10) || 5;
  const NSelisih = parseInt(document.getElementById('jsRecoCountSelisih').value, 10) || 5;

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
      const jumlahOrdered = manualJumlah || bestCoverJsPart(subN, 'jumlahList', NJumlah);
      const selisihOrdered = manualSelisih || bestCoverJsPart(subN, 'selisihList', NSelisih);
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
    + `Window per baris: <b style="color:var(--ink);">${ROWS_SHOWN} data</b> · Jumlah digit rekomendasi — Jumlah: <b style="color:var(--ink);">${NJumlah}</b>, Selisih: <b style="color:var(--ink);">${NSelisih}</b>.`;

  document.getElementById('jsCard').style.display = 'block';
}

// tombol Jumlah/Selisih Prediksi -> langsung isi filter terkait (sama seperti pakaiAiPrediksi di Angka Ikut 4D)
function pakaiJsPrediksi(kind){
  if(!jsCtReference[kind]) return;
  if(kind === 'jumlah') document.getElementById('filterJumlah').value = jsTopValues.jumlah.join(',');
  else if(kind === 'selisih') document.getElementById('filterSelisih').value = jsTopValues.selisih.join(',');
  if(lastTop8Pools.length) applyFilters();
}

// ganti dropdown "Jumlah Baris Tabel" / "Jumlah Rekomendasi" -> render ulang tabel pakai data yang sama, tanpa hitung ulang seluruh analisis
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

// tombol "Cari (cover data)": hitung digit dengan cakupan PALING TINGGI ke N data teratas (N = dropdown
// Jumlah Baris Tabel), lalu isi ke kotak manual (otomatis dipakai sama untuk SEMUA baris tabel) — persis logika cariAiCoverPart.
function cariJsCoverPart(key, manualInputId){
  if(!lastJsUsed || !lastJsUsed.length) return;
  const rowsShown = parseInt(document.getElementById('jsRowsShown').value, 10) || 15;
  const nFieldId = (key === 'jumlahList') ? 'jsRecoCountJumlah' : 'jsRecoCountSelisih';
  const n = parseInt(document.getElementById(nFieldId).value, 10) || 5;
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

// Jumlah digit Ai (Out) per posisi — dibaca dari dropdown di atas tiap kolom Ai AC / Ai CK / Ai KE (pilihan 2-9).
// TIDAK ada fallback diam-diam: kalau dropdown tidak ada / nilainya di luar 2-9, return null supaya
// pemanggil berhenti dan memberi notifikasi (bukan lanjut pakai angka lain tanpa sepengetahuan user).
// `part` default 'AC' (dropdown lama #aiDigitCount kini milik posisi AC).
const AI_DIGIT_SELECT_IDS = { AC: 'aiDigitCount', CK: 'aiDigitCountCK', KE: 'aiDigitCountKE' };
function getAiDigitCount(part){
  const el = document.getElementById(AI_DIGIT_SELECT_IDS[part || 'AC']);
  const v = el ? parseInt(el.value, 10) : NaN;
  return (Number.isInteger(v) && v >= 2 && v <= 9) ? v : null;
}
const AI_MONTH_THRESHOLD = 0.70; // Ai bulanan diganti kalau cakupannya ke data bulan berjalan turun di bawah ini

// Radio "Sumber Data" (Ai Ai) — persis pola fxRefreshHistoryIfTerbaru di Formula X:
// - Data Default = baca ULANG kotak Data Historis (#dataInput), sesuai pasaran/periode yang
//   sedang aktif di kotak itu (sama seperti analyze()).
// - Data Terbaru = ambil dari tabel Histori All Periode (allPeriodeHistoryList, historyall.js —
//   gabungan SEMUA pasaran dari Firebase, terbaru di index 0), dipakai apa adanya tanpa
//   difilter ke pasaran yang aktif.
// Menimpa lastAiUsed/lastAiTargetLen/lastAiUsedMonths lalu render ulang tabel Ai Ai.
function aiRefreshHistoryIfTerbaru(){
  const statusEl = document.getElementById('aiDataSourceStatus');
  const useTerbaru = (document.querySelector('input[name="aiDataSource"]:checked') || {}).value === 'terbaru';
  let tokens, months;
  if(useTerbaru){
    const rows = (typeof allPeriodeHistoryList !== 'undefined' && Array.isArray(allPeriodeHistoryList)) ? allPeriodeHistoryList : [];
    tokens = rows.map(r => String((r && r.nomor) || '').replace(/[^0-9]/g, '')).filter(Boolean);
    months = rows.map(r => extractMonthKey(String((r && r.tanggal) || '')));
  } else {
    const raw = document.getElementById('dataInput').value;
    const parsed = parseDataWithMonth(raw);
    tokens = parsed.tokens;
    months = parsed.months;
  }
  if(!tokens.length){
    if(statusEl) statusEl.textContent = useTerbaru
      ? '⚠️ Tabel Histori All Periode masih kosong, pakai data sebelumnya.'
      : '⚠️ Kotak Data Historis kosong/tidak terbaca, pakai data sebelumnya.';
    return; // sumbernya kosong/tidak valid — biarkan snapshot lama, jangan ditimpa
  }
  const targetLen = pickTargetLength(tokens);
  const used = [], usedMonths = [];
  tokens.forEach((t, i) => {
    if(t.length === targetLen){ used.push(t); usedMonths.push(months[i] || null); }
  });
  if(!used.length) return;
  renderAngkaIkut4D(used, targetLen, usedMonths);
  if(statusEl) statusEl.textContent = useTerbaru
    ? `📡 Data Terbaru (Histori All Periode, semua pasaran) — ${used.length} angka.`
    : `📄 Data Default (Data Historis) — ${used.length} angka.`;
}

// Klik radio langsung memicu refresh (tidak perlu klik tombol lain).
document.querySelectorAll('input[name="aiDataSource"]').forEach(radio => {
  radio.addEventListener('change', aiRefreshHistoryIfTerbaru);
});

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
  const PARTS = ['AC', 'CK', 'KE'];
  // jumlah digit Ai per posisi (dari dropdown di atas kolom Ai AC / Ai CK / Ai KE)
  const AI_DIGIT_COUNTS = {};
  const badParts = PARTS.filter(p => (AI_DIGIT_COUNTS[p] = getAiDigitCount(p)) === null);
  if(badParts.length){
    ctReference = { AC: null, CK: null, KE: null };
    ctBox.innerHTML = '';
    tbody.innerHTML = `<tr><td colspan="5" class="emptynote" style="color:var(--rose);">⚠️ Jumlah Output Ai untuk posisi ${badParts.join(', ')} tidak valid — pilih nilai 2–9 di dropdown posisi tersebut. Perhitungan Ai dihentikan.</td></tr>`;
    return;
  }

  // window kontrol per bagian = sama dengan jumlah baris tabel (dropdown tunggal di atas)
  const winMap = { AC: ROWS_SHOWN, CK: ROWS_SHOWN, KE: ROWS_SHOWN };

  // Ai manual: textbox terpisah. Kalau diisi minimal 4 digit (maksimal 7),
  // digit itu dipakai sebagai Ai TETAP untuk bagian ini di SEMUA baris tabel (menggantikan hitungan otomatis).
  const manualDigitsFor = (part) => {
    const raw = document.getElementById(`aiWin${part}Manual`).value.replace(/\D/g, '').slice(0, 7);
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
          aiRow[p] = bestCoverAiPart(subN, p, AI_DIGIT_COUNTS[p]);
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
    aiBulanan[p] = computeAiBulananPart(used, usedMonths || [], winMap[p], p, AI_DIGIT_COUNTS[p], AI_MONTH_THRESHOLD);
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

// dropdown "Jumlah Output Ai" per posisi (AC/CK/KE): ganti jumlah digit hasil bestCoverAiPart posisi itu,
// otomatis refresh tabel & Ai Bulanan
Object.values(AI_DIGIT_SELECT_IDS).forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if(lastAiUsed) renderAngkaIkut4D(lastAiUsed, lastAiTargetLen, lastAiUsedMonths);
  });
});

// textbox Ai manual AC/CK/KE: hanya terima digit, maksimal 7 karakter, otomatis refresh tabel tiap kali diketik
['aiWinACManual', 'aiWinCKManual', 'aiWinKEManual'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const cleaned = e.target.value.replace(/\D/g, '').slice(0, 7);
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
  const n = getAiDigitCount(partKey);
  if(n === null){
    alert(`Jumlah Output Ai untuk posisi ${partKey} tidak valid — pilih nilai 2–9 dulu.`);
    return;
  }
  const ai = bestCoverAiPart(subset, partKey, n);
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

