const express = require("express");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const AVATARS_DIR = path.join(DATA_DIR, "avatars");
const DB_PATH = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(ROOT, "public");
const ACTIVITY_GATE_RECHECK_SECONDS = 600;
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

function loadEnvFile() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const defaultDb = {
  accounts: [],
  activeAccountId: "",
  knownGroups: [],
  selectedGroups: [],
  selectedFolderGroups: [],
  selectedAdmins: [],
  targetMode: "groups",
  senderAccountId: "target",
  groupSenderAccountId: "target",
  folderGroupSenderAccountId: "target",
  adminSenderAccountId: "target",
  message: "",
  groupMessage: "",
  groupForwardLink: "",
  folderGroupMessage: "",
  folderGroupForwardLink: "",
  adminMessage: "",
  adminForwardLink: "",
  defaultIntervalSeconds: 3600,
  groupDefaultIntervalSeconds: 3600,
  folderGroupDefaultIntervalSeconds: 3600,
  adminDefaultIntervalSeconds: 3600,
  delaySeconds: 1,
  groupDelaySeconds: 1,
  folderGroupDelaySeconds: 3,
  adminDelaySeconds: 1,
  schedulerEnabled: false,
  groupSchedulerEnabled: false,
  folderGroupSchedulerEnabled: false,
  adminSchedulerEnabled: false,
  groupLoopEnabled: false,
  folderGroupLoopEnabled: false,
  adminLoopEnabled: false,
  groupActivityGateEnabled: false,
  folderGroupActivityGateEnabled: false,
  groupActivityGateMinMessages: 10,
  folderGroupActivityGateMinMessages: 10,
  quietHoursEnabled: true,
  quietHoursStart: "02:50",
  quietHoursEnd: "03:20",
  reconnectWatchdogEnabled: true,
  networkRetrySeconds: 300,
  aiActivityAgentEnabled: true,
  groqModel: "llama-3.1-8b-instant",
  aiActivityAgentMargin: 5,
  isSendingLabel: "",
  lastStatus: "",
  sendLog: []
};

const clients = new Map();
const loginStates = new Map();
const authStatusCache = new Map();
const jobs = new Map();
const blastStates = {
  groups: { isSending: false, cancelRequested: false, currentBlast: null },
  folderGroups: { isSending: false, cancelRequested: false, currentBlast: null },
  admins: { isSending: false, cancelRequested: false, currentBlast: null }
};
let lastQuietNoticeAt = 0;
let quietWasActive = false;

function blastMode(mode) {
  if (mode === "folderGroups") return "folderGroups";
  return mode === "admins" ? "admins" : "groups";
}

function blastState(mode) {
  return blastStates[blastMode(mode)];
}

function anySending() {
  return blastStates.groups.isSending || blastStates.folderGroups.isSending || blastStates.admins.isSending;
}

function anyCancelRequested() {
  return blastStates.groups.cancelRequested || blastStates.folderGroups.cancelRequested || blastStates.admins.cancelRequested;
}

function primaryCurrentBlast() {
  return blastStates.groups.currentBlast || blastStates.folderGroups.currentBlast || blastStates.admins.currentBlast || null;
}

function stopAutomationForMode(db, mode) {
  const key = blastMode(mode);
  if (key === "folderGroups") {
    db.folderGroupSchedulerEnabled = false;
    db.folderGroupLoopEnabled = false;
    return "folder grup";
  }
  if (key === "admins") {
    db.adminSchedulerEnabled = false;
    db.adminLoopEnabled = false;
    return "kontak";
  }
  db.groupSchedulerEnabled = false;
  db.groupLoopEnabled = false;
  return "grup";
}

function wakeTargets(targets) {
  return (Array.isArray(targets) ? targets : []).map((target) => (
    target.enabled === false ? target : { ...target, nextRunAt: null }
  ));
}

