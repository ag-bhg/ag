// ===================================================================
// ENDPOINT BARU: GET list periode (untuk populate dropdown di S1)
// ===================================================================
if (url.pathname === '/api/data/periode-list') {
  try {
    const dbUrl = await env.DATABASE_URL_SECRET.get();
    if (!dbUrl) {
      return Response.json({ ok: false, error: 'DATABASE_URL tidak tersedia' }, { status: 500 });
    }
    
    const sql = neon(dbUrl);
    
    // Query: ambil DISTINCT kode_pasaran dari table history
    const rows = await sql`
      SELECT DISTINCT kode_pasaran 
      FROM history 
      WHERE kode_pasaran IS NOT NULL AND kode_pasaran != ''
      ORDER BY kode_pasaran ASC
    `;
    
    const kodeList = rows.map(row => row.kode_pasaran);
    
    return Response.json({
      ok: true,
      kode_list: kodeList,
      count: kodeList.length
    });
  } catch (e) {
    console.error('Error di periode-list:', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// ===================================================================
// ENDPOINT BARU: GET data by periode (untuk load ke textarea di S1)
// ===================================================================
if (url.pathname === '/api/data/by-periode') {
  try {
    const kode = url.searchParams.get('kode') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000'), 5000);
    
    if (!kode) {
      return Response.json({ ok: false, error: 'Parameter kode harus diisi' }, { status: 400 });
    }
    
    const dbUrl = await env.DATABASE_URL_SECRET.get();
    if (!dbUrl) {
      return Response.json({ ok: false, error: 'DATABASE_URL tidak tersedia' }, { status: 500 });
    }
    
    const sql = neon(dbUrl);
    
    // Query: ambil data berdasarkan kode_pasaran, sorted terbaru duluan
    const rows = await sql`
      SELECT tanggal, periode, nomor
      FROM history 
      WHERE kode_pasaran = ${kode}
      ORDER BY sort_key DESC
      LIMIT ${limit}
    `;
    
    if (rows.length === 0) {
      return Response.json({
        ok: false,
        data: '',
        count: 0,
        message: `Tidak ada data untuk periode "${kode}"`
      }, { status: 404 });
    }
    
    // Format: "tanggal | periode | nomor" (satu baris per data)
    const formattedLines = rows.map(row => 
      `${row.tanggal} | ${row.periode} | ${row.nomor}`
    );
    
    const dataStr = formattedLines.join('\n');
    
    return Response.json({
      ok: true,
      data: dataStr,
      count: rows.length,
      kode_pasaran: kode,
      message: `Berhasil load ${rows.length} data`
    });
  } catch (e) {
    console.error('Error di by-periode:', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
