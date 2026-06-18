export type ServiceState = "operational" | "outage" | "unknown";

export type OverallState = "operational" | "degraded" | "outage" | "unknown";

export type CheckTrigger = "scheduled";

export interface ServiceDefinition {
  id: string;
  name: string;
  group: string;
  url: string;
  description?: string;
  timeoutMs?: number;
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
  latencyMs: number | null;
  statusCode: number | null;
  checkedAt: string | null;
  error?: string;
}

export interface StatusSummary {
  total: number;
  operational: number;
  outage: number;
  unknown: number;
}

export interface LastRunMetadata {
  checkedAt: string;
  durationMs: number;
  trigger: CheckTrigger;
  total: number;
  operational: number;
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
}