function wakeActiveModesAfterQuiet(db, reason = "quiet hours selesai") {
  const touched = [];
  if (db.groupSchedulerEnabled || db.groupLoopEnabled) {
    db.selectedGroups = wakeTargets(db.selectedGroups);
    touched.push("grup");
  }
  if (db.folderGroupSchedulerEnabled || db.folderGroupLoopEnabled) {
    db.selectedFolderGroups = wakeTargets(db.selectedFolderGroups);
    touched.push("folder grup");
  }
  if (db.adminSchedulerEnabled || db.adminLoopEnabled) {
    db.selectedAdmins = wakeTargets(db.selectedAdmins);
    touched.push("kontak");
  }
  if (touched.length) {
    db.lastStatus = `${reason}: ${touched.join(", ")} dibangunkan untuk lanjut.`;
    addLog(db, db.lastStatus);
  }
  return touched;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function readDb() {
  const db = { ...structuredClone(defaultDb), ...readJson(DB_PATH, defaultDb) };
  db.accounts = Array.isArray(db.accounts) ? db.accounts : [];
  db.groupMessage = db.groupMessage ?? db.message ?? "";
  db.groupForwardLink = String(db.groupForwardLink || "");
  db.folderGroupMessage = db.folderGroupMessage ?? "";
  db.folderGroupForwardLink = String(db.folderGroupForwardLink || "");
  db.adminMessage = db.adminMessage ?? db.message ?? "";
  db.adminForwardLink = String(db.adminForwardLink || "");
  db.groupDefaultIntervalSeconds = Number(db.groupDefaultIntervalSeconds ?? db.defaultIntervalSeconds ?? 3600);
  db.folderGroupDefaultIntervalSeconds = Number(db.folderGroupDefaultIntervalSeconds ?? db.groupDefaultIntervalSeconds ?? db.defaultIntervalSeconds ?? 3600);
  db.adminDefaultIntervalSeconds = Number(db.adminDefaultIntervalSeconds ?? db.defaultIntervalSeconds ?? 3600);
  db.groupDelaySeconds = Number(db.groupDelaySeconds ?? db.delaySeconds ?? 1);
  db.folderGroupDelaySeconds = Number(db.folderGroupDelaySeconds ?? db.groupDelaySeconds ?? db.delaySeconds ?? 3);
  db.adminDelaySeconds = Number(db.adminDelaySeconds ?? db.delaySeconds ?? 1);
  db.groupSchedulerEnabled = Boolean(db.groupSchedulerEnabled ?? (db.schedulerEnabled && db.targetMode === "groups"));
  db.folderGroupSchedulerEnabled = Boolean(db.folderGroupSchedulerEnabled);
  db.adminSchedulerEnabled = Boolean(db.adminSchedulerEnabled ?? (db.schedulerEnabled && db.targetMode === "admins"));
  db.groupLoopEnabled = Boolean(db.groupLoopEnabled);
  db.folderGroupLoopEnabled = Boolean(db.folderGroupLoopEnabled);
  db.adminLoopEnabled = Boolean(db.adminLoopEnabled);
  db.groupActivityGateEnabled = Boolean(db.groupActivityGateEnabled);
  db.folderGroupActivityGateEnabled = Boolean(db.folderGroupActivityGateEnabled);
  db.groupActivityGateMinMessages = Math.max(1, Math.min(50, Number(db.groupActivityGateMinMessages || db.activityGateMinMessages || 10)));
  db.folderGroupActivityGateMinMessages = Math.max(1, Math.min(50, Number(db.folderGroupActivityGateMinMessages || db.activityGateMinMessages || 10)));
  db.quietHoursEnabled = Boolean(db.quietHoursEnabled);
  db.quietHoursStart = normalizeClock(db.quietHoursStart || "02:50");
  db.quietHoursEnd = normalizeClock(db.quietHoursEnd || "03:20");
  db.reconnectWatchdogEnabled = db.reconnectWatchdogEnabled !== false;
  db.networkRetrySeconds = Math.max(30, Number(db.networkRetrySeconds || 300));
  db.aiActivityAgentEnabled = db.aiActivityAgentEnabled !== false;
  db.groqModel = String(db.groqModel || "llama-3.1-8b-instant").trim();
  db.aiActivityAgentMargin = Math.max(0, Math.min(20, Number(db.aiActivityAgentMargin || 5)));
  if (!db.activeAccountId && db.accounts.length) db.activeAccountId = db.accounts[0].id;
  db.knownGroups = normalizeTargets(db.knownGroups, db);
  db.selectedGroups = normalizeTargets(db.selectedGroups, db);
  db.selectedFolderGroups = normalizeTargets(db.selectedFolderGroups, db);
  db.selectedAdmins = normalizeTargets(db.selectedAdmins, db);
  return db;
}

function normalizeClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return "00:00";
  const hour = Math.min(23, Math.max(0, Number(match[1]) || 0));
  const minute = Math.min(59, Math.max(0, Number(match[2]) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockMinutes(value) {
  const [hour, minute] = normalizeClock(value).split(":").map(Number);
  return hour * 60 + minute;
}

function minutesNow(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function isQuietHoursActive(db, date = new Date()) {
  if (!db.quietHoursEnabled) return false;
  const start = clockMinutes(db.quietHoursStart);
  const end = clockMinutes(db.quietHoursEnd);
  const now = minutesNow(date);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function secondsUntilQuietHoursEnd(db, date = new Date()) {
  if (!isQuietHoursActive(db, date)) return 0;
  const end = clockMinutes(db.quietHoursEnd);
  const now = minutesNow(date);
  const diffMinutes = end > now ? end - now : (24 * 60 - now) + end;
  return Math.max(30, diffMinutes * 60);
}

function noteQuietPause(source = "jadwal") {
  const db = readDb();
  if (!isQuietHoursActive(db)) return false;
  if (Date.now() - lastQuietNoticeAt > 60000) {
    const seconds = secondsUntilQuietHoursEnd(db);
    db.lastStatus = `${source}: pause quiet hours sampai ${db.quietHoursEnd} (${Math.ceil(seconds / 60)} menit).`;
    addLog(db, db.lastStatus);
    saveDb(db);
    lastQuietNoticeAt = Date.now();
  }
  return true;
}

function normalizeTargets(targets, db) {
  return (Array.isArray(targets) ? targets : []).map((target) => ({
    ...target,
    accountId: target.accountId || db.activeAccountId || "",
    intervalSeconds: Math.max(5, Number(target.intervalSeconds || db.defaultIntervalSeconds || 3600)),
    enabled: target.enabled !== false,
    nextRunAt: target.nextRunAt || null,
    lastRunAt: target.lastRunAt || null,
    lastMessageId: target.lastMessageId || null,
    lastStatus: target.lastStatus || "",
    customMessage: target.customMessage || "",
    activityGateEnabled: typeof target.activityGateEnabled === "boolean" ? target.activityGateEnabled : null,
    activityGateMinMessages: target.activityGateMinMessages ? Math.max(1, Math.min(50, Number(target.activityGateMinMessages))) : null
  }));
}

function addLog(db, text) {
  db.sendLog.unshift({ at: new Date().toISOString(), text });
  db.sendLog = db.sendLog.slice(0, 80);
}

function accountIdFromPhone(phone) {
  const cleaned = String(phone || "").replace(/[^0-9]/g, "");
  return cleaned ? `acc_${cleaned}` : `acc_${Date.now()}`;
}

function createJob(label, runner) {
  const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  jobs.set(id, { id, label, status: "running", startedAt: new Date().toISOString(), result: null, error: "" });
  Promise.resolve()
    .then(runner)
    .then((result) => {
      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, status: "done", result, finishedAt: new Date().toISOString() });
    })
    .catch((error) => {
      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, status: "error", error: error.message || String(error), finishedAt: new Date().toISOString() });
    });
  return jobs.get(id);
}

function sessionPath(accountId) {
  return path.join(SESSIONS_DIR, `${String(accountId).replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
}

function safeFileId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function avatarPath(accountId) {
  return path.join(AVATARS_DIR, `${safeFileId(accountId)}.jpg`);
}

function avatarUrl(accountId) {
  return fs.existsSync(avatarPath(accountId)) ? `/avatars/${safeFileId(accountId)}.jpg` : "";
}

function readSession(accountId) {
  try {
    return fs.readFileSync(sessionPath(accountId), "utf8").trim();
  } catch {
    return "";
  }
}

function saveSession(accountId, value) {
  fs.writeFileSync(sessionPath(accountId), value || "");
}

function getAccount(accountId) {
  const db = readDb();
  const id = accountId || db.activeAccountId;
  const account = db.accounts.find((item) => item.id === id);
  if (!account) throw new Error("Akun belum dipilih / belum ada.");
  if (!Number(account.apiId) || !account.apiHash) throw new Error("API ID / API Hash akun belum lengkap.");
  return account;
}

async function getClient(accountId) {
  const account = getAccount(accountId);
  if (!clients.has(account.id)) {
    const client = new TelegramClient(
      new StringSession(readSession(account.id)),
      Number(account.apiId),
      account.apiHash,
      { connectionRetries: 5 }
    );
    client.setLogLevel("error");
    clients.set(account.id, client);
  }
  const client = clients.get(account.id);
  if (!client.connected) await client.connect();
  return client;
}

async function ensureAuthorizedClient(accountId) {
  const client = await getClient(accountId);
  try {
    if (await client.isUserAuthorized()) return client;
  } catch {
    try {
      if (client.connected) await client.disconnect();
    } catch {}
    await client.connect();
    if (await client.isUserAuthorized()) return client;
  }
  throw new Error("Akun belum login.");
}

async function accountAuthorized(accountId) {
  try {
    await ensureAuthorizedClient(accountId);
    return true;
  } catch {
    return false;
  }
}

async function refreshAccountProfile(accountId) {
  try {
    if (fs.existsSync(avatarPath(accountId))) return;
    const client = await getClient(accountId);
    if (!(await client.isUserAuthorized())) return;
    const me = await client.getMe();
    try {
      await client.downloadProfilePhoto("me", { file: avatarPath(accountId) });
    } catch {}
    const db = readDb();
    const account = db.accounts.find((item) => item.id === accountId);
    if (account) {
      account.displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || account.label;
      account.username = me.username ? `@${me.username}` : "";
      account.avatarUrl = avatarUrl(accountId);
      saveDb(db);
    }
  } catch {}
}

function cachedAccountAuthorized(accountId) {
  const cached = authStatusCache.get(accountId);
  if (cached && Date.now() - cached.at < 60000) return cached.authorized;
  accountAuthorized(accountId)
    .then((authorized) => authStatusCache.set(accountId, { authorized, at: Date.now() }))
    .catch(() => authStatusCache.set(accountId, { authorized: false, at: Date.now() }));
  return cached?.authorized || false;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function asInputPeerId(entity) {
  if (!entity || !entity.className) return null;
  if (entity.className === "Chat") return `chat:${entity.id.toString()}`;
  if (entity.className === "Channel") {
    return `channel:${entity.id.toString()}:${entity.accessHash ? entity.accessHash.toString() : ""}`;
  }
  return null;
}

function displayGroup(entity, account) {
  const id = asInputPeerId(entity);
  if (!id) return null;
  return {
    id,
    accountId: account.id,
    accountLabel: account.label,
    title: entity.title || entity.username || id,
    username: entity.username ? `@${entity.username}` : "",
    type: entity.className === "Channel" ? (entity.megagroup ? "Supergroup" : "Channel") : "Group"
  };
}

function textValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.text) return String(value.text);
  return String(value);
}

function peerFromId(id) {
  const parts = String(id).split(":");
  if (parts[0] === "chat") return new Api.InputPeerChat({ chatId: BigInt(parts[1]) });
  if (parts[0] === "channel") {
    return new Api.InputPeerChannel({ channelId: BigInt(parts[1]), accessHash: BigInt(parts[2] || 0) });
  }
  if (parts[0] === "user") {
    return new Api.InputPeerUser({ userId: BigInt(parts[1]), accessHash: BigInt(parts[2] || 0) });
  }
  throw new Error(`Format target tidak dikenal: ${id}`);
}

function peerForSender(target, senderAccountId) {
  if (senderAccountId !== target.accountId) {
    if (target.username) return target.username;
    throw new Error("Target tidak punya username publik. Detect/simpan target ini dari akun pengirim, atau pakai target publik.");
  }
  return peerFromId(target.id);
}

function parseTelegramMessageLink(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^https?:\/\/(www\.)?t\.me\//i, "").replace(/^tg:\/\/resolve\?domain=/i, "");
  const clean = normalized.split("?")[0].replace(/^@/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] === "s") parts.shift();
  if (parts[0] === "c" && parts.length >= 3) {
    return { fromPeer: Number(`-100${parts[1]}`), messageId: Number(parts[2]) };
  }
  if (parts.length >= 2) {
    const messageId = Number(parts[1]);
    if (Number.isFinite(messageId) && messageId > 0) return { fromPeer: `@${parts[0]}`, messageId };
  }
  throw new Error("Link forward channel tidak valid. Pakai format https://t.me/nama_channel/123.");
}

function inputChannelFromGroupId(id) {
  const parts = String(id).split(":");
  if (parts[0] !== "channel") throw new Error("Bukan supergroup/channel.");
  return new Api.InputChannel({ channelId: BigInt(parts[1]), accessHash: BigInt(parts[2] || 0) });
}

function groupIdFromInputPeer(peer) {
  if (!peer?.className) return "";
  if (peer.className === "InputPeerChat") return `chat:${peer.chatId?.toString()}`;
  if (peer.className === "InputPeerChannel") return `channel:${peer.channelId?.toString()}:${peer.accessHash ? peer.accessHash.toString() : ""}`;
  return "";
}

function groupBaseId(id) {
  const parts = String(id || "").split(":");
  if (parts[0] === "channel") return `channel:${parts[1]}`;
  if (parts[0] === "chat") return `chat:${parts[1]}`;
  return String(id || "");
}

async function displayGroupFromInputPeer(client, peer, account, knownMap) {
  const id = groupIdFromInputPeer(peer);
  if (id && knownMap.has(id)) {
    const known = knownMap.get(id);
    return known?.type === "Group" || known?.type === "Supergroup" ? known : null;
  }
  const baseId = groupBaseId(id);
  if (baseId && knownMap.has(baseId)) {
    const known = knownMap.get(baseId);
    return known?.type === "Group" || known?.type === "Supergroup" ? known : null;
  }
  try {
    const entity = await client.getEntity(peer);
    if (entity?.className === "Channel" && !entity.megagroup) return null;
    return displayGroup(entity, account);
  } catch {
    if (!id) return null;
    return {
      id,
      accountId: account.id,
      accountLabel: account.label,
      title: id,
      username: "",
      type: id.startsWith("channel:") ? "Supergroup/Channel" : "Group"
    };
  }
}

function displayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.id.toString();
}

function roleName(participant) {
  const name = participant.className || "";
  if (name.includes("Creator")) return "Owner";
  return "Admin";
}

function adminRecord(user, participant, group) {
  if (user?.bot) return null;
  if (!user || !user.accessHash) return null;
  return {
    id: `user:${user.id.toString()}:${user.accessHash.toString()}`,
    userId: user.id.toString(),
    accountId: group.accountId,
    accountLabel: group.accountLabel,
    name: displayName(user),
    username: user.username ? `@${user.username}` : "",
    role: roleName(participant),
    isBot: false,
    sourceGroups: [group.title]
  };
}

function describeTelegramError(error) {
  const raw = String(error?.errorMessage || error?.message || error || "Unknown error");
  const upper = raw.toUpperCase();
  if (upper.includes("FLOOD_WAIT")) {
    const seconds = raw.match(/\d+/)?.[0];
    return seconds ? `Kena limit Telegram. Tunggu sekitar ${seconds} detik.` : "Kena limit Telegram. Tunggu beberapa saat.";
  }
  if (upper.includes("PEER_FLOOD")) return "Kena limit anti-spam Telegram. Kurangi jumlah target atau jeda kirim.";
  if (upper.includes("USER_PRIVACY_RESTRICTED")) return "Gagal karena privacy user menolak DM dari akun ini.";
  if (upper.includes("USER_IS_BLOCKED")) return "Gagal karena user memblokir akun pengirim.";
  if (upper.includes("CHAT_WRITE_FORBIDDEN")) return "Gagal karena akun pengirim tidak punya izin menulis ke target.";
  if (upper.includes("CHANNEL_PRIVATE")) return "Gagal karena target private atau akun pengirim belum punya akses.";
  if (upper.includes("INPUT_USER_DEACTIVATED")) return "Gagal karena akun target sudah tidak aktif.";
  if (upper.includes("USER_BOT") || upper.includes("BOT")) return "Target terdeteksi bot, dilewati.";
  if (upper.includes("ENOTFOUND") || upper.includes("EAI_AGAIN") || upper.includes("ETIMEDOUT")) return "Internet/DNS putus atau lambat. Target masuk pending retry.";
  if (upper.includes("ECONNRESET") || upper.includes("ECONNREFUSED")) return "Koneksi Telegram putus. Target masuk pending retry.";
  if (upper.includes("TIMEOUT") || upper.includes("NETWORK") || upper.includes("CONNECTION")) return "Koneksi Telegram bermasalah. Target masuk pending retry.";
  if (upper.includes("AUTH_KEY") || upper.includes("SESSION") || upper.includes("AUTH")) return "Session/login akun pengirim bermasalah. Login ulang akun.";
  if (upper.includes("AKUN BELUM LOGIN")) return "Akun pengirim belum login.";
  return raw;
}

function floodWaitSeconds(error) {
  const raw = String(error?.errorMessage || error?.message || error || "");
  const match = raw.match(/FLOOD_WAIT_?(\d+)/i) || raw.match(/wait of (\d+) seconds/i);
  return match ? Number(match[1]) : 0;
}

function isRetryableSendError(error) {
  const raw = String(error?.errorMessage || error?.message || error || "").toUpperCase();
  if (floodWaitSeconds(error) > 0) return true;
  if (raw.includes("PEER_FLOOD")) return true;
  if (raw.includes("TIMEOUT")) return true;
  if (raw.includes("ECONNRESET") || raw.includes("ETIMEDOUT") || raw.includes("ECONNREFUSED")) return true;
  if (raw.includes("CONNECTION") || raw.includes("NETWORK")) return true;
  if (raw.includes("INTERNAL") || raw.includes("SERVER")) return true;
  if (raw.includes("500")) return true;
  return false;
}

function isNetworkSendError(error) {
  const raw = String(error?.errorMessage || error?.message || error || "").toUpperCase();
  return raw.includes("TIMEOUT")
    || raw.includes("ECONNRESET")
    || raw.includes("ETIMEDOUT")
    || raw.includes("ECONNREFUSED")
    || raw.includes("ENOTFOUND")
    || raw.includes("EAI_AGAIN")
    || raw.includes("CONNECTION")
    || raw.includes("NETWORK");
}

function retryDelaySeconds(error, db) {
  const wait = floodWaitSeconds(error);
  if (wait > 0) return wait + 5;
  if (String(error?.errorMessage || error?.message || "").toUpperCase().includes("PEER_FLOOD")) return 120;
  if (isNetworkSendError(error)) return Math.max(30, Number(db.networkRetrySeconds || 300));
  return Math.max(30, Number(db.networkRetrySeconds || 300));
}

async function waitAfterSendError(error, normalDelaySeconds, mode) {
  const state = blastState(mode);
  const waitSeconds = floodWaitSeconds(error);
  if (waitSeconds > 0) {
    const waitWithBuffer = waitSeconds + 5;
    const fresh = readDb();
    fresh.lastStatus = `Kena limit Telegram. Pause ${waitWithBuffer} detik sebelum lanjut.`;
    addLog(fresh, fresh.lastStatus);
    saveDb(fresh);
    if (state.currentBlast) state.currentBlast = { ...state.currentBlast, status: fresh.lastStatus };
    await adaptiveDelay(0, waitWithBuffer, mode);
    return;
  }
  if (String(error?.errorMessage || error?.message || "").toUpperCase().includes("PEER_FLOOD")) {
    const waitWithBuffer = 120;
    const fresh = readDb();
    fresh.lastStatus = `Kena limit anti-spam Telegram. Pause ${waitWithBuffer} detik sebelum lanjut.`;
    addLog(fresh, fresh.lastStatus);
    saveDb(fresh);
    if (state.currentBlast) state.currentBlast = { ...state.currentBlast, status: fresh.lastStatus };
    await adaptiveDelay(0, waitWithBuffer, mode);
    return;
  }
  await adaptiveDelay(normalDelaySeconds, 0, mode);
}

async function detectGroups(accountId) {
  const account = getAccount(accountId);
  const client = await ensureAuthorizedClient(account.id);
  const dialogs = await client.getDialogs({ limit: 500 });
  const groups = [];
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    const ok = entity && (entity.className === "Chat" || (entity.className === "Channel" && (entity.megagroup || entity.broadcast)));
    if (!ok) continue;
    const item = displayGroup(entity, account);
    if (item) groups.push({ ...item, dialogFolderId: dialog.folderId ? String(dialog.folderId) : "" });
  }
  return groups.sort((a, b) => a.title.localeCompare(b.title));
}

async function detectFolders(accountId) {
  const account = getAccount(accountId);
  const client = await ensureAuthorizedClient(account.id);
  const db = readDb();
  const knownMap = new Map();
  for (const group of db.knownGroups.filter((item) => item.accountId === account.id)) {
    knownMap.set(group.id, group);
    knownMap.set(groupBaseId(group.id), group);
  }
  const allGroups = await detectGroups(account.id);
  for (const group of allGroups) {
    knownMap.set(group.id, group);
    knownMap.set(groupBaseId(group.id), group);
  }
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folders = [];

  for (const filter of result.filters || []) {
    if (!filter || filter.className === "DialogFilterDefault") continue;
    const groups = new Map();
    const addGroup = (group) => {
      if (group) groups.set(`${group.accountId}:${group.id}`, group);
    };

    const peers = [
      ...(filter.pinnedPeers || []),
      ...(filter.includePeers || [])
    ];
    for (const peer of peers) {
      addGroup(await displayGroupFromInputPeer(client, peer, account, knownMap));
    }

    for (const group of allGroups) {
      if (String(group.dialogFolderId || "") === String(filter.id)) addGroup(group);
    }

    if (filter.groups) {
      for (const group of allGroups) {
        if (group.type === "Group" || group.type === "Supergroup") addGroup(group);
      }
    }

    const excludeIds = new Set((filter.excludePeers || []).map(groupIdFromInputPeer).filter(Boolean));
    const excludeBaseIds = new Set(Array.from(excludeIds).map(groupBaseId));
    const folderGroups = Array.from(groups.values())
      .filter((group) => !excludeIds.has(group.id) && !excludeBaseIds.has(groupBaseId(group.id)))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((group) => ({
        ...group,
        folderId: String(filter.id),
        folderTitle: textValue(filter.title) || `Folder ${filter.id}`
      }));

    folders.push({
      id: String(filter.id),
      title: textValue(filter.title) || `Folder ${filter.id}`,
      totalGroups: folderGroups.length,
      groups: folderGroups
    });
  }

  return folders;
}

async function detectAdminsForGroup(client, group) {
  const parts = String(group.id).split(":");
  const admins = [];
  if (parts[0] === "channel") {
    const result = await client.invoke(new Api.channels.GetParticipants({
      channel: inputChannelFromGroupId(group.id),
      filter: new Api.ChannelParticipantsAdmins(),
      offset: 0,
      limit: 200,
      hash: BigInt(0)
    }));
    const users = new Map((result.users || []).map((user) => [user.id.toString(), user]));
    for (const participant of result.participants || []) {
      const user = users.get(participant.userId?.toString());
      const record = adminRecord(user, participant, group);
      if (record) admins.push(record);
    }
  } else if (parts[0] === "chat") {
    const result = await client.invoke(new Api.messages.GetFullChat({ chatId: BigInt(parts[1]) }));
    const users = new Map((result.users || []).map((user) => [user.id.toString(), user]));
    const participants = result.fullChat?.participants?.participants || [];
    for (const participant of participants) {
      const className = participant.className || "";
      if (!className.includes("Creator") && !className.includes("Admin")) continue;
      const user = users.get(participant.userId?.toString());
      const record = adminRecord(user, participant, group);
      if (record) admins.push(record);
    }
  }
  return admins;
}

async function detectAdmins() {
  const db = readDb();
  const sourceGroups = db.knownGroups.length ? db.knownGroups : db.selectedGroups;
  if (!sourceGroups.length) throw new Error("Detect grup dulu supaya sumber admin tersedia.");
  const byKey = new Map();
  const errors = [];
  for (const group of sourceGroups) {
    try {
      const client = await ensureAuthorizedClient(group.accountId);
      const admins = await detectAdminsForGroup(client, group);
      for (const admin of admins) {
        const key = `${admin.accountId}:${admin.userId}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.sourceGroups.push(...admin.sourceGroups);
          if (admin.role === "Owner") existing.role = "Owner";
        } else {
          byKey.set(key, admin);
        }
      }
    } catch (error) {
      errors.push(`${group.title}: ${error.errorMessage || error.message}`);
    }
  }
  return { admins: Array.from(byKey.values()), errors };
}

