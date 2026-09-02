import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/settings\/([^/]+)$/);

    if (match) {
      const pasaran = decodeURIComponent(match[1]);

      try {
        // Diagnostic only: tidak menulis data ke Neon
        if (!env.DATABASE_URL) {
          return Response.json(
            {
              ok: false,
              stage: 'env',
              error: 'DATABASE_URL tidak tersedia di Worker'
            },
            { status: 500 }
          );
        }

        const sql = neon(env.DATABASE_URL);

        if (request.method === 'GET') {
          const rows = await sql`
            SELECT settings
            FROM s1_settings
            WHERE pasaran = ${pasaran}
          `;

          return Response.json({
            ok: true,
            stage: 'database',
            pasaran,
            rows: rows.length,
            data: rows[0]?.settings ?? null
          });
        }

        if (request.method === 'POST') {
          return Response.json(
            {
              ok: false,
              stage: 'diagnostic',
              error: 'POST dinonaktifkan sementara selama diagnostic test'
            },
            { status: 405 }
          );
        }

        return Response.json(
          {
            ok: false,
            error: 'Method tidak didukung'
          },
          { status: 405 }
        );

      } catch (error) {
        return Response.json(
          {
            ok: false,
            stage: 'neon_or_sql',
            error: error?.message ?? String(error),
            name: error?.name ?? 'UnknownError'
          },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
