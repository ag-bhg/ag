import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      return Response.json({
        db_test: env.DB_TEST ?? 'KOSONG',
        has_secret_binding: !!env.DATABASE_URL_SECRET
      });
    }

    const match = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
    if (match) {
      const pasaran = decodeURIComponent(match[1]);
      const dbUrl = await env.DATABASE_URL_SECRET.get();
      if (!dbUrl) {
        return Response.json({ ok: false, stage: 'env', error: 'DATABASE_URL tidak tersedia di Worker' });
      }
      const sql = neon(dbUrl);
      if (request.method === 'GET') {
        const rows = await sql`SELECT settings FROM s1_settings WHERE pasaran = ${pasaran}`;
        return Response.json(rows[0]?.settings ?? null);
      }
      if (request.method === 'POST') {
        const body = await request.json();
        await sql`
          INSERT INTO s1_settings (pasaran, settings, updated_at)
          VALUES (${pasaran}, ${JSON.stringify(body)}, now())
          ON CONFLICT (pasaran) DO UPDATE SET settings = ${JSON.stringify(body)}, updated_at = now()
        `;
        return Response.json({ ok: true });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