function mergeTargets(existing, incoming) {
  const map = new Map((existing || []).map((item) => [`${item.accountId}:${item.id}`, item]));
  for (const item of incoming || []) {
    map.set(`${item.accountId}:${item.id}`, { ...map.get(`${item.accountId}:${item.id}`), ...item });
  }
  return Array.from(map.values());
}

function dueTargets(db, manual = false, mode = db.targetMode) {
  const list = mode === "admins" ? db.selectedAdmins : mode === "folderGroups" ? db.selectedFolderGroups : db.selectedGroups;
  const now = Date.now();
  return list.filter((target) => {
    if (target.enabled === false) return false;
    if (manual) {
      const looping = mode === "admins" ? db.adminLoopEnabled : mode === "folderGroups" ? db.folderGroupLoopEnabled : db.groupLoopEnabled;
      return looping || !String(target.lastStatus || "").startsWith("OK");
    }
    return !target.nextRunAt || new Date(target.nextRunAt).getTime() <= now;
  });
}

function secondsUntilNextTarget(db, mode) {
  const list = mode === "admins" ? db.selectedAdmins : mode === "folderGroups" ? db.selectedFolderGroups : db.selectedGroups;
  const now = Date.now();
  const times = list
    .filter((target) => target.enabled !== false && target.nextRunAt)
    .map((target) => new Date(target.nextRunAt).getTime())
    .filter((time) => Number.isFinite(time) && time > now);
  if (!times.length) return 5;
  return Math.max(1, Math.ceil((Math.min(...times) - now) / 1000));
}

