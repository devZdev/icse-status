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
import type { ServiceCatalog, ServiceCheckResult, ServiceDefinition, StatusEvent } from "./types";

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

  it("treats 503 and other non-probe 4xx responses as major outages", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      statusCode: 503,
      error: "HTTP 503"
    });
    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      statusCode: 404,
      error: "HTTP 404"
    });
    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      statusCode: 410,
      error: "HTTP 410"
    });
  });

  it("treats HTTP 429 and 403 as probe blocks instead of customer outages", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("challenge", { status: 429 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      statusCode: 429,
      error: "Probe blocked (HTTP 429)"
    });
    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      statusCode: 403,
      error: "Probe blocked (HTTP 403)"
    });
  });

  it("treats network failures as outages", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      statusCode: null,
      error: "connection refused"
    });
  });

  it("treats timeouts as major outages", async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

    await expect(checkService(service, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      statusCode: null,
      error: "Request timed out"
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
      severity: "major",
      error: "Status page indicator: major"
    });
  });

  it("maps Statuspage minor and maintenance to minor, and critical to major", async () => {
    const statusPage = { ...service, checkType: "statusPage" as const };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { indicator: "minor" },
        components: [{ status: "degraded_performance" }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { indicator: "maintenance" },
        components: [{ status: "under_maintenance" }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { indicator: "critical" },
        components: [{ status: "major_outage" }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: { indicator: "none" },
        components: [{ status: "degraded_performance" }]
      }), { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "minor",
      error: "Status page indicator: minor"
    });
    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "minor",
      error: "Status page indicator: maintenance"
    });
    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      error: "Status page indicator: critical"
    });
    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "minor"
    });
  });

  it("does not parse a blocked Statuspage or Incident.io response as a provider incident", async () => {
    const statusPage = { ...service, checkType: "statusPage" as const };
    const incidentPage = { ...service, id: "learnworlds", checkType: "incidentIoHtml" as const };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("blocked", { status: 429 }))
      .mockResolvedValueOnce(new Response("blocked", { status: 403 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      error: "Probe blocked (HTTP 429)"
    });
    await expect(checkService(incidentPage, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      error: "Probe blocked (HTTP 403)"
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

  it("checks Arlo's current HTML status without treating history as active", async () => {
    const statusPage = { ...service, checkType: "arloHtml" as const };
    const html = "All systems are operational All Good Past Incidents major outage";
    const fetcher = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({ status: "operational" });
  });

  it("treats Arlo HTTP 403 and 429 as probe blocks and does not parse the HTML", async () => {
    const statusPage = { ...service, checkType: "arloHtml" as const };
    const html = "Major outage all systems are operational Past Incidents";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(html, { status: 403 }))
      .mockResolvedValueOnce(new Response(html, { status: 429 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      statusCode: 403,
      error: "Probe blocked (HTTP 403)"
    });
    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      statusCode: 429,
      error: "Probe blocked (HTTP 429)"
    });
  });

  it("reports an Arlo HTML incident as a major customer outage", async () => {
    const statusPage = { ...service, checkType: "arloHtml" as const };
    const html = "Partial outage investigating Past Incidents all systems are operational";
    const fetcher = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));

    await expect(checkService(statusPage, fetcher)).resolves.toMatchObject({
      status: "outage",
      severity: "major",
      error: "Arlo status page reports an incident or has an unrecognized status"
    });
  });
});

