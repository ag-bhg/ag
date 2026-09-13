// ===================== HISTORI ALL PERIODE =====================
// Tabel gabungan di Beranda: menampilkan tiap baris baru yang masuk/diupdate
// di Firebase (semua pasaran, bukan cuma pasaran yang lagi dipilih). Format
// kolom sama seperti baris Data Historis (Tanggal / Periode / Nomor) +
// kolom Jam (format 12.45) + kolom Pasaran (karena gabungan banyak pasaran).
// Dibatasi maksimal 190 data — kalau sudah penuh, data yang paling lama
// masuk otomatis dibuang duluan (FIFO).
//
// CATATAN PERUBAHAN: file ini SEKARANG READ-ONLY (cuma dengarkan & tampilkan
// node /allPeriodeHistory). Yang MENULIS ke node ini sekarang Worker
// terpisah (worker.js, Cloudflare Cron -> Neon -> Firebase) supaya tetap
// tercatat walau S1 tidak ada yang buka sama sekali. Dulu bagian tulis ada
// di sini (allpTryClaimNewRow/allpAppendRecordToFirebase/
// onFirebaseMasterDataUpdate) — sudah dihapus supaya tidak dobel catat
// bareng Worker (2 penulis independen bisa mencatat baris yang sama 2x).
//
// PENTING: disimpan di Firebase Realtime Database (bukan localStorage), jadi
// otomatis kebuka sama di HP/perangkat lain juga — datanya sendiri tetap
// format JSON biasa (itu memang format asli Firebase RTDB):
//   /allPeriodeHistory -> array record (JSON), terbaru di index 0
// Akordeon ini default tertutup, terbuka kalau headernya diklik.

const ALLP_HISTORY_LIMIT = 190;
const ALLP_HISTORY_PATH = 'allPeriodeHistory';

// Larik histori aktif yang lagi ditampilkan (sinkron langsung dari Firebase).
let allPeriodeHistoryList = [];

function allpBadgeSet(text){
  const badge = document.getElementById('allPeriodeHistoryBadge');
  if(badge) badge.textContent = text;
}

function allpRenderTable(){
  const tbody = document.getElementById('allPeriodeHistoryTbody');
  const emptyNote = document.getElementById('allPeriodeHistoryEmptyNote');
  if(!tbody) return;
  if(!allPeriodeHistoryList.length){
    tbody.innerHTML = '';
    if(emptyNote) emptyNote.style.display = 'block';
  } else {
    if(emptyNote) emptyNote.style.display = 'none';
    tbody.innerHTML = allPeriodeHistoryList.map(r => `
      <tr>
        <td>${r.jam}</td>
        <td>${r.tanggal}</td>
        <td>${r.periode}</td>
        <td>${r.nomor}</td>
      </tr>
    `).join('');
  }
  allpBadgeSet(`${allPeriodeHistoryList.length}/${ALLP_HISTORY_LIMIT} data`);
  if(typeof allpRenderShowcasePage === 'function') allpRenderShowcasePage(false);
}

// ---------- Init: dengarkan node histori langsung dari Firebase (live-sync semua perangkat) ----------
// READ-ONLY: cuma baca & render. Penulisan baris baru sekarang tanggung
// jawab Worker terpisah (lihat catatan di atas).
function allpInitFirebaseListener(){
  if(!db){
    allpBadgeSet('Firebase tidak tersedia');
    return;
  }
  authReadyPromise.then(isAuthed => {
    if(!isAuthed){
      allpBadgeSet('Auth gagal');
      return;
    }
    db.ref(ALLP_HISTORY_PATH).on('value', snap => {
      const val = snap.val();
      allPeriodeHistoryList = Array.isArray(val) ? val.filter(Boolean) : [];
      allpRenderTable();
    }, () => allpBadgeSet('Gagal baca histori'));
  });
}

allpBadgeSet('Menghubungkan…');
allpInitFirebaseListener();