function modeConfig(db, mode) {
  const isAdmins = mode === "admins";
  const isFolderGroups = mode === "folderGroups";
  return {
    mode,
    targetType: isAdmins ? "selectedAdmins" : isFolderGroups ? "selectedFolderGroups" : "selectedGroups",
    label: isAdmins ? "kontak/admin" : isFolderGroups ? "folder grup" : "grup",
    message: isAdmins
      ? (db.adminMessage || db.message || "")
      : isFolderGroups
        ? (db.folderGroupMessage || "")
        : (db.groupMessage || db.message || ""),
    forwardLink: isAdmins
      ? String(db.adminForwardLink || "")
      : isFolderGroups
        ? String(db.folderGroupForwardLink || "")
        : String(db.groupForwardLink || ""),
    delaySeconds: isAdmins ? db.adminDelaySeconds : isFolderGroups ? db.folderGroupDelaySeconds : db.groupDelaySeconds,
    loopEnabled: isAdmins ? db.adminLoopEnabled : isFolderGroups ? db.folderGroupLoopEnabled : db.groupLoopEnabled,
    senderAccountId: isAdmins
      ? (db.adminSenderAccountId || db.senderAccountId || "target")
      : isFolderGroups
        ? (db.folderGroupSenderAccountId || db.groupSenderAccountId || db.senderAccountId || "target")
      : (db.groupSenderAccountId || db.senderAccountId || "target"),
    activityGateEnabled: !isAdmins && (isFolderGroups ? db.folderGroupActivityGateEnabled : db.groupActivityGateEnabled),
    activityGateMinMessages: isFolderGroups
      ? Math.max(1, Math.min(50, Number(db.folderGroupActivityGateMinMessages || 10)))
      : Math.max(1, Math.min(50, Number(db.groupActivityGateMinMessages || 10))),
    aiActivityAgentEnabled: Boolean(db.aiActivityAgentEnabled && process.env.GROQ_API_KEY),
    groqApiKey: process.env.GROQ_API_KEY || "",
    groqModel: db.groqModel,
    aiActivityAgentMargin: db.aiActivityAgentMargin
  };
}

function targetPayloadReady(target, config) {
  if (config.mode === "admins") return Boolean(String(config.forwardLink || "").trim() || String(config.message || "").trim());
  return Boolean(String(target.customMessage || "").trim() || String(config.forwardLink || "").trim() || String(config.message || "").trim());
}

function telegramDateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 100000000000 ? numeric : numeric * 1000;
}

