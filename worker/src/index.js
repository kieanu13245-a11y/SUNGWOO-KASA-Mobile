import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGIN = "https://kieanu13245-a11y.github.io";
const MAX_AGE_MS = 10 * 60 * 1000;

function json(data, status = 200, origin = "") {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function corsPreflight(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type,X-KASA-Key",
    "access-control-max-age": "86400"
  });
  if (origin === ALLOWED_ORIGIN) headers.set("access-control-allow-origin", origin);
  return new Response(null, { status: 204, headers });
}

function normalizePlate(v) {
  return String(v || "").replace(/\s+/g, "").trim().slice(0, 20);
}

export class KasaRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" && request.method === "GET") {
      return json({ ok: true, service: "SUNGWOO KASA Relay", version: "1.0.0", now: new Date().toISOString() });
    }

    if (path === "/request" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) { return json({ ok: false, error: "JSON 형식이 올바르지 않습니다." }, 400); }
      const plate = normalizePlate(body.plate);
      if (!plate || plate.length < 4) return json({ ok: false, error: "차량번호를 확인하세요." }, 400);
      const requestId = crypto.randomUUID();
      const entry = {
        requestId,
        plate,
        createdAt: new Date().toISOString(),
        source: String(body.source || "mobile").slice(0, 40),
        status: "pending"
      };
      await this.ctx.storage.put("currentRequest", entry);
      return json({ ok: true, requestId, request: entry });
    }

    if (path === "/request" && request.method === "GET") {
      const entry = await this.ctx.storage.get("currentRequest");
      if (!entry || entry.status !== "pending") return json({ ok: true, pending: false });
      const created = Date.parse(entry.createdAt || "");
      if (Number.isFinite(created) && Date.now() - created > MAX_AGE_MS) {
        entry.status = "expired";
        await this.ctx.storage.put("currentRequest", entry);
        return json({ ok: true, pending: false, stale: true });
      }
      return json({ ok: true, pending: true, request: entry });
    }

    if (path === "/result" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) { return json({ ok: false, error: "JSON 형식이 올바르지 않습니다." }, 400); }
      const requestId = String(body.requestId || "").trim();
      if (!requestId) return json({ ok: false, error: "requestId가 없습니다." }, 400);
      const current = await this.ctx.storage.get("currentRequest");
      if (!current || current.requestId !== requestId) return json({ ok: false, error: "현재 요청과 일치하지 않습니다." }, 409);
      const result = {
        version: 1,
        requestId,
        plate: normalizePlate(body.plate || current.plate),
        status: body.status === "ok" ? "ok" : "error",
        completedAt: body.completedAt || new Date().toISOString(),
        error: String(body.error || "").slice(0, 1000),
        vehicle: body.vehicle && typeof body.vehicle === "object" ? body.vehicle : {},
        priceCandidates: Array.isArray(body.priceCandidates) ? body.priceCandidates.slice(0, 10) : []
      };
      await this.ctx.storage.put(`result:${requestId}`, result);
      current.status = "done";
      current.completedAt = result.completedAt;
      await this.ctx.storage.put("currentRequest", current);
      return json({ ok: true, requestId });
    }

    if (path === "/result" && request.method === "GET") {
      const requestId = String(url.searchParams.get("id") || "").trim();
      if (!requestId) return json({ ok: false, error: "id가 없습니다." }, 400);
      const result = await this.ctx.storage.get(`result:${requestId}`);
      if (result) return json({ ok: true, pending: false, result });
      const current = await this.ctx.storage.get("currentRequest");
      if (current?.requestId === requestId && current.status === "pending") return json({ ok: true, pending: true }, 202);
      return json({ ok: false, pending: false, error: "결과를 찾을 수 없습니다." }, 404);
    }

    if (path === "/reset" && request.method === "POST") {
      await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return corsPreflight(request);

    const supplied = request.headers.get("X-KASA-Key") || "";
    const expected = String(env.KASA_API_KEY || "");
    if (!expected) return json({ ok: false, error: "서버 연결 키가 설정되지 않았습니다." }, 500, origin);
    if (!supplied || supplied !== expected) return json({ ok: false, error: "연결 키가 올바르지 않습니다." }, 401, origin);

    const stub = env.KASA_RELAY.getByName("sungwoo-main");
    const response = await stub.fetch(request);
    const out = new Response(response.body, response);
    if (origin === ALLOWED_ORIGIN) {
      out.headers.set("access-control-allow-origin", origin);
      out.headers.set("vary", "Origin");
    }
    out.headers.set("cache-control", "no-store");
    return out;
  }
};