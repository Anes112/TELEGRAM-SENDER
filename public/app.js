const state = {
  status: null,
  detectedGroups: [],
  detectedFolders: [],
  detectedAdmins: [],
  selectedGroupKeys: new Set(),
  selectedFolderGroupKeys: new Set(),
  selectedAdminKeys: new Set(),
  newAccountMode: false,
  selectedAccountId: "",
  selectedFolderId: "",
  activeView: "dashboard",
  notifiedFailures: new Set(),
  initialStatusLoaded: false,
  intervalsDirty: false
};

const $ = (id) => document.getElementById(id);
const keyOf = (item) => `${item.accountId}:${item.id}`;

function switchView(view) {
  state.activeView = view || "dashboard";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === state.activeView);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
}

function initNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  switchView(state.activeView);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request gagal");
  return data;
}

async function waitJob(jobId, label) {
  let ticks = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    ticks += 1;
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "done") return job.result || {};
    if (job.status === "error") throw new Error(job.error || `${label} gagal`);
    if (ticks % 5 === 0) toast(`${label} masih proses...`);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function secondsUntil(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.ceil((time - Date.now()) / 1000));
}

function fmtDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function countdownText(item) {
  const seconds = secondsUntil(item.nextRunAt);
  if (!seconds) return item.nextRunAt ? "siap" : "-";
  return `sisa ${fmtDuration(seconds)}`;
}

function activeAccountId() {
  return state.selectedAccountId || $("accountSelect").value || state.status?.activeAccountId || "";
}

function activeAccount() {
  return (state.status?.accounts || []).find((account) => account.id === activeAccountId());
}

async function refreshStatus(keepForm = true) {
  const previousAccount = state.selectedAccountId || $("accountSelect").value;
  state.status = await api("/api/status");
  renderAccounts(previousAccount);
  if (!keepForm) fillFromStatus();
  renderStatus();
  renderTargets();
  if (!state.intervalsDirty && !intervalEditorActive()) renderIntervals();
  renderProgress();
  renderLog();
  if (state.initialStatusLoaded) notifyNewFailures();
  else {
    rememberExistingFailures();
    state.initialStatusLoaded = true;
  }
}

async function refreshProgressOnly() {
  const progress = await api("/api/progress");
  if (!state.status) return;
  state.status.selectedGroups = progress.selectedGroups || [];
  state.status.selectedFolderGroups = progress.selectedFolderGroups || [];
  state.status.selectedAdmins = progress.selectedAdmins || [];
  state.status.sendLog = progress.sendLog || [];
  state.status.lastStatus = progress.lastStatus || "";
  state.status.isSending = Boolean(progress.isSending);
  state.status.currentBlast = progress.currentBlast || null;
  state.status.currentBlasts = progress.currentBlasts || {};
  state.status.cancelSendRequested = Boolean(progress.cancelSendRequested);
  notifyNewFailures();
  renderStatus();
  if (!state.intervalsDirty) renderIntervals();
  renderProgress();
  renderLog();
}

function failureKey(kind, item) {
  return `${kind}:${keyOf(item)}:${item.lastStatus || ""}`;
}

function rememberExistingFailures() {
  for (const item of state.status?.selectedGroups || []) {
    if (blastState(item) === "failed") state.notifiedFailures.add(failureKey("groups", item));
  }
  for (const item of state.status?.selectedFolderGroups || []) {
    if (blastState(item) === "failed") state.notifiedFailures.add(failureKey("folderGroups", item));
  }
  for (const item of state.status?.selectedAdmins || []) {
    if (blastState(item) === "failed") state.notifiedFailures.add(failureKey("admins", item));
  }
}

function notifyNewFailures() {
  const failures = [
    ...(state.status?.selectedGroups || []).map((item) => ({ kind: "groups", item })),
    ...(state.status?.selectedFolderGroups || []).map((item) => ({ kind: "folderGroups", item })),
    ...(state.status?.selectedAdmins || []).map((item) => ({ kind: "admins", item }))
  ].filter(({ item }) => blastState(item) === "failed");

  for (const { kind, item } of failures) {
    const key = failureKey(kind, item);
    if (state.notifiedFailures.has(key)) continue;
    state.notifiedFailures.add(key);
    toast(`Gagal: ${item.title || item.name} - ${String(item.lastStatus || "").replace(/^ERROR:\s*/, "")}`);
  }
}