function targetLastRunMs(target) {
  const value = new Date(target.lastRunAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function messagePreview(message) {
  return {
    id: Number(message.id || 0),
    out: Boolean(message.out),
    viaBot: Boolean(message.viaBotId),
    action: Boolean(message.action),
    date: message.date ? new Date(telegramDateMs(message.date)).toISOString() : "",
    text: String(message.message || "").slice(0, 120)
  };
}

function parseAiJson(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function groqActivityReview(config, target, messages, deterministicCount, minMessages) {
  if (!config.aiActivityAgentEnabled || !config.groqApiKey) return null;
  if (deterministicCount < Math.max(0, minMessages - Number(config.aiActivityAgentMargin || 0))) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const body = {
      model: config.groqModel || "llama-3.1-8b-instant",
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: "You are a lightweight validator for Telegram activity gates. Return only JSON."
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Decide if this group is active enough to allow the next blast. Count ordinary chat messages after the sender's last blast. Ignore pure service/action events. Bot/forwarded-looking messages still count only if they look like normal chat activity.",
            target: target.title || target.name || target.id,
            minimum: minMessages,
            deterministicCount,
            messages: messages.slice(0, 60).map(messagePreview),
            output: { allow: "boolean", validNewMessages: "number", reason: "short Indonesian reason" }
          })
        }
      ]
    };
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = parseAiJson(data?.choices?.[0]?.message?.content);
    if (!parsed) return null;
    const validNewMessages = Math.max(0, Number(parsed.validNewMessages || 0));
    return {
      allowed: Boolean(parsed.allow) || validNewMessages >= minMessages,
      newMessages: validNewMessages,
      reason: String(parsed.reason || "AI activity review")
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkActivityGate(client, target, senderAccountId, config) {
  if (!config.activityGateEnabled) return { allowed: true };
  const targetGateEnabled = target.activityGateEnabled !== false;
  if (!targetGateEnabled || config.mode === "admins") return { allowed: true };
  const lastRunAt = targetLastRunMs(target);
  const lastMessageId = Number(target.lastMessageId || 0);
  if (!lastRunAt && !lastMessageId) return { allowed: true };

  const minMessages = Math.max(1, Math.min(50, Number(target.activityGateMinMessages || config.activityGateMinMessages || 10)));
  const peer = peerForSender(target, senderAccountId);
  const limit = Math.max(80, Math.min(200, minMessages + 80));
  const messages = await client.getMessages(peer, { limit });
  let newMessages = 0;
  let latestAt = 0;
  const candidateMessages = [];

  for (const message of messages || []) {
    const messageId = Number(message.id || 0);
    if (lastMessageId) {
      if (!messageId || messageId <= lastMessageId) continue;
    } else {
      const at = telegramDateMs(message.date);
      if (!at || at <= lastRunAt) continue;
      latestAt = Math.max(latestAt, at);
    }
    if (message.className !== "Message" || message.action) continue;
    const at = telegramDateMs(message.date);
    latestAt = Math.max(latestAt, at);
    candidateMessages.push(message);
    newMessages += 1;
  }

  const aiReview = newMessages < minMessages
    ? await groqActivityReview(config, target, candidateMessages, newMessages, minMessages)
    : null;
  const finalMessages = aiReview?.newMessages ?? newMessages;
  const allowed = newMessages >= minMessages || aiReview?.allowed;
  return {
    allowed,
    newMessages: finalMessages,
    latestAt,
    minMessages,
    reason: allowed ? "" : `WAIT_ACTIVITY: ${finalMessages}/${minMessages} chat baru setelah blast terakhir${aiReview ? " (AI)" : ""}`,
    aiUsed: Boolean(aiReview)
  };
}

function sentMessageMeta(result) {
  const queue = Array.isArray(result) ? [...result] : [result];
  while (queue.length) {
    const item = queue.shift();
    if (!item) continue;
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    if (item.id) return { id: String(item.id), date: item.date ? new Date(telegramDateMs(item.date)).toISOString() : "" };
    if (Array.isArray(item.updates)) queue.push(...item.updates);
  }
  return { id: "", date: "" };
}

async function sendTargetPayload(client, target, senderAccountId, config) {
  const peer = peerForSender(target, senderAccountId);
  const customMessage = String(target.customMessage || "").trim();
  if (config.mode !== "admins" && customMessage) {
    const sent = await client.sendMessage(peer, { message: customMessage });
    return { type: "teks custom", ...sentMessageMeta(sent) };
  }
  if (String(config.forwardLink || "").trim()) {
    const forward = parseTelegramMessageLink(config.forwardLink);
    const sent = await client.forwardMessages(peer, { messages: forward.messageId, fromPeer: forward.fromPeer });
    return { type: "forward channel", ...sentMessageMeta(sent) };
  }
  const sent = await client.sendMessage(peer, { message: config.message });
  return { type: "teks default", ...sentMessageMeta(sent) };
}

async function cancellableDelay(seconds, mode = "groups") {
  const endAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  while (Date.now() < endAt) {
    if (blastState(mode).cancelRequested) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, endAt - Date.now())));
  }
}

async function adaptiveDelay(baseSeconds, extraSeconds = 0, mode = "groups") {
  const jitterMs = Math.floor(Math.random() * 900);
  await cancellableDelay(Math.max(0, Number(baseSeconds) || 0) + Math.max(0, Number(extraSeconds) || 0) + jitterMs / 1000, mode);
}

async function waitForQuietWindow(mode, source) {
  while (true) {
    const db = readDb();
    if (!isQuietHoursActive(db)) return;
    const seconds = secondsUntilQuietHoursEnd(db);
    noteQuietPause(source);
    const state = blastState(mode);
    if (state.currentBlast) {
      state.currentBlast = {
        ...state.currentBlast,
        status: `Pause quiet hours sampai ${db.quietHoursEnd}`,
        finishedAt: new Date().toISOString()
      };
    }
    await cancellableDelay(Math.min(seconds, 5), mode);
    if (state.cancelRequested) return;
  }
}

function saveTargetProgress(targetType, target, statusText) {
  const fresh = readDb();
  const key = `${target.accountId}:${target.id}`;
  fresh[targetType] = fresh[targetType].map((item) => (`${item.accountId}:${item.id}` === key ? { ...item, ...target } : item));
  if (statusText) fresh.lastStatus = statusText;
  saveDb(fresh);
}

function accountPublicInfo(accountId) {
  const db = readDb();
  const account = db.accounts.find((item) => item.id === accountId);
  if (!account) return { id: accountId, label: accountId, phone: "", avatarUrl: "" };
  return {
    id: account.id,
    label: account.label,
    phone: account.phone,
    displayName: account.displayName || account.label,
    username: account.username || "",
    avatarUrl: account.avatarUrl || avatarUrl(account.id)
  };
}

async function sendTargets(source, manual = false, forcedMode = null) {
  const initialDb = readDb();
  const mode = forcedMode || initialDb.targetMode;
  const state = blastState(mode);
  if (state.isSending) return { skipped: true, message: `Pengiriman ${mode === "admins" ? "kontak" : "grup"} sedang berjalan.` };
  state.isSending = true;
  state.cancelRequested = false;
  let totalSent = 0;
  const errors = [];
  let cancelled = false;
  try {
    let firstPass = true;
    const processedManualKeys = new Set();
    while (!state.cancelRequested) {
      const db = readDb();
      const config = modeConfig(db, mode);
      const targetType = config.targetType;
      const label = config.label;
      const sendDelaySeconds = config.delaySeconds;
      const manualBatch = manual && firstPass;
      let targets = dueTargets(db, manualBatch, mode);
      if (manual && !config.loopEnabled) {
        targets = targets.filter((target) => !processedManualKeys.has(`${target.accountId}:${target.id}`));
      }

      if (!targets.length) {
        if (manual && !config.loopEnabled && processedManualKeys.size) break;
        if (manual && config.loopEnabled) {
          const waitSeconds = Math.min(secondsUntilNextTarget(db, mode), 30);
          const senderInfo = accountPublicInfo(config.senderAccountId === "target" ? db.activeAccountId : config.senderAccountId);
          state.currentBlast = {
            isSending: true,
            source,
            targetMode: mode,
            senderAccountId: senderInfo.id,
            senderLabel: senderInfo.label,
            senderPhone: senderInfo.phone,
            senderDisplayName: senderInfo.displayName,
            senderUsername: senderInfo.username,
            senderAvatarUrl: senderInfo.avatarUrl,
            targetName: "Menunggu interval",
            targetUsername: "",
            startedAt: new Date().toISOString(),
            status: `Loop aktif, cek lagi ${waitSeconds} detik`
          };
          await cancellableDelay(waitSeconds, mode);
          firstPass = false;
          continue;
        }
        if (totalSent === 0) {
          throw new Error(
            manual
              ? `Tidak ada ${label} yang perlu dikirim. Target status OK tidak dikirim ulang; aktifkan Loop atau klik Reset progress kalau mau blast ulang dari awal.`
              : `Belum ada ${label} yang sudah waktunya dikirim sesuai interval.`
          );
        }
        break;
      }

      if (!targets.some((target) => targetPayloadReady(target, config))) {
        throw new Error(
          mode === "groups"
            ? "Payload grup kosong. Isi link forward channel, teks default, atau teks custom di target grup."
            : `Pesan ${label} kosong.`
        );
      }

      for (const target of targets) {
        if (manual && !config.loopEnabled) processedManualKeys.add(`${target.accountId}:${target.id}`);
        await waitForQuietWindow(mode, source);
        if (state.cancelRequested) {
          cancelled = true;
          break;
        }
        if (!targetPayloadReady(target, config)) {
          target.lastStatus = "ERROR: Payload kosong untuk target ini.";
          target.nextRunAt = new Date(Date.now() + Number(target.intervalSeconds) * 1000).toISOString();
          saveTargetProgress(targetType, target, `${source}: skip ${target.name || target.title}, payload kosong`);
          errors.push(`${target.name || target.title}: Payload kosong`);
          continue;
        }
        let delivered = false;
        for (let attempt = 1; attempt <= 3 && !delivered; attempt += 1) {
          try {
            target.lastStatus = attempt > 1 ? `SENDING_RETRY_${attempt}` : "SENDING";
            saveTargetProgress(targetType, target, `${source}: mengirim ke ${target.name || target.title}${attempt > 1 ? ` (retry ${attempt})` : ""}`);
            const configuredSender = config.senderAccountId;
            const senderAccountId = configuredSender && configuredSender !== "target" ? configuredSender : target.accountId;
            const client = await ensureAuthorizedClient(senderAccountId);
            const senderInfo = accountPublicInfo(senderAccountId);
            state.currentBlast = {
              isSending: true,
              source,
              targetMode: mode,
              senderAccountId,
              senderLabel: senderInfo.label,
              senderPhone: senderInfo.phone,
              senderDisplayName: senderInfo.displayName,
              senderUsername: senderInfo.username,
              senderAvatarUrl: senderInfo.avatarUrl,
              targetName: target.name || target.title,
              targetUsername: target.username || "",
              startedAt: new Date().toISOString(),
              status: attempt > 1 ? `Mengirim ulang percobaan ${attempt}` : "Mengirim"
            };
            if (!senderInfo.avatarUrl) refreshAccountProfile(senderAccountId);
            const gate = await checkActivityGate(client, target, senderAccountId, config);
            if (!gate.allowed) {
              const recheckSeconds = Math.max(60, Math.min(Number(target.intervalSeconds) || ACTIVITY_GATE_RECHECK_SECONDS, ACTIVITY_GATE_RECHECK_SECONDS));
              target.lastStatus = gate.reason;
              target.nextRunAt = new Date(Date.now() + recheckSeconds * 1000).toISOString();
              delivered = true;
              const aiNote = gate.aiUsed ? " via AI" : "";
              saveTargetProgress(targetType, target, `${source}: tahan ${target.name || target.title}, baru ${gate.newMessages}/${gate.minMessages} chat setelah blast terakhir${aiNote}. Cek ulang ${Math.ceil(recheckSeconds / 60)} menit.`);
              state.currentBlast = {
                ...state.currentBlast,
                status: `Ditahan: ${gate.newMessages}/${gate.minMessages} chat baru${aiNote}, cek ulang ${Math.ceil(recheckSeconds / 60)} menit`,
                finishedAt: new Date().toISOString()
              };
              await adaptiveDelay(Math.min(sendDelaySeconds, 1), 0, mode);
              break;
            }
            const payload = await sendTargetPayload(client, target, senderAccountId, config);
            const payloadType = payload.type;
            target.lastRunAt = new Date().toISOString();
            target.lastMessageId = payload.id || target.lastMessageId || null;
            target.lastStatus = "OK";
            target.nextRunAt = new Date(Date.now() + Number(target.intervalSeconds) * 1000).toISOString();
            totalSent += 1;
            delivered = true;
            saveTargetProgress(targetType, target, `${source}: ${payloadType} terkirim ke ${target.name || target.title}`);
            state.currentBlast = { ...state.currentBlast, status: `Terkirim (${payloadType})`, finishedAt: new Date().toISOString() };
            await adaptiveDelay(sendDelaySeconds, 0, mode);
          } catch (error) {
            const reason = describeTelegramError(error);
            const retryable = isRetryableSendError(error) && attempt < 3 && !state.cancelRequested;
            const pendingRetry = !retryable && isRetryableSendError(error) && !state.cancelRequested;
            const nextDelay = pendingRetry ? retryDelaySeconds(error, readDb()) : Number(target.intervalSeconds);
            target.lastStatus = retryable ? `SENDING_RETRY_WAIT: ${reason}` : pendingRetry ? `PENDING_RETRY: ${reason}` : `ERROR: ${reason}`;
            target.nextRunAt = new Date(Date.now() + nextDelay * 1000).toISOString();
            if (state.currentBlast) {
              state.currentBlast = {
                ...state.currentBlast,
                status: retryable ? `Retry: ${reason}` : pendingRetry ? `Pending retry: ${reason}` : `Gagal: ${reason}`,
                finishedAt: new Date().toISOString()
              };
            }
            saveTargetProgress(
              targetType,
              target,
              retryable
                ? `${source}: retry ${target.name || target.title} karena ${reason}`
                : pendingRetry
                  ? `${source}: pending retry ${target.name || target.title} karena ${reason}`
                  : `${source}: gagal ke ${target.name || target.title}`
            );
            await waitAfterSendError(error, sendDelaySeconds, mode);
            if (!retryable && !pendingRetry) errors.push(`${target.name || target.title}: ${reason}`);
          }
        }
      }

      if (cancelled || !manual) break;
      if (!config.loopEnabled) {
        firstPass = false;
        continue;
      }
      firstPass = false;
    }

    if (state.cancelRequested) cancelled = true;
    const fresh = readDb();
    const finalConfig = modeConfig(fresh, mode);
    const label = finalConfig.label;
    fresh.lastStatus = cancelled
      ? `${source}: dibatalkan, ${totalSent} ${label} terkirim, ${errors.length} gagal`
      : `${source}: ${totalSent} ${label} terkirim, ${errors.length} gagal`;
    addLog(fresh, fresh.lastStatus);
    for (const error of errors.slice(0, 10)) addLog(fresh, error);
    saveDb(fresh);
    return { sent: totalSent, errors, cancelled };
  } finally {
    state.isSending = false;
    state.cancelRequested = false;
    state.currentBlast = null;
  }
}

