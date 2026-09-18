import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGIN = "https://kieanu13245-a11y.github.io";
const REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
const CLAIM_TTL_MS = 45 * 1000;
const DUPLICATE_WINDOW_MS = 3000;

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
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400"
  });
  if (origin === ALLOWED_ORIGIN) headers.set("access-control-allow-origin", origin);
  return new Response(null, { status: 204, headers });
}

function normalizePlate(v) {
  return String(v || "").replace(/\s+/g, "").trim().slice(0, 20);
}

function ageMs(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

export class KasaRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async getQueue() {
    const q = await this.ctx.storage.get("queue");
    return Array.isArray(q) ? q.filter(Boolean) : [];
  }

  async saveQueue(queue) {
    await this.ctx.storage.put("queue", [...new Set(queue.filter(Boolean))]);
  }

  async getEntry(id) {
    if (!id) return null;
    return (await this.ctx.storage.get(`request:${id}`)) || null;
  }

  async putEntry(entry) {
    await this.ctx.storage.put(`request:${entry.requestId}`, entry);
  }

  async activeEntry() {
    const activeId = String((await this.ctx.storage.get("activeRequestId")) || "");
    if (!activeId) return { activeId: "", entry: null };
    const entry = await this.getEntry(activeId);
    if (!entry || entry.status === "done" || entry.status === "error" || entry.status === "expired") {
      await this.ctx.storage.delete("activeRequestId");
      return { activeId: "", entry: null };
    }
    return { activeId, entry };
  }

  async cleanQueue(queue) {
    const out = [];
    for (const id of queue) {
      const entry = await this.getEntry(id);
      if (!entry || entry.status !== "pending") continue;
      if (ageMs(entry.createdAt) > REQUEST_MAX_AGE_MS) {
        entry.status = "expired";
        entry.expiredAt = new Date().toISOString();
        await this.putEntry(entry);
        continue;
      }
      out.push(id);
    }
    if (out.length !== queue.length) await this.saveQueue(out);
    return out;
  }

  async queueStateFor(requestId) {
    const { activeId, entry: active } = await this.activeEntry();
    if (activeId === requestId && active) {
      return { pending: true, stage: "processing", ahead: 0, position: 1 };
    }
    const queue = await this.cleanQueue(await this.getQueue());
    const idx = queue.indexOf(requestId);
    if (idx >= 0) {
      const ahead = idx + (active ? 1 : 0);
      return { pending: true, stage: "queued", ahead, position: ahead + 1 };
    }
    return { pending: false, stage: "unknown", ahead: 0, position: 0 };
  }

  async findRecentDuplicate(plate) {
    const { activeId, entry: active } = await this.activeEntry();
    if (active && active.plate === plate && ageMs(active.createdAt) <= DUPLICATE_WINDOW_MS) {
      return active;
    }
    const queue = await this.cleanQueue(await this.getQueue());
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = await this.getEntry(queue[i]);
      if (entry && entry.plate === plate && ageMs(entry.createdAt) <= DUPLICATE_WINDOW_MS) return entry;
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" && request.method === "GET") {
      const queue = await this.cleanQueue(await this.getQueue());
      const { entry: active } = await this.activeEntry();
      return json({
        ok: true,
        service: "SUNGWOO KASA Relay",
        version: "1.2.0",
        queueLength: queue.length,
        processing: !!active,
        now: new Date().toISOString()
      });
    }

    if (path === "/request" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); }
      catch (_) { return json({ ok: false, error: "JSON 형식이 올바르지 않습니다." }, 400); }

      const plate = normalizePlate(body.plate);
      if (!plate || plate.length < 4) return json({ ok: false, error: "차량번호를 확인하세요." }, 400);

      const duplicate = await this.findRecentDuplicate(plate);
      if (duplicate) {
        const state = await this.queueStateFor(duplicate.requestId);
        return json({
          ok: true,
          requestId: duplicate.requestId,
          duplicate: true,
          ...state,
          request: duplicate
        });
      }

      const requestId = crypto.randomUUID();
      const entry = {
        requestId,
        plate,
        createdAt: new Date().toISOString(),
        source: String(body.source || "mobile").slice(0, 40),
        status: "pending",
        attempts: 0
      };
      await this.putEntry(entry);

      const queue = await this.cleanQueue(await this.getQueue());
      queue.push(requestId);
      await this.saveQueue(queue);

      const state = await this.queueStateFor(requestId);
      return json({ ok: true, requestId, duplicate: false, ...state, request: entry });
    }

    if (path === "/request" && request.method === "GET") {
      const activeState = await this.activeEntry();
      if (activeState.entry) {
        const active = activeState.entry;
        const claimedAt = Date.parse(String(active.claimedAt || ""));
        const claimAge = Number.isFinite(claimedAt) ? Date.now() - claimedAt : Infinity;
        if (active.status === "processing" && claimAge < CLAIM_TTL_MS) {
          const queue = await this.cleanQueue(await this.getQueue());
          return json({ ok: true, pending: false, processing: true, queueLength: queue.length });
        }
        if (ageMs(active.createdAt) <= REQUEST_MAX_AGE_MS) {
          active.status = "processing";
          active.claimedAt = new Date().toISOString();
          active.attempts = Number(active.attempts || 0) + 1;
          await this.putEntry(active);
          const queue = await this.cleanQueue(await this.getQueue());
          return json({ ok: true, pending: true, processing: true, queueLength: queue.length, request: active });
        }
        active.status = "expired";
        active.expiredAt = new Date().toISOString();
        await this.putEntry(active);
        await this.ctx.storage.delete("activeRequestId");
      }

      let queue = await this.cleanQueue(await this.getQueue());
      while (queue.length) {
        const requestId = queue.shift();
        const entry = await this.getEntry(requestId);
        if (!entry || entry.status !== "pending") continue;
        entry.status = "processing";
        entry.claimedAt = new Date().toISOString();
        entry.attempts = Number(entry.attempts || 0) + 1;
        await this.putEntry(entry);
        await this.ctx.storage.put("activeRequestId", requestId);
        await this.saveQueue(queue);
        return json({ ok: true, pending: true, processing: true, queueLength: queue.length, request: entry });
      }
      await this.saveQueue([]);
      return json({ ok: true, pending: false, processing: false, queueLength: 0 });
    }

    if (path === "/release" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); }
      catch (_) { return json({ ok: false, error: "JSON 형식이 올바르지 않습니다." }, 400); }
      const requestId = String(body.requestId || "").trim();
      if (!requestId) return json({ ok: false, error: "requestId가 없습니다." }, 400);

      const { activeId, entry } = await this.activeEntry();
      if (activeId === requestId && entry) {
        entry.status = "pending";
        entry.claimedAt = "";
        entry.releasedAt = new Date().toISOString();
        await this.putEntry(entry);
        await this.ctx.storage.delete("activeRequestId");
        const queue = await this.cleanQueue(await this.getQueue());
        if (!queue.includes(requestId)) queue.unshift(requestId);
        await this.saveQueue(queue);
      }
      return json({ ok: true, requestId });
    }

    if (path === "/result" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); }
      catch (_) { return json({ ok: false, error: "JSON 형식이 올바르지 않습니다." }, 400); }

      const requestId = String(body.requestId || "").trim();
      if (!requestId) return json({ ok: false, error: "requestId가 없습니다." }, 400);
      const entry = await this.getEntry(requestId);
      if (!entry) return json({ ok: false, error: "요청을 찾을 수 없습니다." }, 404);

      const result = {
        version: 2,
        requestId,
        plate: normalizePlate(body.plate || entry.plate),
        status: body.status === "ok" ? "ok" : "error",
        completedAt: body.completedAt || new Date().toISOString(),
        error: String(body.error || "").slice(0, 1000),
        vehicle: body.vehicle && typeof body.vehicle === "object" ? body.vehicle : {},
        priceCandidates: Array.isArray(body.priceCandidates) ? body.priceCandidates.slice(0, 10) : []
      };
      await this.ctx.storage.put(`result:${requestId}`, result);

      entry.status = result.status === "ok" ? "done" : "error";
      entry.completedAt = result.completedAt;
      await this.putEntry(entry);

      const activeId = String((await this.ctx.storage.get("activeRequestId")) || "");
      if (activeId === requestId) await this.ctx.storage.delete("activeRequestId");

      return json({ ok: true, requestId });
    }

    if (path === "/result" && request.method === "GET") {
      const requestId = String(url.searchParams.get("id") || "").trim();
      if (!requestId) return json({ ok: false, error: "id가 없습니다." }, 400);

      const result = await this.ctx.storage.get(`result:${requestId}`);
      if (result) return json({ ok: true, pending: false, stage: "done", result });

      const entry = await this.getEntry(requestId);
      if (!entry) return json({ ok: false, pending: false, error: "결과를 찾을 수 없습니다." }, 404);
      if (entry.status === "expired") return json({ ok: false, pending: false, error: "요청 대기시간이 만료되었습니다." }, 410);

      const state = await this.queueStateFor(requestId);
      if (state.pending) return json({ ok: true, ...state }, 202);
      return json({ ok: false, pending: false, error: "요청 상태를 확인할 수 없습니다." }, 404);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return corsPreflight(request);

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