import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    // Placeholder só para `prisma generate` funcionar sem banco; migrate exige DATABASE_URL real.
    url: process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/placeholder',
  },
});