setInterval(async () => {
  try {
    const db = readDb();
    if (isQuietHoursActive(db)) {
      quietWasActive = true;
      noteQuietPause("jadwal");
      return;
    }
    if (quietWasActive) {
      quietWasActive = false;
      wakeActiveModesAfterQuiet(db);
      saveDb(db);
    }
    const jobs = [];
    if ((db.groupSchedulerEnabled || db.groupLoopEnabled) && dueTargets(db, false, "groups").length) jobs.push(sendTargets("jadwal grup", false, "groups"));
    if ((db.folderGroupSchedulerEnabled || db.folderGroupLoopEnabled) && dueTargets(db, false, "folderGroups").length) jobs.push(sendTargets("jadwal folder grup", false, "folderGroups"));
    if ((db.adminSchedulerEnabled || db.adminLoopEnabled) && dueTargets(db, false, "admins").length) jobs.push(sendTargets("jadwal kontak", false, "admins"));
    if (jobs.length) await Promise.all(jobs);
  } catch (error) {
    const db = readDb();
    db.lastStatus = `ERROR: ${error.message}`;
    addLog(db, db.lastStatus);
    saveDb(db);
  }
}, 1000);

async function reconnectWatchdog() {
  const db = readDb();
  if (!db.reconnectWatchdogEnabled) return;
  const senderIds = new Set();
  if (db.groupSchedulerEnabled || db.groupLoopEnabled) {
    if (db.groupSenderAccountId && db.groupSenderAccountId !== "target") senderIds.add(db.groupSenderAccountId);
    else for (const target of db.selectedGroups) if (target.enabled !== false) senderIds.add(target.accountId);
  }
  if (db.folderGroupSchedulerEnabled || db.folderGroupLoopEnabled) {
    if (db.folderGroupSenderAccountId && db.folderGroupSenderAccountId !== "target") senderIds.add(db.folderGroupSenderAccountId);
    else for (const target of db.selectedFolderGroups) if (target.enabled !== false) senderIds.add(target.accountId);
  }
  if (db.adminSchedulerEnabled || db.adminLoopEnabled) {
    if (db.adminSenderAccountId && db.adminSenderAccountId !== "target") senderIds.add(db.adminSenderAccountId);
    else for (const target of db.selectedAdmins) if (target.enabled !== false) senderIds.add(target.accountId);
  }
  for (const accountId of senderIds) {
    try {
      await ensureAuthorizedClient(accountId);
    } catch (error) {
      const fresh = readDb();
      fresh.lastStatus = `Watchdog akun ${accountPublicInfo(accountId).label}: ${describeTelegramError(error)}`;
      addLog(fresh, fresh.lastStatus);
      saveDb(fresh);
    }
  }
}

setInterval(() => {
  reconnectWatchdog().catch(() => {});
}, 30000);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/avatars", express.static(AVATARS_DIR));
app.use(express.static(PUBLIC_DIR));

app.get("/api/status", async (req, res) => {
  const db = readDb();
  const accounts = [];
  for (const account of db.accounts) {
    accounts.push({ ...account, apiHash: "", avatarUrl: account.avatarUrl || avatarUrl(account.id), authorized: cachedAccountAuthorized(account.id) });
  }
  res.json({
    ...db,
    accounts,
    groqReady: Boolean(process.env.GROQ_API_KEY),
    isSending: anySending(),
    currentBlast: primaryCurrentBlast(),
    currentBlasts: {
      groups: blastStates.groups.currentBlast,
      folderGroups: blastStates.folderGroups.currentBlast,
      admins: blastStates.admins.currentBlast
    },
    cancelSendRequested: anyCancelRequested()
  });
});

