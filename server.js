const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "splitmint.json");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "splitmint-dev-secret-change-me";
const PUBLIC_FILES = new Set(["/", "/index.html", "/styles.css", "/app.js", "/README.md"]);
const COLORS = ["#19a875", "#087c89", "#c48a12", "#805ad5", "#d15757", "#2f855a"];

let db = loadDb();

function loadDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const fresh = { users: [], groups: [], expenses: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function uid() {
  return crypto.randomUUID();
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function money(value) {
  return `$${round2(value).toFixed(2)}`;
}

function initials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "U";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.exp || parsed.exp < Date.now()) return null;
  return parsed.userId;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  send(res, 400, { error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireUser(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const userId = readToken(token);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    send(res, 401, { error: "Unauthorized" });
    return null;
  }
  return user;
}

function userGroups(userId) {
  return db.groups.filter((group) => group.ownerId === userId);
}

function ownedGroup(userId, groupId) {
  return db.groups.find((group) => group.id === groupId && group.ownerId === userId);
}

function groupExpenses(groupId) {
  return db.expenses
    .filter((expense) => expense.groupId === groupId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeParticipants(rawParticipants, owner, existing = []) {
  const participants = Array.isArray(rawParticipants) ? rawParticipants : [];
  const normalized = participants
    .map((participant, index) => ({
      id: participant.id || uid(),
      name: String(participant.name || "").trim(),
      color: participant.color || COLORS[index % COLORS.length],
      avatar: initials(participant.name),
      isPrimary: Boolean(participant.isPrimary)
    }))
    .filter((participant) => participant.name);

  const primary = normalized.find((participant) => participant.isPrimary) || existing.find((participant) => participant.isPrimary);
  if (primary) {
    primary.name = owner.name;
    primary.avatar = initials(owner.name);
    primary.isPrimary = true;
  } else {
    normalized.unshift({ id: uid(), name: owner.name, color: COLORS[0], avatar: initials(owner.name), isPrimary: true });
  }

  const unique = [];
  const seen = new Set();
  for (const participant of normalized) {
    if (seen.has(participant.id)) continue;
    seen.add(participant.id);
    unique.push(participant);
  }
  if (unique.length > 4) throw new Error("A group can have the primary user plus up to 3 participants.");
  return unique;
}

function buildExpense(group, body, existingId) {
  const amount = round2(Number(body.amount));
  const description = String(body.description || "").trim();
  const date = String(body.date || "").trim();
  const payerId = String(body.payerId || "");
  const mode = ["equal", "custom", "percentage"].includes(body.mode) ? body.mode : "equal";
  const participantIds = new Set(group.participants.map((participant) => participant.id));
  if (!description) throw new Error("Description is required.");
  if (!date || Number.isNaN(Date.parse(`${date}T00:00:00`))) throw new Error("Valid date is required.");
  if (!amount || amount <= 0) throw new Error("Amount must be greater than zero.");
  if (!participantIds.has(payerId)) throw new Error("Payer must belong to this group.");
  if (!Array.isArray(body.splits) || body.splits.length === 0) throw new Error("At least one split participant is required.");
  if (body.splits.some((split) => !participantIds.has(split.participantId))) throw new Error("Every split participant must belong to this group.");

  const splits = normalizeSplits(body.splits, amount, mode);
  return {
    id: existingId || uid(),
    groupId: group.id,
    amount,
    description,
    date,
    payerId,
    mode,
    category: categorize(description),
    splits
  };
}

function normalizeSplits(rawSplits, amount, mode) {
  if (mode === "equal") {
    const ids = rawSplits.map((split) => split.participantId);
    const splitMap = evenSplit(amount, ids);
    return ids.map((participantId) => ({ participantId, amount: splitMap[participantId] }));
  }
  const values = rawSplits.map((split) => ({ participantId: split.participantId, amount: round2(Number(split.amount)) }));
  const total = round2(values.reduce((sum, split) => sum + split.amount, 0));
  if (mode === "custom" && total !== amount) throw new Error(`Custom split must total ${money(amount)}.`);
  if (mode === "percentage" && total !== amount) throw new Error(`Percentage split values must total ${money(amount)} after conversion.`);
  return values;
}

function evenSplit(amount, ids) {
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / ids.length);
  let remainder = cents - base * ids.length;
  return ids.reduce((map, id) => {
    const centsForPerson = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    map[id] = centsForPerson / 100;
    return map;
  }, {});
}

function computeBalances(group, expenses) {
  const net = Object.fromEntries(group.participants.map((participant) => [participant.id, 0]));
  const paid = Object.fromEntries(group.participants.map((participant) => [participant.id, 0]));
  const shares = Object.fromEntries(group.participants.map((participant) => [participant.id, 0]));
  expenses.forEach((expense) => {
    paid[expense.payerId] = round2((paid[expense.payerId] || 0) + expense.amount);
    net[expense.payerId] = round2((net[expense.payerId] || 0) + expense.amount);
    expense.splits.forEach((split) => {
      shares[split.participantId] = round2((shares[split.participantId] || 0) + split.amount);
      net[split.participantId] = round2((net[split.participantId] || 0) - split.amount);
    });
  });
  return { net, paid, shares, settlements: settle(net) };
}

function settle(net) {
  const debtors = Object.entries(net).filter(([, value]) => value < -0.009).map(([id, value]) => ({ id, amount: round2(-value) }));
  const creditors = Object.entries(net).filter(([, value]) => value > 0.009).map(([id, value]) => ({ id, amount: round2(value) }));
  const results = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = round2(Math.min(debtors[i].amount, creditors[j].amount));
    if (amount > 0) results.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].amount = round2(debtors[i].amount - amount);
    creditors[j].amount = round2(creditors[j].amount - amount);
    if (debtors[i].amount <= 0.009) i += 1;
    if (creditors[j].amount <= 0.009) j += 1;
  }
  return results;
}

function categorize(description) {
  const lower = description.toLowerCase();
  if (/food|pizza|dinner|lunch|breakfast|cafe|restaurant/.test(lower)) return "Food";
  if (/cab|taxi|uber|train|bus|flight|fuel/.test(lower)) return "Travel";
  if (/movie|ticket|game|show|concert/.test(lower)) return "Entertainment";
  if (/rent|hotel|stay|room/.test(lower)) return "Stay";
  return "General";
}

async function handleApi(req, res, url) {
  const method = req.method;

  if (method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 4) return badRequest(res, "Name, email, and a 4 character password are required.");
    if (db.users.some((user) => user.email === email)) return badRequest(res, "Email is already registered.");
    const user = { id: uid(), name, email, passwordHash: hashPassword(password) };
    db.users.push(user);
    saveDb();
    return send(res, 201, { user: publicUser(user), token: signToken(user.id) });
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) return send(res, 401, { error: "Invalid email or password." });
    return send(res, 200, { user: publicUser(user), token: signToken(user.id) });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (method === "GET" && url.pathname === "/api/me") {
    return send(res, 200, { user: publicUser(user) });
  }

  if (method === "GET" && url.pathname === "/api/groups") {
    const groups = userGroups(user.id).map((group) => ({
      ...group,
      totalSpent: round2(groupExpenses(group.id).reduce((sum, expense) => sum + expense.amount, 0)),
      expenseCount: groupExpenses(group.id).length
    }));
    return send(res, 200, { groups });
  }

  if (method === "POST" && url.pathname === "/api/groups") {
    const body = await readJson(req);
    try {
      const group = {
        id: uid(),
        ownerId: user.id,
        name: String(body.name || "").trim(),
        participants: normalizeParticipants(body.participants, user)
      };
      if (!group.name) return badRequest(res, "Group name is required.");
      db.groups.push(group);
      saveDb();
      return send(res, 201, { group });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)(?:\/(dashboard|expenses))?$/);
  if (groupMatch) {
    const group = ownedGroup(user.id, groupMatch[1]);
    if (!group) return notFound(res);
    const child = groupMatch[2];

    if (method === "GET" && child === "dashboard") {
      const expenses = groupExpenses(group.id);
      return send(res, 200, { group, expenses, balances: computeBalances(group, expenses) });
    }

    if (method === "PUT" && !child) {
      const body = await readJson(req);
      try {
        const participants = normalizeParticipants(body.participants, user, group.participants);
        const remainingIds = new Set(participants.map((participant) => participant.id));
        db.expenses = db.expenses.filter((expense) => {
          if (expense.groupId !== group.id) return true;
          return remainingIds.has(expense.payerId) && expense.splits.every((split) => remainingIds.has(split.participantId));
        });
        group.name = String(body.name || "").trim();
        if (!group.name) return badRequest(res, "Group name is required.");
        group.participants = participants;
        saveDb();
        return send(res, 200, { group });
      } catch (error) {
        return badRequest(res, error.message);
      }
    }

    if (method === "DELETE" && !child) {
      db.groups = db.groups.filter((item) => item.id !== group.id);
      db.expenses = db.expenses.filter((expense) => expense.groupId !== group.id);
      saveDb();
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && child === "expenses") {
      const body = await readJson(req);
      try {
        const expense = buildExpense(group, body);
        db.expenses.push(expense);
        saveDb();
        return send(res, 201, { expense });
      } catch (error) {
        return badRequest(res, error.message);
      }
    }
  }

  const expenseMatch = url.pathname.match(/^\/api\/expenses\/([^/]+)$/);
  if (expenseMatch) {
    const expense = db.expenses.find((item) => item.id === expenseMatch[1]);
    const group = expense && ownedGroup(user.id, expense.groupId);
    if (!expense || !group) return notFound(res);

    if (method === "PUT") {
      const body = await readJson(req);
      try {
        const next = buildExpense(group, body, expense.id);
        Object.assign(expense, next);
        saveDb();
        return send(res, 200, { expense });
      } catch (error) {
        return badRequest(res, error.message);
      }
    }

    if (method === "DELETE") {
      db.expenses = db.expenses.filter((item) => item.id !== expense.id);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  return notFound(res);
}

function serveStatic(req, res, url) {
  const route = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!PUBLIC_FILES.has(url.pathname)) return notFound(res);
  const filePath = path.join(__dirname, route);
  const ext = path.extname(filePath);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".md" ? "text/markdown" : "text/html";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SplitMint running at http://localhost:${PORT}`);
  });
}

module.exports = {
  server,
  computeBalances,
  settle,
  buildExpense,
  normalizeParticipants,
  evenSplit,
  hashPassword,
  verifyPassword,
  signToken,
  readToken
};
