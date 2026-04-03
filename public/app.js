const personas = {
  claimsMaker: { actorId: "claims-maker-1", displayName: "Claims Maker", roles: ["CLAIMS_MAKER"] },
  claimsChecker: { actorId: "claims-checker-1", displayName: "Claims Checker", roles: ["CLAIMS_CHECKER"] },
  financeMaker: { actorId: "finance-maker-1", displayName: "Finance Maker", roles: ["FINANCE_MAKER"] },
  financeChecker: { actorId: "finance-checker-1", displayName: "Finance Checker", roles: ["FINANCE_CHECKER"] },
  reconAnalyst: { actorId: "recon-analyst-1", displayName: "Reconciliation Analyst", roles: ["RECON_ANALYST"] },
  system: { actorId: "system-bot", displayName: "System Bot", roles: ["SYSTEM"] },
};

const queueKey = "claims-platform-offline-queue";

const elements = {
  personaSelect: document.querySelector("#persona-select"),
  networkState: document.querySelector("#network-state"),
  queueState: document.querySelector("#queue-state"),
  summaryGrid: document.querySelector("#summary-grid"),
  claimsTable: document.querySelector("#claims-table"),
  exceptionsList: document.querySelector("#exceptions-list"),
  ledgerList: document.querySelector("#ledger-list"),
  eventsList: document.querySelector("#events-list"),
  claimForm: document.querySelector("#claim-form"),
  reconForm: document.querySelector("#recon-form"),
  seedDemo: document.querySelector("#seed-demo"),
  runSelfHeal: document.querySelector("#run-self-heal"),
  statusBanner: document.querySelector("#status-banner"),
};

function createCommandId(prefix = "cmd") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function getActivePersona() {
  return personas[elements.personaSelect.value] ?? personas.claimsMaker;
}

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(queueKey) ?? "[]");
  } catch {
    return [];
  }
}

function setQueue(items) {
  localStorage.setItem(queueKey, JSON.stringify(items));
  renderQueueState();
}

function showStatus(message, isError = false) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.classList.remove("hidden", "error");
  if (isError) {
    elements.statusBanner.classList.add("error");
  }
}

function clearStatus() {
  elements.statusBanner.classList.add("hidden");
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Request failed.");
  }

  return body;
}

async function sendOrQueue(url, payload) {
  const envelope = {
    url,
    payload,
    queuedAt: new Date().toISOString(),
  };

  if (!navigator.onLine) {
    setQueue([...getQueue(), envelope]);
    showStatus("Offline detected. Command queued for later sync.");
    return { queued: true };
  }

  try {
    return await apiFetch(url, { method: "POST", body: JSON.stringify(payload) });
  } catch (error) {
    setQueue([...getQueue(), envelope]);
    showStatus(`Command queued after network failure: ${error.message}`, true);
    return { queued: true };
  }
}

async function flushQueue() {
  if (!navigator.onLine) {
    renderNetworkState();
    return;
  }

  const queue = getQueue();
  if (queue.length === 0) {
    return;
  }

  const remaining = [];
  for (const item of queue) {
    try {
      await apiFetch(item.url, { method: "POST", body: JSON.stringify(item.payload) });
    } catch (error) {
      remaining.push(item);
      showStatus(`Some queued commands could not sync: ${error.message}`, true);
    }
  }

  setQueue(remaining);
  if (remaining.length === 0) {
    showStatus("Offline queue synchronized.");
    await refreshSnapshot();
  }
}

function renderNetworkState() {
  elements.networkState.textContent = navigator.onLine ? "Online: commands are sent immediately." : "Offline: commands will be queued locally.";
}

function renderQueueState() {
  const queue = getQueue();
  elements.queueState.textContent = `Offline queue: ${queue.length} pending command(s)`;
}

function money(value) {
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    minimumFractionDigits: 2,
  }).format((value ?? 0) / 100);
}

function renderSummary(snapshot) {
  const entries = [
    ["Claims", snapshot.dashboard.totalClaims],
    ["Awaiting Checker", snapshot.dashboard.awaitingChecker],
    ["Pending Recon", snapshot.dashboard.settledPendingReconciliation],
    ["Reconciled", snapshot.dashboard.reconciledClaims],
    ["Open Exceptions", snapshot.dashboard.openExceptions],
    ["Reserve Booked", money(snapshot.dashboard.reserveTotalMinor)],
    ["Payout Posted", money(snapshot.dashboard.payoutTotalMinor)],
    ["Integrity", snapshot.integrity.ok ? "Verified" : "Failed"],
  ];

  elements.summaryGrid.innerHTML = entries
    .map(
      ([label, value]) => `
        <article class="metric">
          <p class="metric-label">${label}</p>
          <p class="metric-value">${value}</p>
        </article>
      `,
    )
    .join("");
}