function fillFromStatus() {
  $("groupMessage").value = state.status.groupMessage || state.status.message || "";
  $("groupForwardLink").value = state.status.groupForwardLink || "";
  $("folderGroupMessage").value = state.status.folderGroupMessage || "";
  $("folderGroupForwardLink").value = state.status.folderGroupForwardLink || "";
  $("adminMessage").value = state.status.adminMessage || state.status.message || "";
  $("groupSenderAccountSelect").value = state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  $("adminSenderAccountSelect").value = state.status.adminSenderAccountId || state.status.senderAccountId || "target";
  $("folderGroupSenderAccountSelect").value = state.status.folderGroupSenderAccountId || state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  $("groupDefaultIntervalSeconds").value = state.status.groupDefaultIntervalSeconds || state.status.defaultIntervalSeconds || 3600;
  $("folderGroupDefaultIntervalSeconds").value = state.status.folderGroupDefaultIntervalSeconds || state.status.groupDefaultIntervalSeconds || state.status.defaultIntervalSeconds || 3600;
  $("adminDefaultIntervalSeconds").value = state.status.adminDefaultIntervalSeconds || state.status.defaultIntervalSeconds || 3600;
  $("groupDelaySeconds").value = state.status.groupDelaySeconds ?? state.status.delaySeconds ?? 1;
  $("folderGroupDelaySeconds").value = state.status.folderGroupDelaySeconds ?? state.status.groupDelaySeconds ?? 3;
  $("adminDelaySeconds").value = state.status.adminDelaySeconds ?? state.status.delaySeconds ?? 1;
  $("groupSchedulerEnabled").checked = Boolean(state.status.groupSchedulerEnabled);
  $("folderGroupSchedulerEnabled").checked = Boolean(state.status.folderGroupSchedulerEnabled);
  $("adminSchedulerEnabled").checked = Boolean(state.status.adminSchedulerEnabled);
  $("groupLoopEnabled").checked = Boolean(state.status.groupLoopEnabled);
  $("folderGroupLoopEnabled").checked = Boolean(state.status.folderGroupLoopEnabled);
  $("adminLoopEnabled").checked = Boolean(state.status.adminLoopEnabled);
  $("groupActivityGateEnabled").checked = Boolean(state.status.groupActivityGateEnabled);
  $("folderGroupActivityGateEnabled").checked = Boolean(state.status.folderGroupActivityGateEnabled);
  $("groupActivityGateMinMessages").value = state.status.groupActivityGateMinMessages || state.status.activityGateMinMessages || 10;
  $("folderGroupActivityGateMinMessages").value = state.status.folderGroupActivityGateMinMessages || state.status.activityGateMinMessages || 10;
  $("quietHoursEnabled").checked = Boolean(state.status.quietHoursEnabled);
  $("quietHoursStart").value = state.status.quietHoursStart || "02:50";
  $("quietHoursEnd").value = state.status.quietHoursEnd || "03:20";
  $("networkRetrySeconds").value = state.status.networkRetrySeconds || 300;
  $("reconnectWatchdogEnabled").checked = state.status.reconnectWatchdogEnabled !== false;
}

function renderAccounts(previousAccount) {
  const accounts = state.status.accounts || [];
  $("accountSelect").innerHTML = accounts.length
    ? accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} ${account.authorized ? "✓" : "!"}</option>`).join("")
    : `<option value="">Belum ada akun</option>`;
  const validPrevious = accounts.some((account) => account.id === previousAccount) ? previousAccount : "";
  state.selectedAccountId = validPrevious || state.status.activeAccountId || accounts[0]?.id || "";
  $("accountSelect").value = state.selectedAccountId;
  const senderOptions = `<option value="target">Sesuai akun detect</option>` +
    accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`).join("");
  $("groupSenderAccountSelect").innerHTML = senderOptions;
  $("folderGroupSenderAccountSelect").innerHTML = senderOptions;
  $("adminSenderAccountSelect").innerHTML = senderOptions;
  $("groupSenderAccountSelect").value = state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  $("folderGroupSenderAccountSelect").value = state.status.folderGroupSenderAccountId || state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  $("adminSenderAccountSelect").value = state.status.adminSenderAccountId || state.status.senderAccountId || "target";

  const account = activeAccount();
  if (account && !state.newAccountMode) {
    $("accountLabel").value = account.label || "";
    $("apiId").value = account.apiId || "";
    $("phone").value = account.phone || "";
  }

  $("accountsList").innerHTML = accounts.length
    ? accounts.map((account) => `<div class="miniItem"><b>${escapeHtml(account.label)}</b> · ${escapeHtml(account.phone)} · ${account.authorized ? "login aktif" : "belum login"}</div>`).join("")
    : `<div class="miniItem">Belum ada akun.</div>`;
}

