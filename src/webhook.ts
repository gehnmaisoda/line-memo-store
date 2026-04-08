import type { D1Database } from "@cloudflare/workers-types";

// タイミングセーフな文字列比較（タイミング攻撃を防ぐ）
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function verifySignature(
  body: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(expected, signature);
}

export interface LineMessageEvent {
  type: string;
  message?: {
    id: string;
    type: string;
    text?: string;
  };
  source?: {
    userId?: string;
    type: string;
  };
}

export interface LineWebhookBody {
  events: LineMessageEvent[];
}

export function parseWebhookEvents(body: string): LineMessageEvent[] {
  const parsed: LineWebhookBody = JSON.parse(body);
  return parsed.events;
}

export function extractMessageParams(event: LineMessageEvent) {
  if (event.type !== "message" || !event.message) return null;
  return {
    lineMessageId: event.message.id,
    userId: event.source?.userId ?? "unknown",
    messageType: event.message.type,
    content: event.message.text ?? null,
    rawEvent: JSON.stringify(event),
  };
}

export async function saveMessages(
  events: LineMessageEvent[],
  db: D1Database,
): Promise<void> {
  for (const event of events) {
    const params = extractMessageParams(event);
    if (!params) continue;

    await db
      .prepare(
        `INSERT OR IGNORE INTO messages (line_message_id, user_id, message_type, content, raw_event)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        params.lineMessageId,
        params.userId,
        params.messageType,
        params.content,
        params.rawEvent,
      )
      .run();
  }
}