// ===================== SHOWCASE "RESULT LIVE" =====================
// Kartu neon biru (gaya sama seperti Result Terakhir) yang menampilkan result
// terbaru dari beberapa pasaran sekaligus, diambil dari allPeriodeHistoryList
// (sumber data yang sama dengan tabel Histori All Periode di bawahnya).
// Ditampilkan 4 kartu (2x2) sekaligus, gantian tiap 30 detik dengan animasi
// geser, dan tiap kartu punya hitung mundur sendiri menuju jam result berikutnya.
const ALLP_SHOWCASE_CODES = ['SDYL','SYD','HK','HKL','SG','TTM 00:00','TTM 13:00','TTM 16:00','TTM 19:00','TTM 22:00','TTM 23:00'];
const ALLP_SHOWCASE_PAGE_SIZE = 4;
const ALLP_SHOWCASE_INTERVAL_MS = 30000;
let allpShowcasePage = 0;

function allpShowcasePages(){
  const pages = [];
  for(let i = 0; i < ALLP_SHOWCASE_CODES.length; i += ALLP_SHOWCASE_PAGE_SIZE){
    pages.push(ALLP_SHOWCASE_CODES.slice(i, i + ALLP_SHOWCASE_PAGE_SIZE));
  }
  return pages;
}

// Cari baris TERBARU (allPeriodeHistoryList sudah terurut terbaru di index 0)
// yang kolom periode-nya diawali kode pasaran ini (mis. "SDYL-624" untuk kode "SDYL").
function allpFindLatestForCode(code){
  const prefix = `${code}-`;
  return allPeriodeHistoryList.find(r => typeof r?.periode === 'string' && r.periode.startsWith(prefix)) || null;
}

function allpFormatCountdownHMS(ms){
  const sec = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(hh).padStart(2,'0')} : ${String(mm).padStart(2,'0')} : ${String(ss).padStart(2,'0')}`;
}

function allpBuildShowcaseCardHtml(code){
  const info = (typeof S1_JADWAL_PASARAN !== 'undefined') ? S1_JADWAL_PASARAN[code] : null;
  const nama = info?.nama || code;
  const row = allpFindLatestForCode(code);
  const angka = row ? row.nomor : '----';
  return `
    <div class="neonCard">
      <div class="neonBand neonBand--head"><span>${nama}</span></div>
      <div class="neonBand neonBand--body"><span class="neonNumber">${angka}</span></div>
      <div class="neonBand neonBand--foot"><span class="neonTimer" data-code="${code.replace(/"/g,'&quot;')}">-- : -- : --</span></div>
    </div>`;
}

function allpTickShowcaseTimers(){
  document.querySelectorAll('#allPeriodeShowcaseGrid .neonTimer').forEach(el => {
    const code = el.getAttribute('data-code');
    const next = (typeof firebaseNextDraw === 'function') ? firebaseNextDraw(code) : null;
    el.textContent = next ? allpFormatCountdownHMS(next.ts - Date.now()) : '-- : -- : --';
  });
}

function allpRenderShowcasePage(animate){
  const grid = document.getElementById('allPeriodeShowcaseGrid');
  if(!grid) return;
  const pages = allpShowcasePages();
  if(!pages.length) return;
  const codes = pages[allpShowcasePage % pages.length];
  const paint = () => {
    grid.innerHTML = codes.map(allpBuildShowcaseCardHtml).join('');
    allpTickShowcaseTimers();
    if(animate){
      grid.classList.add('neonSlideIn');
      requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove('neonSlideIn')));
    }
  };
  if(animate){
    grid.classList.add('neonSlideOut');
    setTimeout(() => { grid.classList.remove('neonSlideOut'); paint(); }, 320);
  } else {
    paint();
  }
}

allpRenderShowcasePage(false);
setInterval(allpTickShowcaseTimers, 1000);
setInterval(() => { allpShowcasePage++; allpRenderShowcasePage(true); }, ALLP_SHOWCASE_INTERVAL_MS);

const allPeriodeHistoryHeaderEl = document.getElementById('allPeriodeHistoryHeader');
const allPeriodeHistoryAccordionEl = document.getElementById('allPeriodeHistoryAccordion');
if(allPeriodeHistoryHeaderEl && allPeriodeHistoryAccordionEl){
  allPeriodeHistoryHeaderEl.addEventListener('click', () => allPeriodeHistoryAccordionEl.classList.toggle('open'));
}