function renderStatus() {
  const badge = $("statusBadge");
  const logged = (state.status.accounts || []).filter((account) => account.authorized).length;
  const groupSenderId = state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  const folderSenderId = state.status.folderGroupSenderAccountId || state.status.groupSenderAccountId || state.status.senderAccountId || "target";
  const adminSenderId = state.status.adminSenderAccountId || state.status.senderAccountId || "target";
  const groupSender = groupSenderId === "target"
    ? "sesuai akun detect"
    : (state.status.accounts || []).find((account) => account.id === groupSenderId)?.label || groupSenderId;
  const folderSender = folderSenderId === "target"
    ? "sesuai akun detect"
    : (state.status.accounts || []).find((account) => account.id === folderSenderId)?.label || folderSenderId;
  const adminSender = adminSenderId === "target"
    ? "sesuai akun detect"
    : (state.status.accounts || []).find((account) => account.id === adminSenderId)?.label || adminSenderId;
  const enabledGroups = (state.status.selectedGroups || []).filter((item) => item.enabled !== false).length;
  const enabledFolderGroups = (state.status.selectedFolderGroups || []).filter((item) => item.enabled !== false).length;
  const enabledAdmins = (state.status.selectedAdmins || []).filter((item) => item.enabled !== false).length;
  const activeBlasts = [state.status.currentBlasts?.groups, state.status.currentBlasts?.folderGroups, state.status.currentBlasts?.admins].filter(Boolean).length;
  badge.textContent = `${logged}/${state.status.accounts.length} akun login`;
  badge.className = `badge ${logged ? "ok" : "warn"}`;
  $("scheduleInfo").textContent =
    `Jadwal grup: ${state.status.groupSchedulerEnabled ? "aktif" : "mati"}. Jadwal kontak: ${state.status.adminSchedulerEnabled ? "aktif" : "mati"}. ` +
    `Default grup: ${state.status.groupForwardLink ? "forward channel" : "teks"}. ` +
    `Default folder: ${state.status.folderGroupForwardLink ? "forward channel" : "teks"}. Jadwal folder: ${state.status.folderGroupSchedulerEnabled ? "aktif" : "mati"}. Loop folder: ${state.status.folderGroupLoopEnabled ? "aktif" : "mati"}. ` +
    `Activity gate grup: ${state.status.groupActivityGateEnabled ? `${state.status.groupActivityGateMinMessages || 10} chat` : "mati"}. Activity gate folder: ${state.status.folderGroupActivityGateEnabled ? `${state.status.folderGroupActivityGateMinMessages || 10} chat` : "mati"}. ` +
    `Quiet hours: ${state.status.quietHoursEnabled ? `${state.status.quietHoursStart}-${state.status.quietHoursEnd}` : "mati"}. ` +
    `Watchdog: ${state.status.reconnectWatchdogEnabled !== false ? "aktif" : "mati"}. Retry koneksi: ${state.status.networkRetrySeconds || 300} detik. ` +
    `Loop grup: ${state.status.groupLoopEnabled ? "aktif" : "mati"}. Loop kontak: ${state.status.adminLoopEnabled ? "aktif" : "mati"}. ` +
    `Grup aktif: ${enabledGroups}/${state.status.selectedGroups.length}. Folder grup aktif: ${enabledFolderGroups}/${state.status.selectedFolderGroups?.length || 0}. Admin aktif: ${enabledAdmins}/${state.status.selectedAdmins.length}. ` +
    `Pengirim grup: ${groupSender}. Pengirim folder: ${folderSender}. Pengirim admin: ${adminSender}. ` +
    `Kondisi: ${activeBlasts ? `${activeBlasts} jalur sedang mengirim` : "idle"}. ` +
    `Status: ${state.status.lastStatus || "-"}`;
  renderBlastIndicator();
}

function initialsFrom(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}

function renderBlastIndicator() {
  const blast = state.status.currentBlast;
  const groupBlast = state.status.currentBlasts?.groups;
  const adminBlast = state.status.currentBlasts?.admins;
  const wrapper = $("blastIndicator");
  const avatar = $("blastAvatar");
  if (!blast || !state.status.isSending) {
    wrapper.className = "blastIndicator idle";
    avatar.innerHTML = "-";
    $("blastTitle").textContent = "Tidak sedang blast";
    $("blastMeta").textContent = "Idle";
    return;
  }

  wrapper.className = "blastIndicator active";
  if (blast.senderAvatarUrl) {
    avatar.innerHTML = `<img src="${escapeHtml(blast.senderAvatarUrl)}" alt="">`;
  } else {
    avatar.textContent = initialsFrom(blast.senderDisplayName || blast.senderLabel);
  }
  $("blastTitle").textContent = groupBlast && adminBlast ? "2 jalur sedang ngeblast" : `${blast.senderLabel || "Akun"} sedang ngeblast`;
  if (groupBlast && adminBlast) {
    $("blastMeta").textContent =
      `Grup: ${groupBlast.senderLabel || "-"} -> ${groupBlast.targetName || "-"} · Kontak: ${adminBlast.senderLabel || "-"} -> ${adminBlast.targetName || "-"}`;
    return;
  }
  $("blastMeta").textContent =
    `${blast.senderPhone || "-"} · ${blast.senderUsername || blast.senderDisplayName || "-"} · target: ${blast.targetName || "-"} · ${blast.status || "Mengirim"}`;
}

function targetRow(item, selected, attr) {
  return `
    <label class="targetRow">
      <input type="checkbox" ${attr}="${escapeHtml(keyOf(item))}" ${selected ? "checked" : ""}>
      <span>
        <span class="targetTitle">${escapeHtml(item.title || item.name)}</span>
        <span class="targetMeta">${escapeHtml(item.username || "tanpa username")} · akun: ${escapeHtml(item.accountLabel || item.accountId)} · ${escapeHtml((item.sourceGroups || []).join(", "))}</span>
      </span>
      <span class="pill">${escapeHtml(item.type || item.role)}</span>
    </label>`;
}

