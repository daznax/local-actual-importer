// Watches a "new" folder, imports CSVs into Actual Budget, files them away,
// and sends a push notification via ntfy when transactions are ready to review.
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import chokidar from "chokidar";
import { parse } from "csv-parse/sync";
import * as api from "@actual-app/api";

const env = process.env;
const SHARED = env.SHARED_DIR ?? "./testFolders/new";
const BASE = env.BASE_DIR ?? "./testFolders";
const DIRS = {
  shared: path.join(SHARED),
  wip: path.join(BASE, "wip"),
  complete: path.join(BASE, "complete"),
  failed: path.join(BASE, "failed"),
};
const config = JSON.parse(await fs.readFile(new URL("./config.json", import.meta.url), "utf8"));
const skipImport = config.skipImport;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- helpers ----------

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a file into a directory, avoiding name collisions.
 */
async function moveTo(file, dir) {
  console.log(`File: ${file}||Dir: ${dir}`);
  await fs.mkdir(dir, { recursive: true });
  let dest = path.join(dir, path.basename(file));
  if (await exists(dest)) {
    const { name, ext } = path.parse(dest);
    dest = path.join(dir, `${name}-${Date.now()}${ext}`);
  }
  await fs.rename(file, dest); // same filesystem, so this is atomic
  return dest;
}

async function notify(title, message, priority = "default") {
  if (!env.NTFY_URL) return;
  try {
    const headers = { Title: title, Priority: priority };
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
    const res = await fetch(env.NTFY_URL, { method: "POST", headers, body: message });
    if (!res.ok) log("ntfy responded", res.status);
  } catch (err) {
    log("notification failed:", err.message);
  }
}

// ---------- CSV parsing ----------