describe("status snapshots", () => {
  it("aggregates service states", () => {
    expect(aggregateStatus([])).toBe("unknown");
    expect(aggregateStatus([result("a", "operational"), result("b", "operational")])).toBe("operational");
    expect(aggregateStatus([result("a", "outage", "major"), result("b", "outage", "major")])).toBe("outage");
    expect(aggregateStatus([result("a", "operational"), result("b", "outage", "major")])).toBe("degraded");
    expect(aggregateStatus([result("a", "unknown")])).toBe("unknown");
    expect(aggregateStatus([result("a", "degraded", "probe_blocked")])).toBe("degraded");
    expect(aggregateStatus([
      result("a", "operational"),
      result("b", "degraded", "probe_blocked")
    ])).toBe("degraded");
    expect(aggregateStatus([result("a", "outage", "minor"), result("b", "outage", "minor")])).toBe("degraded");
    expect(aggregateStatus([
      result("a", "outage", "minor"),
      result("b", "degraded", "probe_blocked")
    ])).toBe("degraded");
    expect(aggregateStatus([
      result("a", "outage", "major"),
      result("b", "degraded", "probe_blocked")
    ])).toBe("degraded");
  });

  it("builds summary counts", () => {
    expect(buildSummary([
      result("a", "operational"),
      result("b", "outage", "major"),
      result("c", "unknown"),
      result("d", "degraded", "probe_blocked")
    ])).toEqual({
      total: 4,
      operational: 1,
      degraded: 1,
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

    const degraded = {
      ...previous,
      generatedAt: "2026-06-18T00:10:00.000Z",
      overall: "degraded" as const,
      summary: buildSummary([result("site", "degraded", "probe_blocked")]),
      services: [result("site", "degraded", "probe_blocked")]
    };

    expect(deriveStatusEvents(previous, degraded)).toEqual([
      expect.objectContaining({
        serviceId: "site",
        from: "operational",
        to: "degraded"
      })
    ]);
    expect(deriveStatusEvents(degraded, previous)).toEqual([
      expect.objectContaining({
        serviceId: "site",
        from: "degraded",
        to: "operational"
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

describe("slack alerts", () => {
  const webhook = "https://hooks.slack.example/services/test";

  it("does not Slack on HTTP 429 or 403 probe blocks", async () => {
    const slackFetcher = slackOk();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("challenge", { status: 429 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const blocked = await persistWithSlack([httpService], fetcher, slackFetcher);
    expect(blocked.snapshot.services[0]).toMatchObject({
      status: "degraded",
      severity: "probe_blocked"
    });
    expect(blocked.snapshot.overall).toBe("degraded");
    expect(slackFetcher).not.toHaveBeenCalled();

    const forbidden = await persistWithSlack([httpService], fetcher, slackFetcher);
    expect(forbidden.snapshot.services[0]).toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      error: "Probe blocked (HTTP 403)"
    });
    expect(slackFetcher).not.toHaveBeenCalled();
  });

  it("does not Slack when Arlo HTML is probe blocked with HTTP 403", async () => {
    const slackFetcher = slackOk();
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "Major outage Past Incidents",
      { status: 403 }
    ));

    const { snapshot } = await persistWithSlack([arloService], fetcher, slackFetcher);

    expect(snapshot.services[0]).toMatchObject({
      status: "degraded",
      severity: "probe_blocked",
      error: "Probe blocked (HTTP 403)"
    });
    expect(snapshot.overall).toBe("degraded");
    expect(slackFetcher).not.toHaveBeenCalled();
  });

  it("Slacks Major when a service transitions to HTTP 503", async () => {
    const slackFetcher = slackOk();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await persistWithSlack([httpService], fetcher, slackFetcher);

    expect(slackFetcher).toHaveBeenCalledTimes(1);
    const text = slackText(slackFetcher);
    expect(text).toContain("• Major outage: Site — HTTP 503 (https://securityexcellence.net/)");
    expect(text).not.toContain("Minor");
    expect(text).not.toContain("Probe blocked");
  });

  it("Slacks Minor, not Major, for a Statuspage minor incident", async () => {
    const slackFetcher = slackOk();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: { indicator: "minor" },
      components: [{ status: "degraded_performance" }]
    }), { status: 200 }));

    const { snapshot } = await persistWithSlack([statusPageService], fetcher, slackFetcher);

    expect(snapshot.services[0]).toMatchObject({ status: "outage", severity: "minor" });
    expect(snapshot.overall).toBe("degraded");
    const text = slackText(slackFetcher);
    expect(text).toContain("• Minor outage: Shopify Platform — Status page indicator: minor");
    expect(text).not.toContain("Major");
  });

  it("does not repeat a Major Slack alert while the outage continues", async () => {
    const kv = new MemoryKv();
    const slackFetcher = slackOk();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const catalog: ServiceCatalog = { services: [httpService], issues: [] };

    await runChecksAndPersist(kv as unknown as KVNamespace, catalog, {
      fetcher,
      trigger: "scheduled",
      slackWebhookUrl: webhook,
      slackFetcher
    });
    await runChecksAndPersist(kv as unknown as KVNamespace, catalog, {
      fetcher,
      trigger: "scheduled",
      slackWebhookUrl: webhook,
      slackFetcher
    });

    expect(slackFetcher).toHaveBeenCalledTimes(1);
  });
});

const httpService: ServiceDefinition = {
  id: "site",
  name: "Site",
  group: "Web",
  url: "https://securityexcellence.net/"
};

const arloService: ServiceDefinition = {
  id: "arlo-status",
  name: "Arlo Platform",
  group: "Platform Dependencies",
  url: "https://status.arlo.com",
  checkType: "arloHtml"
};

const statusPageService: ServiceDefinition = {
  id: "shopify-status",
  name: "Shopify Platform",
  group: "Platform Dependencies",
  url: "https://www.shopifystatus.com",
  checkType: "statusPage"
};

function result(
  id: string,
  status: ServiceCheckResult["status"],
  severity?: ServiceCheckResult["severity"]
): ServiceCheckResult {
  return {
    id,
    name: id,
    group: "Web",
    url: `https://${id}.example.com`,
    status,
    ...(severity ? { severity } : {}),
    latencyMs: status === "unknown" ? null : 10,
    statusCode: status === "degraded" ? 429 : status === "outage" ? 503 : status === "unknown" ? null : 200,
    checkedAt: status === "unknown" ? null : "2026-06-18T00:00:00.000Z"
  };
}

function slackOk() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
}

function slackText(slackFetcher: ReturnType<typeof vi.fn>): string {
  expect(slackFetcher).toHaveBeenCalledTimes(1);
  const init = slackFetcher.mock.calls[0][1] as RequestInit;
  const body = JSON.parse(String(init.body)) as { text: string };
  return body.text;
}

async function persistWithSlack(
  services: ServiceDefinition[],
  fetcher: ReturnType<typeof vi.fn>,
  slackFetcher: ReturnType<typeof vi.fn>
) {
  const kv = new MemoryKv();
  const catalog: ServiceCatalog = { services, issues: [] };
  const snapshot = await runChecksAndPersist(kv as unknown as KVNamespace, catalog, {
    fetcher: fetcher as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    trigger: "scheduled",
    slackWebhookUrl: "https://hooks.slack.example/services/test",
    slackFetcher: slackFetcher as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  });
  return { snapshot, kv };
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