function claimActionButtons(claim) {
  const buttons = [];
  if (claim.status === "SUBMITTED") {
    buttons.push(`<button class="ghost" data-action="validate" data-claim-id="${claim.claimId}">Validate</button>`);
  }
  if (claim.status === "VALIDATED") {
    buttons.push(`<button class="ghost" data-action="adjudicate" data-claim-id="${claim.claimId}">Adjudicate</button>`);
  }
  if (claim.status === "APPROVED_FOR_SETTLEMENT") {
    buttons.push(`<button class="ghost" data-action="propose" data-claim-id="${claim.claimId}">Propose Settlement</button>`);
  }
  if (claim.status === "AWAITING_SETTLEMENT_CHECKER") {
    buttons.push(`<button class="ghost" data-action="approve" data-claim-id="${claim.claimId}">Approve Settlement</button>`);
  }
  if (claim.status === "SETTLEMENT_APPROVED") {
    buttons.push(`<button class="ghost" data-action="record" data-claim-id="${claim.claimId}">Record Settlement</button>`);
  }
  return buttons.join("");
}

function renderClaims(snapshot) {
  if (snapshot.claims.length === 0) {
    elements.claimsTable.innerHTML = "<p>No claims yet.</p>";
    return;
  }

  elements.claimsTable.innerHTML = snapshot.claims
    .map(
      (claim) => `
        <article class="claim-row">
          <header>
            <div>
              <strong>${claim.claimId}</strong>
              <div class="claim-meta">${claim.policyRef} • ${claim.memberRef} • ${claim.providerRef}</div>
            </div>
            <span class="pill ${claim.status.includes("EXCEPTION") ? "danger" : claim.status.includes("APPROVED") || claim.status.includes("RECONCILED") ? "ok" : "warn"}">${claim.status}</span>
          </header>
          <p>${claim.narrative}</p>
          <div class="claim-meta">Claimed: ${money(claim.amountMinor)} • Incident: ${claim.incidentDate}</div>
          <div class="claim-meta">Settlement Ref: ${claim.settlement?.paymentReference ?? "None"} • Recon: ${claim.reconciliation.status}</div>
          <div class="actions">${claimActionButtons(claim)}</div>
        </article>
      `,
    )
    .join("");
}

