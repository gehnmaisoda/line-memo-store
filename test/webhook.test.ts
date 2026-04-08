import { describe, it, expect } from "vitest";
import {
  verifySignature,
  parseWebhookEvents,
  extractMessageParams,
  type LineMessageEvent,
} from "../src/webhook";

describe("verifySignature", () => {
  const channelSecret = "test-secret";

  async function sign(body: string, secret: string): Promise<string> {
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

  it("正しい署名で true を返す", async () => {
    const body = '{"events":[]}';
    const signature = await sign(body, channelSecret);
    expect(await verifySignature(body, signature, channelSecret)).toBe(true);
  });

  it("不正な署名で false を返す", async () => {
    const body = '{"events":[]}';
    expect(await verifySignature(body, "invalid-sig", channelSecret)).toBe(false);
  });

  it("異なるシークレットで false を返す", async () => {
    const body = '{"events":[]}';
    const signature = await sign(body, "wrong-secret");
    expect(await verifySignature(body, signature, channelSecret)).toBe(false);
  });

  it("空のボディでも正しく検証できる", async () => {
    const body = "";
    const signature = await sign(body, channelSecret);
    expect(await verifySignature(body, signature, channelSecret)).toBe(true);
  });
});

describe("parseWebhookEvents", () => {
  it("eventsを正しくパースする", () => {
    const body = JSON.stringify({
      events: [
        { type: "message", message: { id: "1", type: "text", text: "hello" } },
      ],
    });
    const events = parseWebhookEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("message");
  });

  it("空のeventsを返す", () => {
    const body = JSON.stringify({ events: [] });
    expect(parseWebhookEvents(body)).toHaveLength(0);
  });

  it("不正なJSONでエラーをスローする", () => {
    expect(() => parseWebhookEvents("invalid")).toThrow();
  });
});

describe("extractMessageParams", () => {
  it("テキストメッセージからパラメータを抽出する", () => {
    const event: LineMessageEvent = {
      type: "message",
      message: { id: "msg-123", type: "text", text: "買い物リスト" },
      source: { userId: "user-abc", type: "user" },
    };
    const params = extractMessageParams(event);
    expect(params).toEqual({
      lineMessageId: "msg-123",
      userId: "user-abc",
      messageType: "text",
      content: "買い物リスト",
      rawEvent: JSON.stringify(event),
    });
  });

  it("テキストなしメッセージ（画像等）でcontentがnullになる", () => {
    const event: LineMessageEvent = {
      type: "message",
      message: { id: "msg-456", type: "image" },
      source: { userId: "user-abc", type: "user" },
    };
    const params = extractMessageParams(event);
    expect(params).not.toBeNull();
    expect(params!.content).toBeNull();
    expect(params!.messageType).toBe("image");
  });

  it("sourceがない場合userIdがunknownになる", () => {
    const event: LineMessageEvent = {
      type: "message",
      message: { id: "msg-789", type: "text", text: "test" },
    };
    const params = extractMessageParams(event);
    expect(params!.userId).toBe("unknown");
  });

  it("messageイベント以外はnullを返す", () => {
    const event: LineMessageEvent = { type: "follow" };
    expect(extractMessageParams(event)).toBeNull();
  });

  it("messageフィールドがないイベントはnullを返す", () => {
    const event: LineMessageEvent = { type: "message" };
    expect(extractMessageParams(event)).toBeNull();
  });
});