function parseDate(raw) {
  const s = String(raw ?? "").trim();
  let y, m, d, match;
  match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) [, m, d, y] = match;
  if (!y) throw new Error(`Unrecognized date "${s}" (date format is invalid)`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseAmount(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const paren = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  if (Number.isNaN(n)) throw new Error(`Unrecognized amount "${s}"`);
  return paren ? -Math.abs(n) : n;
}

/**
 * Given csv content from a file and config from working dir json, parses
 * the file and returns an array of transaction objects
 */
function csvToTransactions(content, cfg) {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const col = cfg.columns;
  const seen = new Map();

  return rows.map((r) => {
    const date = parseDate(r[col.date], config.dateFormat);
    let amount = col.amount
      ? parseAmount(r[col.amount])
      : parseAmount(r[col.credit]) - Math.abs(parseAmount(r[col.debit]));
    if (cfg.invertAmount) amount = -amount;

    const payee = r[col.payee] || undefined;
    const notes = r[col.notes] || undefined;

    // Stable ID so re-importing the same file never creates duplicates.
    // The counter keeps two identical same-day transactions distinct.
    const key = `${date}|${amount}|${payee ?? ""}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const imported_id = crypto.createHash("sha1").update(`${key}|${n}`).digest("hex").slice(0, 16);

    return {
      date,
      amount: api.utils.amountToInteger(amount),
      payee_name: payee || undefined,
      notes: notes || undefined,
      imported_id,
    };
  });
}

/**
 * Pick the account from the filename prefix (see "accounts" in config.json).
 */
function resolveAccount(filename) {
  const lower = filename.toLowerCase();
  const acctAry = config.accounts;
  let account = acctAry.find((a) => {
    if (lower.includes(a.name.toLowerCase())) return a;
  });
  if (!account) {
    throw new Error(`No account mapping matches "${filename}" and no defaultAccount is set`);
  } else {
    return account;
  }
}

// ---------- the import ----------

async function importToActual(accountName, transactions) {
  await fs.mkdir(env.ACTUAL_DATA_DIR ?? "./actual-data", { recursive: true });
  await api.init({
    dataDir: env.ACTUAL_DATA_DIR ?? "./actual-data",
    serverURL: env.ACTUAL_SERVER_URL,
    password: env.ACTUAL_PASSWORD,
  });
  try {
    await api.downloadBudget(
      env.ACTUAL_SYNC_ID,
      env.ACTUAL_BUDGET_PASSWORD ? { password: env.ACTUAL_BUDGET_PASSWORD } : undefined,
    );
    const accounts = await api.getAccounts();
    const account = accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase());
    if (!account) {
      let errorMsg = `Account "${accountName}" not found. Available: ${accounts.map((a) => a.name).join(", ")}`;
      log(errorMsg);
      throw new Error(errorMsg);
    }
    const result = await api.importTransactions(account.id, transactions);
    await api.sync();
    return result; // { added: [...], updated: [...], errors?: [...] }
  } finally {
    await api.shutdown();
  }
}

/**
 * main entry for processing a file
 * this calls processFileCore, which can also be called standalone
 */
async function processFile(file) {
  const name = path.basename(file);
  if (name.startsWith(".") || !name.toLowerCase().endsWith(".csv")) {
    if (!name.startsWith(".")) {
      log(`Unsupported file type, moving to failed: ${name}`);
      await moveTo(file, DIRS.failed);
      await notify("Actual import skipped", `${name} is not a .csv file`, "high");
    }
    return;
  }

  log(`New file: ${name}`);
  let wipPath;
  try {
    wipPath = await moveTo(file, DIRS.wip);
  } catch (err) {
    // File vanished or was already picked up
    log(`Could not move ${name} to wip: ${err.message}`);
    return;
  }
  await processFileCore(wipPath, name);
}

/**
 * Given a path and account name, processes the file.
 * If skipImport is set in config.json, transactions will print to the console instead of import
 */
async function processFileCore(path, name) {
  try {
    const account = resolveAccount(name);
    const content = await fs.readFile(path, "utf8");
    const transactions = csvToTransactions(content, account);
    if (transactions.length === 0) throw new Error("No transactions found in file");

    if (!skipImport) {
      const result = await importToActual(account.actualName, transactions);
      const added = result.added?.length ?? 0;
      const updated = result.updated?.length ?? 0;
      if (result.errors?.length) {
        throw new Error(`Actual reported errors: ${JSON.stringify(result.errors)}`);
      }
      await moveTo(path, DIRS.complete);
      log(`Imported ${name}: ${added} added, ${updated} updated`);
      await notify(
        "Transactions ready to review",
        `${name} -> ${account.actualName}: ${added} new, ${updated} updated`,
      );
    } else {
      //if we're skipping the import, write the transactions to the console
      console.log("Begin listing transactions:");
      console.log("DATE, AMOUNT, PAYEE, NOTES, IMPORTED_ID");
      transactions.forEach((t) => {
        console.log(`${t.date}, ${t.amount}, ${t.payee_name}, ${t.notes}, ${t.imported_id}`);
      });
    }
  } catch (err) {
    log(`FAILED ${name}:`, err.message);
    await moveTo(path, DIRS.failed).catch(() => {});
    await notify("Actual import FAILED", `${name}: ${err.message}`, "high");
  }
}

// ---------- watcher (processes files one at a time) ----------
//starts queue
let queue = Promise.resolve();
//function that adds a file to the back of the queue each time it is called
const enqueue = (file) => {
  queue = queue.then(() => processFile(file)).catch((e) => log("queue error:", e));
};

//create directories from the DIRS object (environment variable)
for (const d of Object.values(DIRS)) await fs.mkdir(d, { recursive: true });

//start the watcher on the shared directory
const watcher = chokidar.watch(DIRS.shared, {
  depth: 0,
  ignoreInitial: false, // also picks up files that arrived while the service was down
  usePolling: true,
  interval: 500,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 }, // wait for slow copies over Samba
});

//each time a file is added to the shared dir, execute the 'enqueue' function
watcher.on("add", enqueue);
watcher.on("error", (e) => log("watcher error:", e));
log(`Watching ${DIRS.shared}`);

//handles shutdown of the service/watcher
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    log(`${sig} received, shutting down`);
    await watcher.close();
    await queue;
    process.exit(0);
  });
}
