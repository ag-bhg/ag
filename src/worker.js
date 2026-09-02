import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
    if (match) {
      const pasaran = decodeURIComponent(match[1]);
      const sql = neon(env.DATABASE_URL);
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
