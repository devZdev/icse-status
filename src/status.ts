import type {
  CheckTrigger,
  ConfigIssue,
  LastRunMetadata,
  OverallState,
  ServiceCatalog,
  ServiceCheckResult,
  ServiceDefinition,
  ServiceSeverity,
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
/**
 * Major Slack for the ICSE site, and for a Shopify incident that is actually
 * affecting that site, is sent only after this many consecutive scheduled
 * failures. The cron is every 15 minutes, so the tries are already spaced
 * apart. The count lives on each service in the status:latest snapshot.
 * In-run retries are not used: a blip that lasts a few minutes would still
 * fail several quick retries inside one invocation.
 */
export const MAJOR_ALERT_STREAK = 3;
export const SHOPIFY_STATUS_SERVICE_ID = "shopify-status";
export const CHECK_FAILED_ERROR = "Check failed";
const ICSE_SITE_HOST = "securityexcellence.net";
const SHOPIFY_STATUS_HOSTS = new Set(["shopifystatus.com", "www.shopifystatus.com"]);

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
    if (!isHttpSuccess(response.status)) {
      return httpFailureResult(service, response.status, latencyMs, checkedAt);
    }

    if (service.checkType === "incidentIoHtml") {
      return await checkIncidentIoHtml(service, response, latencyMs, checkedAt);
    }

    if (service.checkType === "arloHtml") {
      return await checkArloHtml(service, response, latencyMs, checkedAt);
    }

    if (service.checkType === "statusPage") {
      return await checkStatusPage(service, response, latencyMs, checkedAt);
    }

    return {
      ...service,
      status: "operational",
      latencyMs,
      statusCode: response.status,
      checkedAt
    };
  } catch (error) {
    if (isShopifyStatusService(service)) {
      return checkFailedResult(service, null, Date.now() - startedAt, checkedAt);
    }

    return {
      ...service,
      status: "outage",
      severity: "major",
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
  if (!isHttpSuccess(response.status)) {
    return httpFailureResult(service, response.status, latencyMs, checkedAt);
  }

  const html = (await response.text()).toLowerCase();
  const currentStatus = html.split("past incidents", 1)[0];
  const isHealthy = currentStatus.includes("all systems are operational") &&
    !/(partial outage|major outage|degraded|investigating|service disruption)/.test(currentStatus);

  return {
    ...service,
    status: isHealthy ? "operational" : "outage",
    ...(isHealthy ? {} : { severity: "major" as const }),
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
  if (!isHttpSuccess(response.status)) {
    return httpFailureResult(service, response.status, latencyMs, checkedAt);
  }

  const html = await response.text();
  const payload = extractNextPayload(html);
  const affected = extractJsonArray(payload, "affected_components");
  const incidents = extractJsonArray(payload, "ongoing_incidents");
  const maintenances = extractJsonArray(payload, "scheduled_maintenances");

  if (!affected || !incidents || !maintenances) {
    return {
      ...service,
      status: "outage",
      severity: "major",
      latencyMs,
      statusCode: response.status,
      checkedAt,
      error: "Invalid Incident.io status response"
    };
  }

  const isHealthy = affected.length === 0 && incidents.length === 0 && maintenances.length === 0;
  return {
    ...service,
    status: isHealthy ? "operational" : "outage",
    ...(isHealthy ? {} : { severity: "major" as const }),
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
  if (!isHttpSuccess(response.status)) {
    return httpFailureResult(service, response.status, latencyMs, checkedAt);
  }

  try {
    const summary = await response.json() as {
      status?: { indicator?: string };
      components?: Array<{ status?: string }>;
    };
    const components = summary.components ?? [];
    const indicator = summary.status?.indicator;
    const isHealthy = indicator === "none" &&
      components.every((component) => component.status === "operational");

    return {
      ...service,
      status: isHealthy ? "operational" : "outage",
      ...(isHealthy ? {} : { severity: providerIncidentSeverity(indicator, components) }),
      latencyMs,
      statusCode: response.status,
      checkedAt,
      ...(isHealthy ? {} : { error: `Status page indicator: ${indicator ?? "unknown"}` })
    };
  } catch {
    if (isShopifyStatusService(service)) {
      return checkFailedResult(service, response.status, latencyMs, checkedAt);
    }

    return {
      ...service,
      status: "outage",
      severity: "major",
      latencyMs,
      statusCode: response.status,
      checkedAt,
      error: "Invalid status page response"
    };
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
  const checked = await mapWithConcurrency(
    catalog.services,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    (service) => checkService(service, options.fetcher)
  );
  const results = applyShopifyIncidentPolicy(checked);
  const finishedAt = new Date();
  const summary = buildSummary(results);
  const lastRun: LastRunMetadata = {
    checkedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startedAt,
    trigger: options.trigger,
    total: summary.total,
    operational: summary.operational,
    degraded: summary.degraded,
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
  const checked = await runChecks(catalog, options);
  const snapshot: StatusSnapshot = {
    ...checked,
    services: applyMajorAlertStreaks(checked.services, previousSnapshot)
  };
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
    previousSnapshot?.services.map((service) => [service.id, service] as const) ?? []
  );
  const lines = snapshot.services.flatMap((service) => {
    const label = slackImpactLabel(service);
    if (!label) {
      return [];
    }

    const previous = previousById.get(service.id);
    if (!shouldPostSlack(service, previous, label)) {
      return [];
    }

    return [`• ${label} outage: ${service.name} — ${service.error ?? "failed health check"} (${service.url})`];
  });

  if (lines.length === 0) {
    return;
  }
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

  const unknownCount = results.filter((result) => result.status === "unknown").length;
  if (unknownCount === results.length) {
    return "unknown";
  }

  const majorCount = results.filter((result) => isMajorCustomerOutage(result)).length;
  if (majorCount === results.length) {
    return "outage";
  }

  const operationalCount = results.filter((result) => result.status === "operational").length;
  if (operationalCount === results.length) {
    return "operational";
  }

  return "degraded";
}

export function buildSummary(results: ServiceCheckResult[]): StatusSummary {
  return {
    total: results.length,
    operational: results.filter((result) => result.status === "operational").length,
    degraded: results.filter((result) => result.status === "degraded").length,
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

function isHttpSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

function isProbeBlockedStatus(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429;
}

function httpFailureResult(
  service: ServiceDefinition,
  statusCode: number,
  latencyMs: number,
  checkedAt: string
): ServiceCheckResult {
  if (isProbeBlockedStatus(statusCode)) {
    return {
      ...service,
      status: "degraded",
      severity: "probe_blocked",
      latencyMs,
      statusCode,
      checkedAt,
      error: `Probe blocked (HTTP ${statusCode})`
    };
  }

  if (isShopifyStatusService(service)) {
    return checkFailedResult(service, statusCode, latencyMs, checkedAt);
  }

  return {
    ...service,
    status: "outage",
    severity: "major",
    latencyMs,
    statusCode,
    checkedAt,
    error: `HTTP ${statusCode}`
  };
}

function providerIncidentSeverity(
  indicator: string | undefined,
  components: Array<{ status?: string }>
): Extract<ServiceSeverity, "minor" | "major"> {
  if (indicator === "minor" || indicator === "maintenance") {
    return "minor";
  }

  if (indicator === "major" || indicator === "critical") {
    return "major";
  }

  const unhealthy = components
    .map((component) => component.status)
    .filter((status) => status && status !== "operational");
  if (unhealthy.length > 0 && unhealthy.every((status) => status === "degraded_performance")) {
    return "minor";
  }

  return "major";
}

function isMajorCustomerOutage(result: ServiceCheckResult): boolean {
  if (
    result.severity === "minor" ||
    result.severity === "probe_blocked" ||
    result.severity === "check_failed"
  ) {
    return false;
  }

  if (result.statusCode === 403 || result.statusCode === 429) {
    return false;
  }

  return result.status === "outage";
}

function slackImpactLabel(service: ServiceCheckResult): "Minor" | "Major" | null {
  if (service.notifySlack === false) {
    return null;
  }

  if (
    service.severity === "probe_blocked" ||
    service.severity === "check_failed" ||
    service.status === "degraded" ||
    service.statusCode === 403 ||
    service.statusCode === 429
  ) {
    return null;
  }

  if (service.severity === "minor") {
    return "Minor";
  }

  if (service.severity === "major" || service.status === "outage") {
    return "Major";
  }

  return null;
}

function checkFailedResult(
  service: ServiceDefinition,
  statusCode: number | null,
  latencyMs: number,
  checkedAt: string
): ServiceCheckResult {
  return {
    ...service,
    status: "degraded",
    severity: "check_failed",
    latencyMs,
    statusCode,
    checkedAt,
    error: CHECK_FAILED_ERROR
  };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isShopifyStatusService(service: { id: string; url: string }): boolean {
  if (service.id === SHOPIFY_STATUS_SERVICE_ID) {
    return true;
  }

  const hostname = hostnameOf(service.url);
  return hostname !== null && SHOPIFY_STATUS_HOSTS.has(hostname);
}

function isIcseCustomerPage(service: { url: string; checkType?: ServiceDefinition["checkType"] }): boolean {
  if (service.checkType && service.checkType !== "http") {
    return false;
  }

  const hostname = hostnameOf(service.url);
  return hostname === ICSE_SITE_HOST || (hostname?.endsWith(`.${ICSE_SITE_HOST}`) ?? false);
}

function requiresMajorConfirmation(service: { id: string; url: string; checkType?: ServiceDefinition["checkType"] }): boolean {
  return isIcseCustomerPage(service) || isShopifyStatusService(service);
}

/**
 * A customer page is affected when our own probe saw a 5xx, a timeout, or a
 * network error. Other 4xx responses and probe blocks do not count.
 */
function isCustomerPageHardFailure(result: ServiceCheckResult): boolean {
  if (!isIcseCustomerPage(result)) {
    return false;
  }

  if (typeof result.statusCode === "number" && result.statusCode >= 500 && result.statusCode <= 599) {
    return true;
  }

  return result.statusCode === null && result.status === "outage";
}

function applyShopifyIncidentPolicy(results: ServiceCheckResult[]): ServiceCheckResult[] {
  const siteAffected = results.some((result) => isCustomerPageHardFailure(result));

  return results.map((result) => {
    if (!isShopifyStatusService(result) || result.severity !== "major") {
      return result;
    }

    if (siteAffected) {
      return result;
    }

    return {
      ...result,
      status: "outage",
      severity: "minor",
      notifySlack: false
    };
  });
}

function previousConfirmedStreak(previous: ServiceCheckResult | undefined): number {
  if (!previous || previous.severity !== "major" || previous.status !== "outage") {
    return 0;
  }

  if (typeof previous.consecutiveMajorFailures === "number") {
    return previous.consecutiveMajorFailures;
  }

  // Snapshots from before streak tracking already paged an in-progress major.
  return MAJOR_ALERT_STREAK;
}

function applyMajorAlertStreaks(
  results: ServiceCheckResult[],
  previousSnapshot: StatusSnapshot | null
): ServiceCheckResult[] {
  const previousById = new Map(
    previousSnapshot?.services.map((service) => [service.id, service] as const) ?? []
  );

  return results.map((result) => {
    if (!requiresMajorConfirmation(result)) {
      return result;
    }

    if (result.severity !== "major" || result.status !== "outage") {
      return { ...result, consecutiveMajorFailures: 0 };
    }

    return {
      ...result,
      consecutiveMajorFailures: previousConfirmedStreak(previousById.get(result.id)) + 1
    };
  });
}

function shouldPostSlack(
  service: ServiceCheckResult,
  previous: ServiceCheckResult | undefined,
  label: "Minor" | "Major"
): boolean {
  if (requiresMajorConfirmation(service) && label === "Major") {
    const streak = service.consecutiveMajorFailures ?? 0;
    return streak >= MAJOR_ALERT_STREAK && previousConfirmedStreak(previous) < MAJOR_ALERT_STREAK;
  }

  return previous?.status !== "outage";
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
