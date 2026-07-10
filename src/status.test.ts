import { describe, expect, it, vi } from "vitest";
import {
  aggregateStatus,
  buildSummary,
  buildUnknownSnapshot,
  CHECK_REQUEST_HEADERS,
  checkService,
  deriveStatusEvents,
  parseServicesConfig,
  runChecksAndPersist,
  trimHistory
} from "./status";
import type { ServiceCatalog, ServiceCheckResult, StatusEvent } from "./types";

describe("parseServicesConfig", () => {
  it("accepts valid HTTP service definitions", () => {
    const catalog = parseServicesConfig({
      services: [
        {
          id: "main-site",
          name: "Main Site",
          group: "Web",
          url: "https://example.com",
          timeoutMs: 5000
        }
      ]
    });

    expect(catalog.issues).toEqual([]);
    expect(catalog.services).toHaveLength(1);
    expect(catalog.services[0]).toMatchObject({
      id: "main-site",
      name: "Main Site",
      group: "Web",
      url: "https://example.com"
    });
  });

  it("reports malformed service definitions without throwing", () => {
    const catalog = parseServicesConfig({
      services: [
        {
          id: "Bad Id",
          name: "",
          url: "ftp://example.com"
        }
      ]
    });

    expect(catalog.services).toEqual([]);
    expect(catalog.issues.length).toBeGreaterThan(0);
  });
});

describe("checkService", () => {
  const service = {
    id: "site",
    name: "Site",
    group: "Web",
    url: "https://example.com"
  };

  it("treats 2xx and 3xx responses as operational", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 302 }));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "operational",
      statusCode: 204
    });
    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "operational",
      statusCode: 302
    });
    expect(fetcher).toHaveBeenCalledWith(
      service.url,
      expect.objectContaining({
        headers: CHECK_REQUEST_HEADERS,
        method: "GET",
        redirect: "follow"
      })
    );
  });

  it("treats 4xx and 5xx responses as outages", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      statusCode: 503,
      error: "HTTP 503"
    });
  });

  it("treats network failures as outages", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      statusCode: null,
      error: "connection refused"
    });
  });

  it("checks Statuspage API health instead of only the landing page", async () => {
    const statusPage = { ...service, checkType: "statusPage" as const };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: { indicator: "none" },
      components: [{ status: "operational" }]
    }), { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({ status: "operational" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/api/v2/summary.json",
      expect.anything()
    );
  });

  it("reports a provider incident from Statuspage data", async () => {
    const statusPage = { ...service, checkType: "statusPage" as const };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: { indicator: "major" },
      components: [{ status: "major_outage" }]
    }), { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      error: "Status page indicator: major"
    });
  });

  it("reads Incident.io status data embedded in Next.js HTML", async () => {
    const statusPage = { ...service, checkType: "incidentIoHtml" as const };
    const html = `<script>self.__next_f.push([1,"4:{\\"summary\\":{\\"affected_components\\":[],\\"ongoing_incidents\\":[],\\"scheduled_maintenances\\":[]}}"])</script>`;
    const fetcher = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({ status: "operational" });
  });

  it("reports active Incident.io incidents", async () => {
    const statusPage = { ...service, checkType: "incidentIoHtml" as const };
    const html = `<script>self.__next_f.push([1,"4:{\\"summary\\":{\\"affected_components\\":[{\\"id\\":\\"component\\"}],\\"ongoing_incidents\\":[],\\"scheduled_maintenances\\":[]}}"])</script>`;
    const fetcher = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({ status: "outage" });
  });
});

describe("status snapshots", () => {
  it("aggregates service states", () => {
    expect(aggregateStatus([])).toBe("unknown");
    expect(aggregateStatus([result("a", "operational"), result("b", "operational")])).toBe("operational");
    expect(aggregateStatus([result("a", "outage"), result("b", "outage")])).toBe("outage");
    expect(aggregateStatus([result("a", "operational"), result("b", "outage")])).toBe("degraded");
    expect(aggregateStatus([result("a", "unknown")])).toBe("unknown");
  });

  it("builds summary counts", () => {
    expect(buildSummary([result("a", "operational"), result("b", "outage"), result("c", "unknown")])).toEqual({
      total: 3,
      operational: 1,
      outage: 1,
      unknown: 1
    });
  });

  it("creates an unknown snapshot before the first scheduled run", () => {
    const catalog: ServiceCatalog = {
      services: [
        {
          id: "site",
          name: "Site",
          group: "Web",
          url: "https://example.com"
        }
      ],
      issues: []
    };

    const snapshot = buildUnknownSnapshot(catalog, new Date("2026-06-18T00:00:00.000Z"));

    expect(snapshot.overall).toBe("unknown");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.services[0]).toMatchObject({
      id: "site",
      status: "unknown",
      checkedAt: null
    });
  });

  it("derives history events only when service status changes", () => {
    const previous = {
      generatedAt: "2026-06-18T00:00:00.000Z",
      overall: "operational" as const,
      stale: false,
      summary: buildSummary([result("site", "operational")]),
      services: [result("site", "operational")],
      historyLimit: 100,
      configIssues: [],
      lastRun: null
    };
    const next = {
      ...previous,
      generatedAt: "2026-06-18T00:05:00.000Z",
      overall: "outage" as const,
      summary: buildSummary([result("site", "outage")]),
      services: [result("site", "outage")]
    };

    expect(deriveStatusEvents(previous, next)).toEqual([
      expect.objectContaining({
        serviceId: "site",
        from: "operational",
        to: "outage"
      })
    ]);
  });

  it("trims history to the configured limit", () => {
    const events: StatusEvent[] = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      at: "2026-06-18T00:00:00.000Z",
      serviceId: "site",
      serviceName: "Site",
      from: "operational",
      to: "outage",
      message: "changed"
    }));

    expect(trimHistory(events, 3).map((event) => event.id)).toEqual(["0", "1", "2"]);
  });
});

describe("runChecksAndPersist", () => {
  it("stores latest status and status history in KV", async () => {
    const kv = new MemoryKv();
    const catalog: ServiceCatalog = {
      services: [
        {
          id: "site",
          name: "Site",
          group: "Web",
          url: "https://example.com"
        }
      ],
      issues: []
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const snapshot = await runChecksAndPersist(kv as unknown as KVNamespace, catalog, {
      fetcher,
      trigger: "scheduled"
    });

    expect(snapshot.overall).toBe("operational");
    expect(JSON.parse(await kv.get("status:latest", "text") ?? "{}")).toMatchObject({
      overall: "operational"
    });
    expect(JSON.parse(await kv.get("status:history", "text") ?? "[]")).toHaveLength(1);
  });
});

function result(id: string, status: ServiceCheckResult["status"]): ServiceCheckResult {
  return {
    id,
    name: id,
    group: "Web",
    url: `https://${id}.example.com`,
    status,
    latencyMs: status === "unknown" ? null : 10,
    statusCode: status === "unknown" ? null : 200,
    checkedAt: status === "unknown" ? null : "2026-06-18T00:00:00.000Z"
  };
}

class MemoryKv {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "text"): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    if (type === "text" || type === undefined) {
      return value;
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}