function renderExceptions(snapshot) {
  const items = snapshot.reconciliation.openExceptions;
  if (items.length === 0) {
    elements.exceptionsList.innerHTML = "<p>No open exceptions.</p>";
    return;
  }

  elements.exceptionsList.innerHTML = items
    .map(
      (item) => `
        <article class="case-item">
          <header>
            <strong>${item.caseId}</strong>
            <span class="pill danger">${item.exception.code}</span>
          </header>
          <p>${item.exception.reason}</p>
          <div class="claim-meta">Settlement: ${item.settlementId ?? "n/a"} • Reference: ${item.externalReference ?? "n/a"}</div>
          <div class="actions">
            <button class="ghost" data-action="resolve-exception" data-case-id="${item.caseId}">Resolve</button>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderLedger(snapshot) {
  if (snapshot.ledgerEntries.length === 0) {
    elements.ledgerList.innerHTML = "<p>No ledger events yet.</p>";
    return;
  }

  elements.ledgerList.innerHTML = snapshot.ledgerEntries
    .map(
      (entry) => `
        <article class="ledger-item">
          <header>
            <strong>${entry.entryType}</strong>
            <span class="claim-meta">${entry.claimId}</span>
          </header>
          <pre>${JSON.stringify(entry.lines, null, 2)}</pre>
        </article>
      `,
    )
    .join("");
}

function renderEvents(snapshot) {
  elements.eventsList.innerHTML = snapshot.recentEvents
    .map(
      (event) => `
        <article class="event-item">
          <header>
            <strong>${event.eventType}</strong>
            <span class="claim-meta">${event.aggregateType}:${event.aggregateId}</span>
          </header>
          <div class="event-meta">${event.occurredAt} • hash ${event.metadata.hash.slice(0, 12)}...</div>
          <pre>${JSON.stringify(event.payload, null, 2)}</pre>
        </article>
      `,
    )
    .join("");
}

async function refreshSnapshot() {
  const snapshot = await apiFetch("/api/snapshot");
  renderSummary(snapshot);
  renderClaims(snapshot);
  renderExceptions(snapshot);
  renderLedger(snapshot);
  renderEvents(snapshot);
}

function commandEnvelope(body, prefix) {
  return {
    actor: getActivePersona(),
    commandId: createCommandId(prefix),
    body,
  };
}

async function handleClaimFormSubmit(event) {
  event.preventDefault();
  clearStatus();
  const form = new FormData(event.currentTarget);
  const payload = commandEnvelope(
    {
      tenantId: form.get("tenantId"),
      policyRef: form.get("policyRef"),
      memberRef: form.get("memberRef"),
      providerRef: form.get("providerRef"),
      incidentDate: form.get("incidentDate"),
      amountMinor: Number(form.get("amountMinor")),
      currency: String(form.get("currency")).toUpperCase(),
      narrative: form.get("narrative"),
      source: navigator.onLine ? "WEB_PORTAL" : "OFFLINE_QUEUE",
    },
    "claim",
  );

  await sendOrQueue("/api/claims/intake", payload);
  event.currentTarget.reset();
  event.currentTarget.currency.value = "KES";
  event.currentTarget.tenantId.value = "demo-insurer-ke";
  if (navigator.onLine) {
    showStatus("Claim submitted.");
    await refreshSnapshot();
  }
}

async function handleReconFormSubmit(event) {
  event.preventDefault();
  clearStatus();
  const form = new FormData(event.currentTarget);
  const payload = commandEnvelope(
    {
      sourceSystem: form.get("sourceSystem"),
      accountRef: form.get("accountRef"),
      statementDate: form.get("statementDate"),
      lines: JSON.parse(String(form.get("lines"))),
    },
    "recon",
  );

  await sendOrQueue("/api/reconciliation/import", payload);
  if (navigator.onLine) {
    showStatus("Reconciliation batch imported.");
    await refreshSnapshot();
  }
}

async function handleClaimAction(claimId, action) {
  const prompts = {
    validate: {
      url: `/api/claims/${claimId}/validate`,
      body: { outcome: "VALID", findings: ["Manual validation complete."] },
      prefix: "validate",
    },
    adjudicate: {
      url: `/api/claims/${claimId}/adjudicate`,
      body: { decision: "APPROVED", reasonCodes: ["POLICY_MATCH"] },
      prefix: "adjudicate",
    },
    propose: {
      url: `/api/claims/${claimId}/propose-settlement`,
      body: {
        beneficiaryRef: prompt("Beneficiary reference", "BENEF-001") ?? "BENEF-001",
        paymentReference: prompt("Payment reference", `PAY-${Date.now()}`) ?? `PAY-${Date.now()}`,
        amountMinor: Number(prompt("Amount minor", "100000") ?? "100000"),
        channelType: prompt("Channel (BANK_TRANSFER/MOBILE_MONEY/CHEQUE/CARD_REVERSAL)", "BANK_TRANSFER") ?? "BANK_TRANSFER",
        makerNote: "Prepared from web control room.",
      },
      prefix: "propose",
    },
    approve: {
      url: `/api/claims/${claimId}/approve-settlement`,
      body: { approvalNote: "Checker approval granted from control room." },
      prefix: "approve",
    },
    record: {
      url: `/api/claims/${claimId}/record-settlement`,
      body: {
        postingRef: prompt("Posting reference", `POST-${Date.now()}`) ?? `POST-${Date.now()}`,
        externalStatus: "MANUALLY_CONFIRMED",
      },
      prefix: "record",
    },
  };

  const config = prompts[action];
  if (!config) {
    return;
  }

  await sendOrQueue(config.url, commandEnvelope(config.body, config.prefix));
  if (navigator.onLine) {
    await refreshSnapshot();
  }
}

async function handleResolveException(caseId) {
  await sendOrQueue(
    `/api/exceptions/${caseId}/resolve`,
    commandEnvelope(
      {
        resolutionCode: "MANUAL_CONFIRMED",
        resolutionNote: "Resolved manually from control room.",
      },
      "resolve",
    ),
  );
  if (navigator.onLine) {
    await refreshSnapshot();
  }
}

async function setup() {
  Object.entries(personas).forEach(([key, value]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `${value.displayName} (${value.roles.join(", ")})`;
    elements.personaSelect.append(option);
  });

  elements.claimForm.addEventListener("submit", handleClaimFormSubmit);
  elements.reconForm.addEventListener("submit", handleReconFormSubmit);
  elements.seedDemo.addEventListener("click", async () => {
    clearStatus();
    await apiFetch("/api/demo/seed", { method: "POST", body: JSON.stringify({}) });
    showStatus("Demo scenario loaded.");
    await refreshSnapshot();
  });
  elements.runSelfHeal.addEventListener("click", async () => {
    clearStatus();
    await sendOrQueue(
      "/api/self-heal/run",
      commandEnvelope(
        {
          maxAgeDays: 2,
          asAt: new Date().toISOString(),
        },
        "heal",
      ),
    );
    if (navigator.onLine) {
      showStatus("Self-heal run completed.");
      await refreshSnapshot();
    }
  });

  document.body.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.dataset.action;
    const claimId = target.dataset.claimId;
    const caseId = target.dataset.caseId;

    if (action && claimId) {
      await handleClaimAction(claimId, action);
    }

    if (action === "resolve-exception" && caseId) {
      await handleResolveException(caseId);
    }
  });

  window.addEventListener("online", flushQueue);
  window.addEventListener("offline", renderNetworkState);

  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/sw.js");
  }

  renderNetworkState();
  renderQueueState();
  await flushQueue();
  await refreshSnapshot();
}

setup().catch((error) => {
  showStatus(error.message, true);
});
