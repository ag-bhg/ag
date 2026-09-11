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
        <td>${r.pasaran}</td>
        <td>${r.periode}</td>
        <td>${r.nomor}</td>
      </tr>
    `).join('');
  }
  allpBadgeSet(`${allPeriodeHistoryList.length}/${ALLP_HISTORY_LIMIT} data`);
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

const allPeriodeHistoryHeaderEl = document.getElementById('allPeriodeHistoryHeader');
const allPeriodeHistoryAccordionEl = document.getElementById('allPeriodeHistoryAccordion');
if(allPeriodeHistoryHeaderEl && allPeriodeHistoryAccordionEl){
  allPeriodeHistoryHeaderEl.addEventListener('click', () => allPeriodeHistoryAccordionEl.classList.toggle('open'));
}
