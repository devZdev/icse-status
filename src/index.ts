import servicesConfig from "../config/services.json";
import {
  buildUnknownSnapshot,
  getHistory,
  getLatestSnapshot,
  jsonResponse,
  parseServicesConfig,
  runChecksAndPersist
} from "./status";
import type { Env } from "./types";

const serviceCatalog = parseServicesConfig(servicesConfig);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runChecksAndPersist(env.STATUS_KV, serviceCatalog, { trigger: "scheduled" }).catch((error) => {
        console.error("Scheduled status check failed", error);
      })
    );
  }
};

async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    if (url.pathname === "/api/status") {
      const snapshot = (await getLatestSnapshot(env.STATUS_KV)) ?? buildUnknownSnapshot(serviceCatalog);
      return jsonResponse(snapshot);
    }

    if (url.pathname === "/api/history") {
      return jsonResponse({ events: await getHistory(env.STATUS_KV) });
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        configuredServices: serviceCatalog.services.length,
        configIssues: serviceCatalog.issues,
        generatedAt: new Date().toISOString()
      });
    }

    return jsonResponse({ error: "API route not found" }, 404);
  } catch (error) {
    console.error("Status API failed", error);
    return jsonResponse({ error: "Status API failed" }, 500);
  }
}

