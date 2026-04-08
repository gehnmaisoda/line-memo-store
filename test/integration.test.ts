import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";

const API_KEY = "test-api-key";
const CHANNEL_SECRET = "test-channel-secret";

function createEnv() {
  return {
    DB: env.DB,
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    API_KEY,
  };
}

async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function webhookBody(text: string, messageId = "msg-001") {
  return JSON.stringify({
    events: [
      {
        type: "message",
        message: { id: messageId, type: "text", text },
        source: { userId: "user-123", type: "user" },
      },
    ],
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM messages");
});

describe("POST /webhook", () => {
  it("正しい署名でメッセージを保存する", async () => {
    const body = webhookBody("テストメモ");
    const signature = await signBody(body, CHANNEL_SECRET);

    const res = await app.request("/webhook", {
      method: "POST",
      body,
      headers: { "x-line-signature": signature },
    }, createEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { results } = await env.DB.prepare("SELECT * FROM messages").all();
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("テストメモ");
    expect(results[0]!.line_message_id).toBe("msg-001");
    expect(results[0]!.processed).toBe(0);
  });

  it("不正な署名で401を返す", async () => {
    const res = await app.request("/webhook", {
      method: "POST",
      body: webhookBody("test"),
      headers: { "x-line-signature": "invalid" },
    }, createEnv());

    expect(res.status).toBe(401);
  });

  it("署名ヘッダーなしで401を返す", async () => {
    const res = await app.request("/webhook", {
      method: "POST",
      body: webhookBody("test"),
    }, createEnv());

    expect(res.status).toBe(401);
  });

  it("同一メッセージIDの重複送信を無視する", async () => {
    const body = webhookBody("メモ", "dup-001");
    const signature = await signBody(body, CHANNEL_SECRET);
    const opts = {
      method: "POST" as const,
      body,
      headers: { "x-line-signature": signature },
    };

    await app.request("/webhook", opts, createEnv());
    await app.request("/webhook", opts, createEnv());

    const { results } = await env.DB.prepare("SELECT * FROM messages").all();
    expect(results).toHaveLength(1);
  });

  it("非messageイベントは保存しない", async () => {
    const body = JSON.stringify({
      events: [{ type: "follow", source: { userId: "user-123", type: "user" } }],
    });
    const signature = await signBody(body, CHANNEL_SECRET);

    const res = await app.request("/webhook", {
      method: "POST",
      body,
      headers: { "x-line-signature": signature },
    }, createEnv());

    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT * FROM messages").all();
    expect(results).toHaveLength(0);
  });
});

describe("GET /messages（Bearer認証）", () => {
  it("認証なしで401を返す", async () => {
    const res = await app.request("/messages", {}, createEnv());
    expect(res.status).toBe(401);
  });

  it("不正なトークンで401を返す", async () => {
    const res = await app.request("/messages", {
      headers: { Authorization: "Bearer wrong-key" },
    }, createEnv());
    expect(res.status).toBe(401);
  });

  it("Bearer以外のスキームで401を返す", async () => {
    const res = await app.request("/messages", {
      headers: { Authorization: `Basic ${API_KEY}` },
    }, createEnv());
    expect(res.status).toBe(401);
  });

  it("未処理メッセージを取得する", async () => {
    // テストデータ挿入
    await env.DB.prepare(
      "INSERT INTO messages (line_message_id, user_id, message_type, content, raw_event) VALUES (?, ?, ?, ?, ?)",
    ).bind("m1", "u1", "text", "メモ1", "{}").run();
    await env.DB.prepare(
      "INSERT INTO messages (line_message_id, user_id, message_type, content, raw_event, processed) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("m2", "u1", "text", "メモ2", "{}", 1).run();

    const res = await app.request("/messages?processed=0", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe("メモ1");
  });

  it("processed=1で処理済みメッセージを取得する", async () => {
    await env.DB.prepare(
      "INSERT INTO messages (line_message_id, user_id, message_type, content, raw_event, processed) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("m1", "u1", "text", "処理済み", "{}", 1).run();

    const res = await app.request("/messages?processed=1", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    const data = await res.json() as any;
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe("処理済み");
  });

  it("limitパラメータが機能する", async () => {
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        "INSERT INTO messages (line_message_id, user_id, message_type, content, raw_event) VALUES (?, ?, ?, ?, ?)",
      ).bind(`m${i}`, "u1", "text", `メモ${i}`, "{}").run();
    }

    const res = await app.request("/messages?limit=2", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    const data = await res.json() as any;
    expect(data.messages).toHaveLength(2);
  });

  it("不正なlimitはデフォルト50にフォールバックする", async () => {
    const res = await app.request("/messages?limit=abc", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    expect(res.status).toBe(200);
  });
});

describe("POST /messages/:id/processed", () => {
  it("処理済みフラグを更新する", async () => {
    await env.DB.prepare(
      "INSERT INTO messages (line_message_id, user_id, message_type, content, raw_event) VALUES (?, ?, ?, ?, ?)",
    ).bind("m1", "u1", "text", "メモ", "{}").run();

    const inserted = await env.DB.prepare("SELECT id FROM messages WHERE line_message_id = 'm1'").first() as any;
    const id = inserted.id;

    const res = await app.request(`/messages/${id}/processed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await env.DB.prepare("SELECT processed FROM messages WHERE id = ?").bind(id).first() as any;
    expect(row.processed).toBe(1);
  });

  it("存在しないIDで404を返す", async () => {
    const res = await app.request("/messages/999/processed", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, createEnv());

    expect(res.status).toBe(404);
  });

  it("認証なしで401を返す", async () => {
    const res = await app.request("/messages/1/processed", {
      method: "POST",
    }, createEnv());

    expect(res.status).toBe(401);
  });
});