app.get("/api/progress", (req, res) => {
  const db = readDb();
  res.json({
    selectedGroups: db.selectedGroups,
    selectedFolderGroups: db.selectedFolderGroups,
    selectedAdmins: db.selectedAdmins,
    sendLog: db.sendLog,
    lastStatus: db.lastStatus,
    isSending: anySending(),
    currentBlast: primaryCurrentBlast(),
    currentBlasts: {
      groups: blastStates.groups.currentBlast,
      folderGroups: blastStates.folderGroups.currentBlast,
      admins: blastStates.admins.currentBlast
    },
    cancelSendRequested: anyCancelRequested()
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(String(req.params.id || ""));
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan." });
  res.json(job);
});

app.post("/api/accounts/save", (req, res) => {
  const db = readDb();
  const phone = String(req.body.phone || "").trim();
  const requestedId = String(req.body.id || "").trim();
  const id = requestedId || accountIdFromPhone(phone);
  const existing = db.accounts.find((item) => item.id === id);
  const account = {
    id,
    label: String(req.body.label || phone || id).trim(),
    apiId: String(req.body.apiId || "").trim(),
    apiHash: String(req.body.apiHash || existing?.apiHash || "").trim(),
    phone
  };
  if (existing) Object.assign(existing, account);
  else db.accounts.push(account);
  db.activeAccountId = id;
  saveDb(db);
  clients.delete(id);
  res.json({ ok: true, account: { ...account, apiHash: "" } });
});

app.post("/api/accounts/active", (req, res) => {
  const db = readDb();
  const id = String(req.body.accountId || "");
  if (!db.accounts.some((account) => account.id === id)) return res.status(400).json({ error: "Akun tidak ditemukan." });
  db.activeAccountId = id;
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/login/start", async (req, res) => {
  try {
    const account = getAccount(req.body.accountId);
    const client = await getClient(account.id);
    const sent = await client.sendCode({ apiId: Number(account.apiId), apiHash: account.apiHash }, account.phone);
    loginStates.set(account.id, { phone: account.phone, phoneCodeHash: sent.phoneCodeHash });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/login/finish", async (req, res) => {
  try {
    const account = getAccount(req.body.accountId);
    const state = loginStates.get(account.id);
    if (!state) throw new Error("Kirim OTP dulu.");
    const client = await getClient(account.id);
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: state.phone,
        phoneCodeHash: state.phoneCodeHash,
        phoneCode: String(req.body.code || "").trim()
      }));
    } catch (error) {
      const name = error.errorMessage || error.message || "";
      if (!name.includes("SESSION_PASSWORD_NEEDED")) throw error;
      const password = String(req.body.password || "");
      if (!password) throw new Error("Akun memakai 2FA. Isi password 2FA.");
      await client.signInWithPassword({ apiId: Number(account.apiId), apiHash: account.apiHash }, { password: async () => password });
    }
    saveSession(account.id, client.session.save());
    loginStates.delete(account.id);
    refreshAccountProfile(account.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/groups/detect", async (req, res) => {
  try {
    if (req.query.async === "1") {
      const job = createJob("detect groups", async () => {
        const groups = await detectGroups(req.query.accountId);
        const db = readDb();
        db.knownGroups = mergeTargets(db.knownGroups, groups);
        saveDb(db);
        return { groups };
      });
      return res.json({ started: true, jobId: job.id });
    }
    const groups = await detectGroups(req.query.accountId);
    const db = readDb();
    db.knownGroups = mergeTargets(db.knownGroups, groups);
    saveDb(db);
    res.json({ groups });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/folders/detect", async (req, res) => {
  try {
    if (req.query.async === "1") {
      const job = createJob("detect folders", async () => {
        const folders = await detectFolders(req.query.accountId);
        const db = readDb();
        db.knownGroups = mergeTargets(db.knownGroups, folders.flatMap((folder) => folder.groups || []));
        saveDb(db);
        return { folders };
      });
      return res.json({ started: true, jobId: job.id });
    }
    const folders = await detectFolders(req.query.accountId);
    const db = readDb();
    db.knownGroups = mergeTargets(db.knownGroups, folders.flatMap((folder) => folder.groups || []));
    saveDb(db);
    res.json({ folders });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/groups/selected", (req, res) => {
  const db = readDb();
  const incoming = Array.isArray(req.body.groups) ? req.body.groups : [];
  db.selectedGroups = incoming.map((group) => ({
    id: String(group.id),
    accountId: String(group.accountId || db.activeAccountId),
    accountLabel: String(group.accountLabel || ""),
    title: String(group.title || group.id),
    username: String(group.username || ""),
    type: String(group.type || ""),
    intervalSeconds: Math.max(5, Number(group.intervalSeconds || db.groupDefaultIntervalSeconds || db.defaultIntervalSeconds || 3600)),
    enabled: group.enabled !== false,
    nextRunAt: group.nextRunAt || null,
    lastRunAt: group.lastRunAt || null,
    lastMessageId: group.lastMessageId || null,
    lastStatus: group.lastStatus || "",
    customMessage: String(group.customMessage || ""),
    activityGateEnabled: typeof group.activityGateEnabled === "boolean" ? group.activityGateEnabled : Boolean(db.groupActivityGateEnabled),
    activityGateMinMessages: Math.max(1, Math.min(50, Number(group.activityGateMinMessages || db.groupActivityGateMinMessages || 10)))
  }));
  saveDb(db);
  res.json({ ok: true, total: db.selectedGroups.length });
});

app.post("/api/folders/selected", (req, res) => {
  const db = readDb();
  const incoming = Array.isArray(req.body.groups) ? req.body.groups : [];
  db.selectedFolderGroups = incoming.map((group) => ({
    id: String(group.id),
    accountId: String(group.accountId || db.activeAccountId),
    accountLabel: String(group.accountLabel || ""),
    title: String(group.title || group.id),
    username: String(group.username || ""),
    type: String(group.type || ""),
    folderId: String(group.folderId || ""),
    folderTitle: String(group.folderTitle || ""),
    intervalSeconds: Math.max(5, Number(group.intervalSeconds || db.folderGroupDefaultIntervalSeconds || db.groupDefaultIntervalSeconds || db.defaultIntervalSeconds || 3600)),
    enabled: group.enabled !== false,
    nextRunAt: group.nextRunAt || null,
    lastRunAt: group.lastRunAt || null,
    lastMessageId: group.lastMessageId || null,
    lastStatus: group.lastStatus || "",
    customMessage: String(group.customMessage || ""),
    activityGateEnabled: typeof group.activityGateEnabled === "boolean" ? group.activityGateEnabled : Boolean(db.folderGroupActivityGateEnabled),
    activityGateMinMessages: Math.max(1, Math.min(50, Number(group.activityGateMinMessages || db.folderGroupActivityGateMinMessages || 10)))
  }));
  saveDb(db);
  res.json({ ok: true, total: db.selectedFolderGroups.length });
});

app.get("/api/admins/detect", async (req, res) => {
  try {
    if (req.query.async === "1") {
      const job = createJob("detect admins", async () => detectAdmins());
      return res.json({ started: true, jobId: job.id });
    }
    res.json(await detectAdmins());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admins/selected", (req, res) => {
  const db = readDb();
  const incoming = Array.isArray(req.body.admins) ? req.body.admins : [];
  const mappedAdmins = incoming.filter((admin) => admin.isBot !== true).map((admin) => ({
    id: String(admin.id),
    userId: String(admin.userId || ""),
    accountId: String(admin.accountId || db.activeAccountId),
    accountLabel: String(admin.accountLabel || ""),
    name: String(admin.name || admin.id),
    username: String(admin.username || ""),
    role: String(admin.role || "Admin"),
    isBot: false,
    sourceGroups: Array.isArray(admin.sourceGroups) ? admin.sourceGroups.map(String) : [],
    intervalSeconds: Math.max(5, Number(admin.intervalSeconds || db.adminDefaultIntervalSeconds || db.defaultIntervalSeconds || 3600)),
    enabled: admin.enabled !== false,
    nextRunAt: admin.nextRunAt || null,
    lastRunAt: admin.lastRunAt || null,
    lastMessageId: admin.lastMessageId || null,
    lastStatus: admin.lastStatus || "",
    customMessage: String(admin.customMessage || "")
  }));
  db.selectedAdmins = mergeTargets(db.selectedAdmins, mappedAdmins);
  saveDb(db);
  res.json({ ok: true, total: db.selectedAdmins.length });
});

app.post("/api/targets/update", (req, res) => {
  const db = readDb();
  const kind = req.body.kind === "admins" ? "selectedAdmins" : req.body.kind === "folderGroups" ? "selectedFolderGroups" : "selectedGroups";
  const updates = new Map((Array.isArray(req.body.targets) ? req.body.targets : []).map((target) => [`${target.accountId}:${target.id}`, target]));
  db[kind] = db[kind].map((target) => {
    const update = updates.get(`${target.accountId}:${target.id}`);
    if (!update) return target;
    return {
      ...target,
      intervalSeconds: Math.max(5, Number(update.intervalSeconds || target.intervalSeconds)),
      enabled: update.enabled !== false,
      customMessage: String(update.customMessage ?? target.customMessage ?? ""),
      activityGateEnabled: typeof update.activityGateEnabled === "boolean" ? update.activityGateEnabled : target.activityGateEnabled,
      activityGateMinMessages: Math.max(1, Math.min(50, Number(update.activityGateMinMessages || target.activityGateMinMessages || 10))),
      nextRunAt: update.resetNextRun ? null : target.nextRunAt
    };
  });
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/settings", (req, res) => {
  const db = readDb();
  db.message = String(req.body.message || "");
  db.groupForwardLink = String(req.body.groupForwardLink ?? db.groupForwardLink ?? "");
  db.targetMode = req.body.targetMode === "admins" ? "admins" : "groups";
  db.senderAccountId = String(req.body.senderAccountId || "target");
  db.groupSenderAccountId = String(req.body.groupSenderAccountId || req.body.senderAccountId || "target");
  db.adminSenderAccountId = String(req.body.adminSenderAccountId || req.body.senderAccountId || "target");
  db.defaultIntervalSeconds = Math.max(5, Number(req.body.defaultIntervalSeconds || db.defaultIntervalSeconds || 3600));
  db.delaySeconds = Math.max(0, Number(req.body.delaySeconds || 0));
  db.groupDelaySeconds = Math.max(0, Number(req.body.groupDelaySeconds ?? req.body.delaySeconds ?? db.groupDelaySeconds ?? 0));
  db.adminDelaySeconds = Math.max(0, Number(req.body.adminDelaySeconds ?? req.body.delaySeconds ?? db.adminDelaySeconds ?? 0));
  db.schedulerEnabled = Boolean(req.body.schedulerEnabled);
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/settings/groups", (req, res) => {
  const db = readDb();
  db.groupMessage = String(req.body.message || "");
  db.groupForwardLink = String(req.body.forwardLink || "");
  db.groupSenderAccountId = String(req.body.senderAccountId || "target");
  db.groupDefaultIntervalSeconds = Math.max(5, Number(req.body.defaultIntervalSeconds || db.groupDefaultIntervalSeconds || 3600));
  db.groupDelaySeconds = Math.max(0, Number(req.body.delaySeconds ?? db.groupDelaySeconds ?? 1));
  db.groupSchedulerEnabled = Boolean(req.body.schedulerEnabled);
  db.groupLoopEnabled = Boolean(req.body.loopEnabled);
  db.groupActivityGateEnabled = Boolean(req.body.activityGateEnabled);
  db.groupActivityGateMinMessages = Math.max(1, Math.min(50, Number(req.body.activityGateMinMessages || db.groupActivityGateMinMessages || 10)));
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/settings/folder-groups", (req, res) => {
  const db = readDb();
  db.folderGroupMessage = String(req.body.message || "");
  db.folderGroupForwardLink = String(req.body.forwardLink || "");
  db.folderGroupSenderAccountId = String(req.body.senderAccountId || db.groupSenderAccountId || "target");
  db.folderGroupDefaultIntervalSeconds = Math.max(5, Number(req.body.defaultIntervalSeconds || db.folderGroupDefaultIntervalSeconds || 3600));
  db.folderGroupDelaySeconds = Math.max(0, Number(req.body.delaySeconds ?? db.folderGroupDelaySeconds ?? 3));
  db.folderGroupSchedulerEnabled = Boolean(req.body.schedulerEnabled);
  db.folderGroupLoopEnabled = Boolean(req.body.loopEnabled);
  db.folderGroupActivityGateEnabled = Boolean(req.body.activityGateEnabled);
  db.folderGroupActivityGateMinMessages = Math.max(1, Math.min(50, Number(req.body.activityGateMinMessages || db.folderGroupActivityGateMinMessages || 10)));
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/settings/admins", (req, res) => {
  const db = readDb();
  const oldDefaultInterval = Number(db.adminDefaultIntervalSeconds || db.defaultIntervalSeconds || 3600);
  db.adminMessage = String(req.body.message || "");
  db.adminForwardLink = String(req.body.forwardLink || "");
  db.adminSenderAccountId = String(req.body.senderAccountId || "target");
  const intervalDays = Number(req.body.defaultIntervalDays || 0);
  db.adminDefaultIntervalSeconds = intervalDays > 0
    ? Math.max(86400, Math.round(intervalDays * 86400))
    : Math.max(5, Number(req.body.defaultIntervalSeconds || db.adminDefaultIntervalSeconds || 3600));
  db.adminDelaySeconds = Math.max(0, Number(req.body.delaySeconds ?? db.adminDelaySeconds ?? 1));
  db.adminSchedulerEnabled = Boolean(req.body.schedulerEnabled);
  db.adminLoopEnabled = Boolean(req.body.loopEnabled);
  db.selectedAdmins = db.selectedAdmins.map((admin) => {
    const current = Number(admin.intervalSeconds || 0);
    const shouldUseDefault = !current || current === oldDefaultInterval || current < 86400;
    return shouldUseDefault ? { ...admin, intervalSeconds: db.adminDefaultIntervalSeconds } : admin;
  });
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/settings/system", (req, res) => {
  const db = readDb();
  db.quietHoursEnabled = Boolean(req.body.quietHoursEnabled);
  db.quietHoursStart = normalizeClock(req.body.quietHoursStart || db.quietHoursStart || "02:50");
  db.quietHoursEnd = normalizeClock(req.body.quietHoursEnd || db.quietHoursEnd || "03:20");
  db.reconnectWatchdogEnabled = Boolean(req.body.reconnectWatchdogEnabled);
  db.networkRetrySeconds = Math.max(30, Number(req.body.networkRetrySeconds || db.networkRetrySeconds || 300));
  db.aiActivityAgentEnabled = Boolean(req.body.aiActivityAgentEnabled);
  db.groqModel = String(req.body.groqModel || db.groqModel || "llama-3.1-8b-instant").trim();
  db.aiActivityAgentMargin = Math.max(0, Math.min(20, Number(req.body.aiActivityAgentMargin ?? db.aiActivityAgentMargin ?? 5)));
  const quietActive = isQuietHoursActive(db);
  if (!quietActive) {
    quietWasActive = false;
    wakeActiveModesAfterQuiet(db, "setting rest disimpan");
  } else {
    quietWasActive = true;
    db.lastStatus = `Setting rest disimpan. Masih pause sampai ${db.quietHoursEnd}.`;
    addLog(db, db.lastStatus);
  }
  saveDb(db);
  res.json({ ok: true, quietActive, lastStatus: db.lastStatus });
});

app.post("/api/send-now", async (req, res) => {
  Promise.resolve()
    .then(() => sendTargets("manual", true))
    .catch((error) => {
      const db = readDb();
      db.lastStatus = `ERROR: ${error.message}`;
      addLog(db, db.lastStatus);
      saveDb(db);
    });
  res.json({ started: true, message: "Pengiriman dimulai." });
});

function startBackgroundSend(res, mode, label) {
  const state = blastState(mode);
  if (state.isSending) {
    res.json({ skipped: true, message: `Pengiriman ${label} sedang berjalan.` });
    return;
  }
  Promise.resolve()
    .then(() => sendTargets(`manual ${label}`, true, mode))
    .catch((error) => {
      const db = readDb();
      db.lastStatus = `ERROR: ${error.message}`;
      addLog(db, db.lastStatus);
      saveDb(db);
    });
  res.json({ started: true, message: `Pengiriman ${label} dimulai.` });
}

app.post("/api/send-groups-now", (req, res) => {
  startBackgroundSend(res, "groups", "grup");
});

app.post("/api/send-folder-groups-now", (req, res) => {
  startBackgroundSend(res, "folderGroups", "folder grup");
});

app.post("/api/send-admins-now", (req, res) => {
  startBackgroundSend(res, "admins", "kontak");
});

app.post("/api/stop-send", (req, res) => {
  blastStates.groups.cancelRequested = true;
  blastStates.folderGroups.cancelRequested = true;
  blastStates.admins.cancelRequested = true;
  const db = readDb();
  stopAutomationForMode(db, "groups");
  stopAutomationForMode(db, "folderGroups");
  stopAutomationForMode(db, "admins");
  db.lastStatus = anySending()
    ? "Permintaan stop diterima. Semua jadwal dan loop dimatikan."
    : "Semua jadwal dan loop dimatikan.";
  addLog(db, db.lastStatus);
  saveDb(db);
  res.json({ ok: true, stopped: true });
});

app.post("/api/stop-send/:mode", (req, res) => {
  const mode = blastMode(req.params.mode);
  const state = blastState(mode);
  state.cancelRequested = true;
  const db = readDb();
  const label = stopAutomationForMode(db, mode);
  db.lastStatus = state.isSending
    ? `Permintaan stop ${label} diterima. Jadwal dan loop ${label} dimatikan.`
    : `Jadwal dan loop ${label} dimatikan.`;
  addLog(db, db.lastStatus);
  saveDb(db);
  res.json({ ok: true, stopped: true });
});

app.post("/api/progress/reset", (req, res) => {
  const db = readDb();
  const resetTarget = (target) => ({ ...target, lastRunAt: null, lastMessageId: null, lastStatus: "", nextRunAt: null });
  db.selectedGroups = db.selectedGroups.map(resetTarget);
  db.selectedFolderGroups = db.selectedFolderGroups.map(resetTarget);
  db.selectedAdmins = db.selectedAdmins.map(resetTarget);
  db.lastStatus = `Progress blast direset. Grup: ${db.selectedGroups.length}, folder: ${db.selectedFolderGroups.length}, kontak: ${db.selectedAdmins.length}.`;
  addLog(db, db.lastStatus);
  saveDb(db);
  res.json({
    ok: true,
    selectedGroups: db.selectedGroups,
    selectedFolderGroups: db.selectedFolderGroups,
    selectedAdmins: db.selectedAdmins,
    lastStatus: db.lastStatus
  });
});

const PORT = Number(process.env.PORT || 5174);
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Telegram JS User Sender V2 jalan di http://${HOST}:${PORT}`);
});
