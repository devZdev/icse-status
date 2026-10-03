export type ServiceState = "operational" | "degraded" | "outage" | "unknown";

export type OverallState = "operational" | "degraded" | "outage" | "unknown";

/**
 * Alert severity for a non-operational check.
 * probe_blocked and check_failed are not customer outages and do not page Slack.
 * minor and major are customer-impact severities and do page Slack, except a
 * Shopify feed incident that does not affect the ICSE site (shown, not paged).
 */
export type ServiceSeverity = "probe_blocked" | "check_failed" | "minor" | "major";

export type CheckTrigger = "scheduled";

export interface ServiceDefinition {
  id: string;
  name: string;
  group: string;
  url: string;
  description?: string;
  timeoutMs?: number;
  checkType?: "http" | "statusPage" | "incidentIoHtml" | "arloHtml";
}

export interface ConfigIssue {
  index?: number;
  id?: string;
  message: string;
}

export interface ServiceCatalog {
  services: ServiceDefinition[];
  issues: ConfigIssue[];
}

export interface ServiceCheckResult extends ServiceDefinition {
  status: ServiceState;
  severity?: ServiceSeverity;
  latencyMs: number | null;
  statusCode: number | null;
  checkedAt: string | null;
  error?: string;
  /**
   * Consecutive scheduled runs that stayed a major-class failure.
   * Set for ICSE customer pages and Shopify. Major Slack for those waits
   * until this reaches MAJOR_ALERT_STREAK.
   */
  consecutiveMajorFailures?: number;
  /**
   * When false, keep this result on the status page and do not post to Slack.
   * Used when Shopify reports a provider incident that is not affecting the ICSE site.
   */
  notifySlack?: false;
}

export interface StatusSummary {
  total: number;
  operational: number;
  degraded: number;
  outage: number;
  unknown: number;
}

export interface LastRunMetadata {
  checkedAt: string;
  durationMs: number;
  trigger: CheckTrigger;
  total: number;
  operational: number;
  degraded: number;
  outage: number;
}

export interface StatusSnapshot {
  generatedAt: string;
  overall: OverallState;
  stale: boolean;
  summary: StatusSummary;
  services: ServiceCheckResult[];
  historyLimit: number;
  configIssues: ConfigIssue[];
  lastRun: LastRunMetadata | null;
}

export interface StatusEvent {
  id: string;
  at: string;
  serviceId: string;
  serviceName: string;
  from: ServiceState;
  to: ServiceState;
  message: string;
}

export interface Env {
  STATUS_KV: KVNamespace;
  ASSETS: Fetcher;
  SLACK_WEBHOOK_URL?: string;
}
