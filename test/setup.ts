import { env } from "cloudflare:test";

// D1にスキーマを適用
const statements = env.SCHEMA_SQL
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

for (const stmt of statements) {
  await env.DB.prepare(stmt).run();
}