function renderTargets() {
  const groupQuery = $("groupSearch").value.toLowerCase();
  const activeId = activeAccountId();
  const groupsForActiveAccount = state.detectedGroups.filter((item) => item.accountId === activeId);
  const groups = groupsForActiveAccount.filter((item) => `${item.title} ${item.username} ${item.accountLabel}`.toLowerCase().includes(groupQuery));
  const activeLabel = activeAccount()?.label || "akun aktif";
  $("groupHint").textContent = `${groupsForActiveAccount.length} grup terdeteksi dari ${activeLabel}. ${state.selectedGroupKeys.size} dicentang.`;
  $("groupsList").innerHTML = groups.length
    ? groups.map((item) => targetRow(item, state.selectedGroupKeys.has(keyOf(item)), "data-group-key")).join("")
    : `<div class="targetRow"><span></span><span class="targetMeta">Belum ada hasil detect.</span></div>`;
  document.querySelectorAll("[data-group-key]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) state.selectedGroupKeys.add(box.dataset.groupKey);
      else state.selectedGroupKeys.delete(box.dataset.groupKey);
      renderTargets();
    });
  });

  const adminQuery = $("adminSearch").value.toLowerCase();
  const admins = state.detectedAdmins.filter((item) => `${item.name} ${item.username} ${item.role} ${item.accountLabel}`.toLowerCase().includes(adminQuery));
  $("adminHint").textContent = `${state.detectedAdmins.length} admin/owner terdeteksi. ${state.selectedAdminKeys.size} dicentang.`;
  $("adminsList").innerHTML = admins.length
    ? admins.map((item) => targetRow(item, state.selectedAdminKeys.has(keyOf(item)), "data-admin-key")).join("")
    : `<div class="targetRow"><span></span><span class="targetMeta">Belum ada hasil detect admin.</span></div>`;
  document.querySelectorAll("[data-admin-key]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) state.selectedAdminKeys.add(box.dataset.adminKey);
      else state.selectedAdminKeys.delete(box.dataset.adminKey);
      renderTargets();
    });
  });

  renderFolders();
}

