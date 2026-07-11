import type {
  CheckTrigger,
  ConfigIssue,
  LastRunMetadata,
  OverallState,
  ServiceCatalog,
  ServiceCheckResult,
  ServiceDefinition,
  ServiceState,
  StatusEvent,
  StatusSnapshot,
  StatusSummary
} from "./types";

export const LATEST_STATUS_KEY = "status:latest";
export const HISTORY_KEY = "status:history";
export const LAST_RUN_KEY = "status:last-run";
export const DEFAULT_GROUP = "ICSE Services";
export const DEFAULT_TIMEOUT_MS = 8000;
export const MAX_HISTORY_EVENTS = 100;
export const STALE_AFTER_MS = 10 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 6;
export const CHECK_REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "user-agent": "ICSE-Status/0.1 (+https://status.securityexcellence.net)"
};

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface RunChecksOptions {
  fetcher?: FetchFunction;
  trigger: CheckTrigger;
  concurrency?: number;
  slackWebhookUrl?: string;
  slackFetcher?: FetchFunction;
}

const serviceIdPattern = /^[a-z0-9][a-z0-9-]*$/;

export function parseServicesConfig(config: unknown): ServiceCatalog {
  const root = asRecord(config);
  const issues: ConfigIssue[] = [];

  if (!root || !Array.isArray(root.services)) {
    return {
      services: [],
      issues: [{ message: "config/services.json must contain a services array." }]
    };
  }

  const seenIds = new Set<string>();
  const services: ServiceDefinition[] = [];

  root.services.forEach((rawService, index) => {
    const service = asRecord(rawService);
    if (!service) {
      issues.push({ index, message: "Service entry must be an object." });
      return;
    }

    const id = readTrimmedString(service.id);
    const name = readTrimmedString(service.name);
    const url = readTrimmedString(service.url);
    const group = readTrimmedString(service.group) || DEFAULT_GROUP;
    const description = readTrimmedString(service.description);
    const timeoutMs = readOptionalInteger(service.timeoutMs);
    const checkType = service.checkType === undefined ? "http" : readTrimmedString(service.checkType);
    const serviceIssues: ConfigIssue[] = [];

    if (!id || !serviceIdPattern.test(id)) {
      serviceIssues.push({
        index,
        id: id || undefined,
        message: "Service id must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens."
      });
    }

    if (id && seenIds.has(id)) {
      serviceIssues.push({ index, id, message: "Service id must be unique." });
    }

    if (!name) {
      serviceIssues.push({ index, id: id || undefined, message: "Service name is required." });
    }

    if (!isHttpUrl(url)) {
      serviceIssues.push({ index, id: id || undefined, message: "Service url must be a valid http or https URL." });
    }

    if (timeoutMs !== undefined && (timeoutMs < 1000 || timeoutMs > 30000)) {
      serviceIssues.push({ index, id: id || undefined, message: "timeoutMs must be between 1000 and 30000." });
    }

    if (checkType !== "http" && checkType !== "statusPage" && checkType !== "incidentIoHtml" && checkType !== "arloHtml") {
      serviceIssues.push({ index, id: id || undefined, message: "checkType must be http, statusPage, incidentIoHtml, or arloHtml." });
    }

    if (serviceIssues.length > 0) {
      issues.push(...serviceIssues);
      return;
    }

    seenIds.add(id);
    services.push({
      id,
      name,
      group,
      url,
      ...(description ? { description } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(checkType !== "http" ? { checkType: checkType as "statusPage" | "incidentIoHtml" | "arloHtml" } : {})
    });
  });

  return { services, issues };
}

export async function checkService(
  service: ServiceDefinition,
  fetcher: FetchFunction = fetch
): Promise<ServiceCheckResult> {
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const response = await fetcher(requestUrl(service), {
      method: "GET",
      headers: CHECK_REQUEST_HEADERS,
      redirect: "follow",
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (service.checkType === "incidentIoHtml") {
      return await checkIncidentIoHtml(service, response, latencyMs, checkedAt);
    }

    if (service.checkType === "arloHtml") {
      return await checkArloHtml(service, response, latencyMs, checkedAt);
    }

    if (service.checkType === "statusPage") {
      return await checkStatusPage(service, response, latencyMs, checkedAt);
    }

    const isHealthy = response.status >= 200 && response.status < 400;

    return {
      ...service,
      status: isHealthy ? "operational" : "outage",
      latencyMs,
      statusCode: response.status,
      checkedAt,
      ...(isHealthy ? {} : { error: `HTTP ${response.status}` })
    };
  } catch (error) {
    return {
      ...service,
      status: "outage",
      latencyMs: Date.now() - startedAt,
      statusCode: null,
      checkedAt,
      error: describeFetchError(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkArloHtml(
  service: ServiceDefinition,
  response: Response,
  latencyMs: number,
  checkedAt: string
): Promise<ServiceCheckResult> {
  if (response.status < 200 || response.status >= 400) {
    return { ...service, status: "outage", latencyMs, statusCode: response.status, checkedAt, error: `HTTP ${response.status}` };
  }

  const html = (await response.text()).toLowerCase();
  const currentStatus = html.split("past incidents", 1)[0];
  const isHealthy = currentStatus.includes("all systems are operational") &&
    !/(partial outage|major outage|degraded|investigating|service disruption)/.test(currentStatus);

  return {
    ...service,
    status: isHealthy ? "operational" : "outage",
    latencyMs,
    statusCode: response.status,
    checkedAt,
    ...(isHealthy ? {} : { error: "Arlo status page reports an incident or has an unrecognized status" })
  };
}

async function checkIncidentIoHtml(
  service: ServiceDefinition,
  response: Response,
  latencyMs: number,
  checkedAt: string
): Promise<ServiceCheckResult> {
  if (response.status < 200 || response.status >= 400) {
    return { ...service, status: "outage", latencyMs, statusCode: response.status, checkedAt, error: `HTTP ${response.status}` };
  }

  const html = await response.text();
  const payload = extractNextPayload(html);
  const affected = extractJsonArray(payload, "affected_components");
  const incidents = extractJsonArray(payload, "ongoing_incidents");
  const maintenances = extractJsonArray(payload, "scheduled_maintenances");

  if (!affected || !incidents || !maintenances) {
    return { ...service, status: "outage", latencyMs, statusCode: response.status, checkedAt, error: "Invalid Incident.io status response" };
  }

  const isHealthy = affected.length === 0 && incidents.length === 0 && maintenances.length === 0;
  return {
    ...service,
    status: isHealthy ? "operational" : "outage",
    latencyMs,
    statusCode: response.status,
    checkedAt,
    ...(isHealthy ? {} : { error: "Active Incident.io incident or maintenance" })
  };
}

async function checkStatusPage(
  service: ServiceDefinition,
  response: Response,
  latencyMs: number,
  checkedAt: string
): Promise<ServiceCheckResult> {
  if (response.status < 200 || response.status >= 400) {
    return { ...service, status: "outage", latencyMs, statusCode: response.status, checkedAt, error: `HTTP ${response.status}` };
  }

  try {
    const summary = await response.json() as {
      status?: { indicator?: string };
      components?: Array<{ status?: string }>;
    };
    const components = summary.components ?? [];
    const isHealthy = summary.status?.indicator === "none" &&
      components.every((component) => component.status === "operational");

    return {
      ...service,
      status: isHealthy ? "operational" : "outage",
      ...(isHealthy ? {} : { severity: summary.status?.indicator === "minor" ? "minor" as const : "major" as const }),
      latencyMs,
      statusCode: response.status,
      checkedAt,
      ...(isHealthy ? {} : { error: `Status page indicator: ${summary.status?.indicator ?? "unknown"}` })
    };
  } catch {
    return { ...service, status: "outage", latencyMs, statusCode: response.status, checkedAt, error: "Invalid status page response" };
  }
}

function extractNextPayload(html: string): string {
  const payloads: string[] = [];
  const pattern = /self\.\__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    try {
      payloads.push(JSON.parse(match[1]) as string);
    } catch {
      // Ignore malformed payload fragments and let field validation fail.
    }
  }

  return payloads.join("\n");
}

function requestUrl(service: ServiceDefinition): string {
  if (service.checkType !== "statusPage") {
    return service.url;
  }

  return `${service.url.replace(/\/$/, "")}/api/v2/summary.json`;
}

function extractJsonArray(payload: string, field: string): unknown[] | null {
  const start = payload.indexOf(`"${field}"`);
  if (start < 0) return null;
  const arrayStart = payload.indexOf("[", start);
  if (arrayStart < 0) return null;
  const arrayEnd = payload.indexOf("]", arrayStart);
  if (arrayEnd < 0) return null;

  try {
    const value = JSON.parse(payload.slice(arrayStart, arrayEnd + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function runChecks(
  catalog: ServiceCatalog,
  options: RunChecksOptions
): Promise<StatusSnapshot> {
  const startedAt = Date.now();
  const results = await mapWithConcurrency(
    catalog.services,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    (service) => checkService(service, options.fetcher)
  );
  const finishedAt = new Date();
  const summary = buildSummary(results);
  const lastRun: LastRunMetadata = {
    checkedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startedAt,
    trigger: options.trigger,
    total: summary.total,
    operational: summary.operational,
    outage: summary.outage
  };

  return {
    generatedAt: finishedAt.toISOString(),
    overall: aggregateStatus(results),
    stale: false,
    summary,
    services: results,
    historyLimit: MAX_HISTORY_EVENTS,
    configIssues: catalog.issues,
    lastRun
  };
}

export async function runChecksAndPersist(
  kv: KVNamespace,
  catalog: ServiceCatalog,
  options: RunChecksOptions
): Promise<StatusSnapshot> {
  const previousSnapshot = await readJson<StatusSnapshot>(kv, LATEST_STATUS_KEY);
  const snapshot = await runChecks(catalog, options);
  const previousHistory = await getHistory(kv);
  const events = deriveStatusEvents(previousSnapshot, snapshot);
  const nextHistory = trimHistory([...events, ...previousHistory]);

  await Promise.all([
    writeJson(kv, LATEST_STATUS_KEY, snapshot),
    writeJson(kv, HISTORY_KEY, nextHistory),
    writeJson(kv, LAST_RUN_KEY, snapshot.lastRun)
  ]);

  await notifySlackOfOutages(previousSnapshot, snapshot, options);

  return snapshot;
}

async function notifySlackOfOutages(
  previousSnapshot: StatusSnapshot | null,
  snapshot: StatusSnapshot,
  options: RunChecksOptions
): Promise<void> {
  if (!options.slackWebhookUrl) {
    return;
  }

  const previousById = new Map(
    previousSnapshot?.services.map((service) => [service.id, service.status] as const) ?? []
  );
  const outages = snapshot.services.filter((service) =>
    service.status === "outage" && previousById.get(service.id) !== "outage"
  );

  if (outages.length === 0) {
    return;
  }

  const lines = outages.map((service) => {
    const severity = service.severity === "minor" ? "Minor" : "Major";
    return `• ${severity} outage: ${service.name} — ${service.error ?? "failed health check"} (${service.url})`;
  });
  const response = await (options.slackFetcher ?? fetch)(options.slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `ICSE Status alert at ${snapshot.generatedAt}\n${lines.join("\n")}`
    })
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}`);
  }
}

export async function getLatestSnapshot(kv: KVNamespace): Promise<StatusSnapshot | null> {
  const snapshot = await readJson<StatusSnapshot>(kv, LATEST_STATUS_KEY);
  return snapshot ? withFreshStaleFlag(snapshot) : null;
}

export async function getHistory(kv: KVNamespace): Promise<StatusEvent[]> {
  return (await readJson<StatusEvent[]>(kv, HISTORY_KEY)) ?? [];
}

export function buildUnknownSnapshot(catalog: ServiceCatalog, now = new Date()): StatusSnapshot {
  const services: ServiceCheckResult[] = catalog.services.map((service) => ({
    ...service,
    status: "unknown",
    latencyMs: null,
    statusCode: null,
    checkedAt: null
  }));

  return {
    generatedAt: now.toISOString(),
    overall: "unknown",
    stale: services.length > 0,
    summary: buildSummary(services),
    services,
    historyLimit: MAX_HISTORY_EVENTS,
    configIssues: catalog.issues,
    lastRun: null
  };
}

export function withFreshStaleFlag(snapshot: StatusSnapshot, now = new Date()): StatusSnapshot {
  return {
    ...snapshot,
    stale: isSnapshotStale(snapshot, now)
  };
}

export function isSnapshotStale(snapshot: StatusSnapshot, now = new Date()): boolean {
  if (snapshot.services.length === 0) {
    return false;
  }

  const lastCheckedAt = snapshot.lastRun?.checkedAt ?? snapshot.generatedAt;
  const lastCheckedMs = Date.parse(lastCheckedAt);

  if (Number.isNaN(lastCheckedMs)) {
    return true;
  }

  return now.getTime() - lastCheckedMs > STALE_AFTER_MS;
}

export function aggregateStatus(results: ServiceCheckResult[]): OverallState {
  if (results.length === 0) {
    return "unknown";
  }

  const outageCount = results.filter((result) => result.status === "outage").length;
  const unknownCount = results.filter((result) => result.status === "unknown").length;

  if (unknownCount === results.length) {
    return "unknown";
  }

  if (outageCount === 0 && unknownCount === 0) {
    return "operational";
  }

  if (outageCount === results.length) {
    return "outage";
  }

  return "degraded";
}

export function buildSummary(results: ServiceCheckResult[]): StatusSummary {
  return {
    total: results.length,
    operational: results.filter((result) => result.status === "operational").length,
    outage: results.filter((result) => result.status === "outage").length,
    unknown: results.filter((result) => result.status === "unknown").length
  };
}

export function deriveStatusEvents(
  previousSnapshot: StatusSnapshot | null,
  nextSnapshot: StatusSnapshot
): StatusEvent[] {
  const previousById = new Map(
    previousSnapshot?.services.map((service) => [service.id, service.status] as const) ?? []
  );

  return nextSnapshot.services.flatMap((service) => {
    const previousStatus = previousById.get(service.id) ?? "unknown";
    if (previousStatus === service.status) {
      return [];
    }

    return [
      {
        id: `${Date.parse(nextSnapshot.generatedAt)}-${service.id}-${service.status}`,
        at: nextSnapshot.generatedAt,
        serviceId: service.id,
        serviceName: service.name,
        from: previousStatus,
        to: service.status,
        message: `${service.name} changed from ${previousStatus} to ${service.status}.`
      }
    ];
  });
}

export function trimHistory(events: StatusEvent[], limit = MAX_HISTORY_EVENTS): StatusEvent[] {
  return events.slice(0, limit);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const value = await kv.get(key, "text");
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function writeJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => runNext()
  );
  await Promise.all(workers);
  return results;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function describeFetchError(error: unknown): string {
  if (error === "timeout") {
    return "Request timed out";
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "Request timed out";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Request failed";
}
