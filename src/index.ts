import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { verifySignature, parseWebhookEvents, saveMessages } from "./webhook";

type Bindings = {
  DB: D1Database;
  LINE_CHANNEL_SECRET: string;
  API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// LINE Webhook受信（LINEリトライ防止のため、処理失敗でも200を返す）
app.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-line-signature") ?? "";

  const valid = await verifySignature(body, signature, c.env.LINE_CHANNEL_SECRET);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  try {
    const events = parseWebhookEvents(body);
    await saveMessages(events, c.env.DB);
  } catch (e) {
    console.error("Failed to process webhook:", e);
  }
  return c.json({ ok: true });
});

// Bearer認証ミドルウェア（GET/POST /messages用）
const api = new Hono<{ Bindings: Bindings }>();
api.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.slice(7) !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// 未処理メッセージ取得
api.get("/messages", async (c) => {
  const limitParam = Number(c.req.query("limit") ?? "50");
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 50;
  const processed = c.req.query("processed") === "1" ? 1 : 0;

  const { results } = await c.env.DB.prepare(
    "SELECT id, line_message_id, user_id, message_type, content, received_at, processed FROM messages WHERE processed = ? ORDER BY id ASC LIMIT ?",
  )
    .bind(processed, limit)
    .all();

  return c.json({ messages: results });
});

// 処理済みフラグ更新
api.post("/messages/:id/processed", async (c) => {
  const id = c.req.param("id");
  const result = await c.env.DB.prepare(
    "UPDATE messages SET processed = 1 WHERE id = ?",
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});

app.route("/", api);

export default app;