function renderFolders() {
  const folders = state.detectedFolders || [];
  $("folderSelect").innerHTML = folders.length
    ? folders.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.title)} (${folder.totalGroups || 0})</option>`).join("")
    : `<option value="">Belum ada folder</option>`;

  const selectedFolderId = folders.some((item) => item.id === state.selectedFolderId) ? state.selectedFolderId : folders[0]?.id || "";
  if (selectedFolderId) $("folderSelect").value = selectedFolderId;
  const folder = folders.find((item) => item.id === selectedFolderId);
  const query = $("folderGroupSearch").value.toLowerCase();
  const groups = (folder?.groups || []).filter((item) => `${item.title} ${item.username} ${item.accountLabel}`.toLowerCase().includes(query));
  $("folderHint").textContent = folder
    ? `${groups.length}/${folder.totalGroups || 0} grup dari folder ${folder.title}. ${state.selectedFolderGroupKeys.size} dicentang.`
    : "Detect folder dari akun aktif, pilih folder, lalu simpan grupnya untuk blast khusus folder.";
  $("folderGroupsList").innerHTML = groups.length
    ? groups.map((item) => targetRow(item, state.selectedFolderGroupKeys.has(keyOf(item)), "data-folder-group-key")).join("")
    : `<div class="targetRow"><span></span><span class="targetMeta">Belum ada grup di folder ini.</span></div>`;
  document.querySelectorAll("[data-folder-group-key]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) state.selectedFolderGroupKeys.add(box.dataset.folderGroupKey);
      else state.selectedFolderGroupKeys.delete(box.dataset.folderGroupKey);
      renderFolders();
    });
  });
}

function intervalRow(item, kind) {
  return `
    <div class="intervalRow" data-kind="${kind}" data-key="${escapeHtml(keyOf(item))}">
      <div><b>${escapeHtml(item.title || item.name)}</b><div class="targetMeta">${escapeHtml(item.accountLabel || item.accountId)} · next: ${fmtDate(item.nextRunAt)}</div></div>
      <input class="intervalInput" type="number" min="5" step="1" value="${Number(item.intervalSeconds || 3600)}">
      <label class="checkline"><input class="enabledInput" type="checkbox" ${item.enabled !== false ? "checked" : ""}> Aktif</label>
      <div class="targetMeta">${escapeHtml(item.lastStatus || "-")} · last: ${fmtDate(item.lastRunAt)}</div>
    </div>`;
}

function intervalRowV2(item, kind) {
  const customMessage = kind === "groups" || kind === "folderGroups"
    ? `<textarea class="customMessageInput" placeholder="Teks khusus grup ini. Kosongkan kalau mau forward dari channel default.">${escapeHtml(item.customMessage || "")}</textarea>`
    : "";
  return `
    <div class="intervalRow" data-kind="${kind}" data-key="${escapeHtml(keyOf(item))}">
      <div><b>${escapeHtml(item.title || item.name)}</b><div class="targetMeta">${escapeHtml(item.accountLabel || item.accountId)} - next: ${fmtDate(item.nextRunAt)}</div></div>
      <input class="intervalInput" type="number" min="5" step="1" value="${Number(item.intervalSeconds || 3600)}">
      <label class="checkline"><input class="enabledInput" type="checkbox" ${item.enabled !== false ? "checked" : ""}> Aktif</label>
      <div>
        <div class="targetMeta">${escapeHtml(item.lastStatus || "-")} - last: ${fmtDate(item.lastRunAt)}</div>
        ${customMessage}
      </div>
    </div>`;
}

function renderIntervals() {
  $("groupIntervals").innerHTML = state.status.selectedGroups.length
    ? state.status.selectedGroups.map((item) => intervalRowV2(item, "groups")).join("")
    : `<div class="miniItem">Belum ada grup tersimpan.</div>`;
  $("folderGroupIntervals").innerHTML = (state.status.selectedFolderGroups || []).length
    ? state.status.selectedFolderGroups.map((item) => intervalRowV2(item, "folderGroups")).join("")
    : `<div class="miniItem">Belum ada grup folder tersimpan.</div>`;
  $("adminIntervals").innerHTML = state.status.selectedAdmins.length
    ? state.status.selectedAdmins.map((item) => intervalRowV2(item, "admins")).join("")
    : `<div class="miniItem">Belum ada admin tersimpan.</div>`;
}

function intervalEditorActive() {
  return Boolean(document.activeElement?.closest?.("#groupIntervals, #folderGroupIntervals, #adminIntervals"));
}

function blastState(item) {
  if (String(item.lastStatus || "").startsWith("SENDING")) return "sending";
  if (String(item.lastStatus || "").startsWith("OK")) return "sent";
  if (String(item.lastStatus || "").startsWith("ERROR")) return "failed";
  if (String(item.lastStatus || "").startsWith("PENDING_RETRY")) return "pending";
  return "pending";
}

function progressData(items) {
  const total = items.length;
  const sending = items.filter((item) => blastState(item) === "sending").length;
  const sent = items.filter((item) => blastState(item) === "sent").length;
  const failed = items.filter((item) => blastState(item) === "failed").length;
  const pending = Math.max(0, total - sending - sent - failed);
  const done = sent + failed;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const nextSeconds = Math.min(...items
    .filter((item) => item.enabled !== false && item.nextRunAt)
    .map((item) => secondsUntil(item.nextRunAt))
    .filter((value) => value > 0));
  return { total, sending, sent, failed, pending, done, percent, nextSeconds: Number.isFinite(nextSeconds) ? nextSeconds : 0 };
}

function renderProgressBlock(items, summaryId, barId, listId) {
  const data = progressData(items);
  $(summaryId).innerHTML = `
    <span>Total: <b>${data.total}</b></span>
    <span>Proses: <b>${data.sending}</b></span>
    <span>Sudah: <b>${data.sent}</b></span>
    <span>Gagal: <b>${data.failed}</b></span>
    <span>Belum: <b>${data.pending}</b></span>
    <span>Progress: <b>${data.percent}%</b></span>
    <span>Next: <b>${data.nextSeconds ? fmtDuration(data.nextSeconds) : "-"}</b></span>
  `;
  $(`${barId}`).querySelector("span").style.width = `${data.percent}%`;
  $(listId).innerHTML = items.length
    ? items.map((item) => {
        const state = blastState(item);
        const label = state === "sent" ? "Sudah" : state === "failed" ? "Gagal" : state === "sending" ? "Mengirim" : "Belum";
        return `
          <div class="progressItem ${state}">
            <div>
              <b>${escapeHtml(item.title || item.name)}</b>
              <div class="targetMeta">${escapeHtml(item.accountLabel || item.accountId)} · ${escapeHtml(item.username || "")}</div>
            </div>
            <div>
              <span class="statusPill ${state}">${label}</span>
              <div class="countdown">next ${escapeHtml(countdownText(item))}</div>
              <div class="targetMeta">${escapeHtml(item.lastStatus || "-")} · ${fmtDate(item.lastRunAt)}</div>
            </div>
          </div>`;
      }).join("")
    : `<div class="miniItem">Belum ada target tersimpan.</div>`;
}

function renderProgress() {
  renderProgressBlock(state.status.selectedGroups || [], "groupProgressSummary", "groupProgressBar", "groupProgressList");
  renderProgressBlock(state.status.selectedFolderGroups || [], "folderGroupProgressSummary", "folderGroupProgressBar", "folderGroupProgressList");
  renderProgressBlock(state.status.selectedAdmins || [], "adminProgressSummary", "adminProgressBar", "adminProgressList");
}

function renderLog() {
  $("logList").innerHTML = state.status.sendLog?.length
    ? state.status.sendLog.map((item) => `<div class="logItem"><b>${fmtDate(item.at)}</b><br>${escapeHtml(item.text)}</div>`).join("")
    : `<div>Belum ada log.</div>`;
}

function bind(id, fn) {
  const button = $(id);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

bind("saveAccountBtn", async () => {
  const result = await api("/api/accounts/save", {
    method: "POST",
    body: JSON.stringify({
      id: state.newAccountMode ? "" : activeAccountId(),
      label: $("accountLabel").value,
      apiId: $("apiId").value,
      apiHash: $("apiHash").value,
      phone: $("phone").value
    })
  });
  $("apiHash").value = "";
  state.newAccountMode = false;
  toast("Akun disimpan.");
  state.selectedAccountId = result.account.id;
  await api("/api/accounts/active", { method: "POST", body: JSON.stringify({ accountId: result.account.id }) });
  await refreshStatus(false);
  $("accountSelect").value = result.account.id;
});

bind("newAccountBtn", async () => {
  state.newAccountMode = true;
  $("accountLabel").value = "";
  $("apiId").value = "";
  $("apiHash").value = "";
  $("phone").value = "";
  $("otp").value = "";
  $("password").value = "";
  toast("Mode akun baru. Isi data akun kedua lalu klik Simpan akun.");
});

$("accountSelect").addEventListener("change", async () => {
  state.newAccountMode = false;
  state.selectedAccountId = $("accountSelect").value;
  await api("/api/accounts/active", { method: "POST", body: JSON.stringify({ accountId: activeAccountId() }) });
  await refreshStatus(false);
});

bind("sendOtpBtn", async () => {
  await api("/api/login/start", { method: "POST", body: JSON.stringify({ accountId: activeAccountId() }) });
  toast("OTP dikirim.");
});

bind("verifyOtpBtn", async () => {
  await api("/api/login/finish", { method: "POST", body: JSON.stringify({ accountId: activeAccountId(), code: $("otp").value, password: $("password").value }) });
  $("otp").value = "";
  $("password").value = "";
  toast("Login berhasil.");
  await refreshStatus(false);
});

bind("detectGroupsBtn", async () => {
  const accountId = activeAccountId();
  await api("/api/accounts/active", { method: "POST", body: JSON.stringify({ accountId }) });
  const started = await api(`/api/groups/detect?async=1&accountId=${encodeURIComponent(accountId)}`);
  toast("Detect grup dimulai di background.");
  const data = await waitJob(started.jobId, "Detect grup");
  state.detectedGroups = [
    ...state.detectedGroups.filter((item) => item.accountId !== accountId),
    ...(data.groups || [])
  ];
  toast(`${data.groups.length} grup terdeteksi dari ${activeAccount()?.label || "akun aktif"}.`);
  renderTargets();
});

bind("detectFoldersBtn", async () => {
  const accountId = activeAccountId();
  await api("/api/accounts/active", { method: "POST", body: JSON.stringify({ accountId }) });
  const started = await api(`/api/folders/detect?async=1&accountId=${encodeURIComponent(accountId)}`);
  toast("Detect folder dimulai di background.");
  const data = await waitJob(started.jobId, "Detect folder");
  state.detectedFolders = data.folders || [];
  state.selectedFolderId = state.detectedFolders[0]?.id || "";
  state.selectedFolderGroupKeys.clear();
  toast(`${state.detectedFolders.length} folder terdeteksi.`);
  renderFolders();
});

function mergeByKey(oldItems, newItems) {
  const map = new Map(oldItems.map((item) => [keyOf(item), item]));
  for (const item of newItems) map.set(keyOf(item), item);
  return Array.from(map.values());
}

bind("saveGroupsBtn", async () => {
  const savedMap = new Map((state.status.selectedGroups || []).map((item) => [keyOf(item), item]));
  const selected = state.detectedGroups
    .filter((item) => state.selectedGroupKeys.has(keyOf(item)))
    .map((item) => ({ ...savedMap.get(keyOf(item)), ...item }));
  await api("/api/groups/selected", { method: "POST", body: JSON.stringify({ groups: selected }) });
  toast(`${selected.length} grup disimpan.`);
  await refreshStatus();
});

bind("saveFolderGroupsBtn", async () => {
  const savedMap = new Map((state.status.selectedFolderGroups || []).map((item) => [keyOf(item), item]));
  const selected = (state.detectedFolders || [])
    .flatMap((folder) => folder.groups || [])
    .filter((item) => state.selectedFolderGroupKeys.has(keyOf(item)))
    .map((item) => ({ ...savedMap.get(keyOf(item)), ...item }));
  await api("/api/folders/selected", { method: "POST", body: JSON.stringify({ groups: selected }) });
  toast(`${selected.length} grup folder disimpan.`);
  await refreshStatus();
});

bind("detectAdminsBtn", async () => {
  const started = await api("/api/admins/detect?async=1");
  toast("Detect admin/owner dimulai di background.");
  const data = await waitJob(started.jobId, "Detect admin");
  state.detectedAdmins = data.admins || [];
  const failed = data.errors?.length ? `, ${data.errors.length} grup gagal` : "";
  toast(`${state.detectedAdmins.length} admin/owner terdeteksi${failed}.`);
  renderTargets();
});

bind("saveAdminsBtn", async () => {
  const savedMap = new Map((state.status.selectedAdmins || []).map((item) => [keyOf(item), item]));
  const selected = state.detectedAdmins
    .filter((item) => state.selectedAdminKeys.has(keyOf(item)))
    .map((item) => ({ ...savedMap.get(keyOf(item)), ...item }));
  await api("/api/admins/selected", { method: "POST", body: JSON.stringify({ admins: selected }) });
  toast(`${selected.length} admin/owner disimpan.`);
  await refreshStatus();
});

bind("selectAllGroupsBtn", async () => {
  for (const item of state.detectedGroups) state.selectedGroupKeys.add(keyOf(item));
  renderTargets();
});

bind("clearGroupsBtn", async () => {
  state.selectedGroupKeys.clear();
  renderTargets();
});

bind("selectAllFolderGroupsBtn", async () => {
  const folder = (state.detectedFolders || []).find((item) => item.id === $("folderSelect").value);
  for (const item of folder?.groups || []) state.selectedFolderGroupKeys.add(keyOf(item));
  renderFolders();
});

bind("clearFolderGroupsBtn", async () => {
  state.selectedFolderGroupKeys.clear();
  renderFolders();
});

bind("selectAllAdminsBtn", async () => {
  for (const item of state.detectedAdmins) state.selectedAdminKeys.add(keyOf(item));
  renderTargets();
});

bind("selectOwnersBtn", async () => {
  state.selectedAdminKeys.clear();
  for (const item of state.detectedAdmins) {
    if (String(item.role || "").toLowerCase() === "owner") state.selectedAdminKeys.add(keyOf(item));
  }
  renderTargets();
  toast(`${state.selectedAdminKeys.size} owner dicentang.`);
});

bind("clearAdminsBtn", async () => {
  state.selectedAdminKeys.clear();
  renderTargets();
});

bind("saveGroupSettingsBtn", async () => {
  await api("/api/settings/groups", {
    method: "POST",
    body: JSON.stringify({
      message: $("groupMessage").value,
      forwardLink: $("groupForwardLink").value,
      senderAccountId: $("groupSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("groupDefaultIntervalSeconds").value),
      delaySeconds: Number($("groupDelaySeconds").value),
      schedulerEnabled: $("groupSchedulerEnabled").checked,
      loopEnabled: $("groupLoopEnabled").checked,
      activityGateEnabled: $("groupActivityGateEnabled").checked,
      activityGateMinMessages: Number($("groupActivityGateMinMessages").value)
    })
  });
  toast("Setting grup disimpan.");
  await refreshStatus();
});

bind("saveFolderGroupSettingsBtn", async () => {
  await api("/api/settings/folder-groups", {
    method: "POST",
    body: JSON.stringify({
      message: $("folderGroupMessage").value,
      forwardLink: $("folderGroupForwardLink").value,
      senderAccountId: $("folderGroupSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("folderGroupDefaultIntervalSeconds").value),
      delaySeconds: Number($("folderGroupDelaySeconds").value),
      schedulerEnabled: $("folderGroupSchedulerEnabled").checked,
      loopEnabled: $("folderGroupLoopEnabled").checked,
      activityGateEnabled: $("folderGroupActivityGateEnabled").checked,
      activityGateMinMessages: Number($("folderGroupActivityGateMinMessages").value)
    })
  });
  toast("Setting folder disimpan.");
  await refreshStatus();
});

bind("saveAdminSettingsBtn", async () => {
  await api("/api/settings/admins", {
    method: "POST",
    body: JSON.stringify({
      message: $("adminMessage").value,
      senderAccountId: $("adminSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("adminDefaultIntervalSeconds").value),
      delaySeconds: Number($("adminDelaySeconds").value),
      schedulerEnabled: $("adminSchedulerEnabled").checked,
      loopEnabled: $("adminLoopEnabled").checked
    })
  });
  toast("Setting kontak disimpan.");
  await refreshStatus();
});

bind("saveSystemSettingsBtn", async () => {
  await api("/api/settings/system", {
    method: "POST",
    body: JSON.stringify({
      quietHoursEnabled: $("quietHoursEnabled").checked,
      quietHoursStart: $("quietHoursStart").value,
      quietHoursEnd: $("quietHoursEnd").value,
      networkRetrySeconds: Number($("networkRetrySeconds").value),
      reconnectWatchdogEnabled: $("reconnectWatchdogEnabled").checked
    })
  });
  toast("Mode HP disimpan.");
  await refreshStatus();
});

bind("saveTargetIntervalsBtn", async () => {
  await saveIntervals("groups");
  await saveIntervals("folderGroups");
  await saveIntervals("admins");
  state.intervalsDirty = false;
  toast("Interval target disimpan.");
  await refreshStatus();
});

async function saveIntervals(kind) {
  const rows = Array.from(document.querySelectorAll(`.intervalRow[data-kind="${kind}"]`));
  const source = kind === "admins" ? state.status.selectedAdmins : kind === "folderGroups" ? (state.status.selectedFolderGroups || []) : state.status.selectedGroups;
  const byKey = new Map(source.map((item) => [keyOf(item), item]));
  const targets = rows.map((row) => {
    const item = byKey.get(row.dataset.key);
    return {
      ...item,
      intervalSeconds: Number(row.querySelector(".intervalInput").value),
      enabled: row.querySelector(".enabledInput").checked,
      customMessage: row.querySelector(".customMessageInput")?.value || "",
      resetNextRun: true
    };
  });
  await api("/api/targets/update", { method: "POST", body: JSON.stringify({ kind, targets }) });
}

bind("sendGroupsNowBtn", async () => {
  if (state.intervalsDirty) {
    await saveIntervals("groups");
    await saveIntervals("folderGroups");
    await saveIntervals("admins");
    state.intervalsDirty = false;
  }
  await api("/api/settings/groups", {
    method: "POST",
    body: JSON.stringify({
      message: $("groupMessage").value,
      forwardLink: $("groupForwardLink").value,
      senderAccountId: $("groupSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("groupDefaultIntervalSeconds").value),
      delaySeconds: Number($("groupDelaySeconds").value),
      schedulerEnabled: $("groupSchedulerEnabled").checked,
      loopEnabled: $("groupLoopEnabled").checked,
      activityGateEnabled: $("groupActivityGateEnabled").checked,
      activityGateMinMessages: Number($("groupActivityGateMinMessages").value)
    })
  });
  const result = await api("/api/send-groups-now", { method: "POST", body: "{}" });
  toast(result.skipped ? result.message : result.message || "Pengiriman dimulai.");
  await refreshProgressOnly();
});

bind("sendFolderGroupsNowBtn", async () => {
  if (state.intervalsDirty) {
    await saveIntervals("groups");
    await saveIntervals("folderGroups");
    await saveIntervals("admins");
    state.intervalsDirty = false;
  }
  await api("/api/settings/folder-groups", {
    method: "POST",
    body: JSON.stringify({
      message: $("folderGroupMessage").value,
      forwardLink: $("folderGroupForwardLink").value,
      senderAccountId: $("folderGroupSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("folderGroupDefaultIntervalSeconds").value),
      delaySeconds: Number($("folderGroupDelaySeconds").value),
      schedulerEnabled: $("folderGroupSchedulerEnabled").checked,
      loopEnabled: $("folderGroupLoopEnabled").checked,
      activityGateEnabled: $("folderGroupActivityGateEnabled").checked,
      activityGateMinMessages: Number($("folderGroupActivityGateMinMessages").value)
    })
  });
  const result = await api("/api/send-folder-groups-now", { method: "POST", body: "{}" });
  toast(result.skipped ? result.message : result.message || "Pengiriman folder dimulai.");
  await refreshProgressOnly();
});

bind("sendAdminsNowBtn", async () => {
  if (state.intervalsDirty) {
    await saveIntervals("groups");
    await saveIntervals("folderGroups");
    await saveIntervals("admins");
    state.intervalsDirty = false;
  }
  await api("/api/settings/admins", {
    method: "POST",
    body: JSON.stringify({
      message: $("adminMessage").value,
      senderAccountId: $("adminSenderAccountSelect").value,
      defaultIntervalSeconds: Number($("adminDefaultIntervalSeconds").value),
      delaySeconds: Number($("adminDelaySeconds").value),
      schedulerEnabled: $("adminSchedulerEnabled").checked,
      loopEnabled: $("adminLoopEnabled").checked
    })
  });
  const result = await api("/api/send-admins-now", { method: "POST", body: "{}" });
  toast(result.skipped ? result.message : result.message || "Pengiriman kontak dimulai.");
  await refreshProgressOnly();
});

bind("stopSendBtn", async () => {
  const result = await api("/api/stop-send", { method: "POST", body: "{}" });
  $("groupSchedulerEnabled").checked = false;
  $("groupLoopEnabled").checked = false;
  $("folderGroupSchedulerEnabled").checked = false;
  $("folderGroupLoopEnabled").checked = false;
  $("adminSchedulerEnabled").checked = false;
  $("adminLoopEnabled").checked = false;
  toast(result.stopped ? "Stop diminta." : result.message);
  await refreshStatus();
});

bind("stopFolderGroupsBtn", async () => {
  const result = await api("/api/stop-send/folderGroups", { method: "POST", body: "{}" });
  $("folderGroupSchedulerEnabled").checked = false;
  $("folderGroupLoopEnabled").checked = false;
  toast(result.stopped ? "Stop folder diminta." : result.message);
  await refreshStatus();
});

bind("resetProgressBtn", async () => {
  const result = await api("/api/progress/reset", { method: "POST", body: "{}" });
  if (state.status) {
    state.status.selectedGroups = result.selectedGroups || [];
    state.status.selectedFolderGroups = result.selectedFolderGroups || [];
    state.status.selectedAdmins = result.selectedAdmins || [];
    state.status.lastStatus = result.lastStatus || "";
  }
  state.notifiedFailures.clear();
  toast("Progress blast direset.");
  await refreshStatus();
  renderProgress();
});

$("groupSearch").addEventListener("input", renderTargets);
$("folderSelect").addEventListener("change", () => {
  state.selectedFolderId = $("folderSelect").value;
  renderFolders();
});
$("folderGroupSearch").addEventListener("input", renderFolders);
$("adminSearch").addEventListener("input", renderTargets);
$("groupIntervals").addEventListener("input", () => { state.intervalsDirty = true; });
$("folderGroupIntervals").addEventListener("input", () => { state.intervalsDirty = true; });
$("adminIntervals").addEventListener("input", () => { state.intervalsDirty = true; });

initNavigation();
refreshStatus(false).catch((error) => toast(error.message));
setInterval(() => refreshProgressOnly().catch(() => {}), 3000);
setInterval(() => {
  if (state.status) renderProgress();
}, 1000);
setInterval(() => refreshStatus(true).catch(() => {}), 15000);
