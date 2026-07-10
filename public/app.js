const refreshButton = document.querySelector("#refresh-button");
const overallHeading = document.querySelector("#overall-heading");
const overallBadge = document.querySelector("#overall-badge");
const summaryDetail = document.querySelector("#summary-detail");
const staleWarning = document.querySelector("#stale-warning");
const configIssues = document.querySelector("#config-issues");
const configIssuesList = document.querySelector("#config-issues-list");
const servicesList = document.querySelector("#services-list");
const historyList = document.querySelector("#history-list");
const lastUpdated = document.querySelector("#last-updated");

const STATUS_META = {
  operational: {
    label: "Operational",
    detail: "All monitored services are responding normally."
  },
  degraded: {
    label: "Degraded",
    detail: "One or more monitored services are not responding normally."
  },
  outage: {
    label: "Outage",
    detail: "All monitored services are currently failing checks."
  },
  unknown: {
    label: "Unknown",
    detail: "No completed status check is available yet."
  }
};

const SEVERITY_META = {
  minor: { label: "Minor incident" },
  major: { label: "Major incident" }
};

refreshButton?.addEventListener("click", () => {
  void loadStatus();
});

void loadStatus();
setInterval(() => {
  void loadStatus({ quiet: true });
}, 60_000);

async function loadStatus(options = {}) {
  setRefreshing(true);

  try {
    const [status, history] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/history")
    ]);

    renderStatus(status);
    renderHistory(history.events ?? []);
  } catch (error) {
    renderLoadError(error);
  } finally {
    setRefreshing(false, options.quiet);
  }
}

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }

  return response.json();
}

function renderStatus(snapshot) {
  const meta = STATUS_META[snapshot.overall] ?? STATUS_META.unknown;
  overallHeading.textContent = meta.label;
  overallBadge.textContent = meta.label;
  overallBadge.className = `overall-badge is-${snapshot.overall}`;
  summaryDetail.textContent = buildSummaryText(snapshot, meta.detail);
  staleWarning.hidden = !snapshot.stale;
  lastUpdated.textContent = `Last updated: ${formatTime(snapshot.lastRun?.checkedAt ?? snapshot.generatedAt)}`;

  renderConfigIssues(snapshot.configIssues ?? []);
  renderServices(snapshot.services ?? []);
}

function buildSummaryText(snapshot, fallback) {
  if (!snapshot.summary || snapshot.summary.total === 0) {
    return "No services are configured yet.";
  }

  const parts = [
    `${snapshot.summary.operational} operational`,
    `${snapshot.summary.outage} outage`,
    `${snapshot.summary.unknown} unknown`
  ];

  return `${fallback} ${parts.join(", ")}.`;
}

function renderConfigIssues(issues) {
  configIssues.hidden = issues.length === 0;
  configIssuesList.replaceChildren();

  for (const issue of issues) {
    const item = document.createElement("li");
    item.textContent = issue.index === undefined
      ? issue.message
      : `Entry ${issue.index + 1}: ${issue.message}`;
    configIssuesList.append(item);
  }
}

function renderServices(services) {
  servicesList.replaceChildren();

  if (services.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No services configured.";
    servicesList.append(empty);
    return;
  }

  for (const [groupName, groupServices] of groupBy(services, (service) => service.group || "ICSE Services")) {
    const group = document.createElement("section");
    group.className = "service-group";

    const heading = document.createElement("h3");
    heading.textContent = groupName;
    group.append(heading);

    for (const service of groupServices) {
      group.append(renderServiceRow(service));
    }

    servicesList.append(group);
  }
}

function renderServiceRow(service) {
  const row = document.createElement("article");
  row.className = `service-row is-${service.severity ?? service.status}`;

  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";
  statusDot.setAttribute("aria-hidden", "true");

  const nameBlock = document.createElement("div");
  nameBlock.className = "service-name";

  const name = document.createElement("h4");
  const link = document.createElement("a");
  link.href = service.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = service.name;
  name.append(link);
  nameBlock.append(name);

  if (service.description) {
    const description = document.createElement("p");
    description.textContent = service.description;
    nameBlock.append(description);
  }

  const metrics = document.createElement("dl");
  metrics.className = "service-metrics";
  metrics.append(metric("State", SEVERITY_META[service.severity]?.label ?? STATUS_META[service.status]?.label ?? service.status));
  metrics.append(metric("Latency", formatLatency(service.latencyMs)));
  metrics.append(metric("HTTP", service.statusCode ?? "--"));
  metrics.append(metric("Checked", formatTime(service.checkedAt)));

  if (service.error) {
    metrics.append(metric("Error", service.error));
  }

  row.append(statusDot, nameBlock, metrics);
  return row;
}

function renderHistory(events) {
  historyList.replaceChildren();

  if (events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No status changes recorded.";
    historyList.append(empty);
    return;
  }

  for (const event of events) {
    const item = document.createElement("li");
    item.className = `history-item is-${event.to}`;

    const title = document.createElement("strong");
    title.textContent = event.serviceName;

    const detail = document.createElement("span");
    detail.textContent = `${event.from} to ${event.to}`;

    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = formatTime(event.at);

    item.append(title, detail, time);
    historyList.append(item);
  }
}

function renderLoadError(error) {
  overallHeading.textContent = "Unavailable";
  overallBadge.textContent = "API error";
  overallBadge.className = "overall-badge is-outage";
  summaryDetail.textContent = error instanceof Error ? error.message : "Unable to load status data.";
}

function setRefreshing(isRefreshing) {
  if (!refreshButton) {
    return;
  }

  refreshButton.disabled = isRefreshing;
  refreshButton.textContent = isRefreshing ? "Refreshing" : "Refresh";
}

function metric(label, value) {
  const fragment = document.createDocumentFragment();
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = String(value);
  fragment.append(term, description);
  return fragment;
}

function groupBy(items, keyFn) {
  const groups = new Map();

  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function formatLatency(value) {
  return typeof value === "number" ? `${Math.round(value)} ms` : "--";
}

function formatTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
