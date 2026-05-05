const COLORS = ["#19a875", "#087c89", "#c48a12", "#805ad5", "#d15757", "#2f855a"];

const state = {
  token: localStorage.getItem("splitmint-token"),
  user: null,
  groups: [],
  activeGroupId: null,
  dashboard: null,
  editingParticipants: []
};

const $ = (id) => document.getElementById(id);
const money = (value) => `$${round2(value).toFixed(2)}`;
const uid = () => `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function init() {
  bindEvents();
  setToday();
  if (state.token) {
    try {
      const { user } = await api("/api/me");
      state.user = user;
      await refreshGroups();
      if (state.groups.length === 0) {
        await createDefaultGroup();
        await refreshGroups();
      }
    } catch {
      localStorage.removeItem("splitmint-token");
      state.token = null;
    }
  }
  render();
}

function bindEvents() {
  $("login-tab").addEventListener("click", () => showAuthTab("login"));
  $("register-tab").addEventListener("click", () => showAuthTab("register"));
  $("login-form").addEventListener("submit", handleLogin);
  $("register-form").addEventListener("submit", handleRegister);
  $("logout-btn").addEventListener("click", logout);
  $("new-group-btn").addEventListener("click", () => openGroupDialog());
  $("edit-group-btn").addEventListener("click", () => openGroupDialog(activeGroup()));
  $("delete-group-btn").addEventListener("click", deleteActiveGroup);
  $("cancel-group-dialog").addEventListener("click", () => $("group-dialog").close());
  $("group-form").addEventListener("submit", saveGroup);
  $("add-participant-btn").addEventListener("click", addParticipantEditorRow);
  $("expense-form").addEventListener("submit", saveExpense);
  $("split-mode").addEventListener("change", renderSplitParticipants);
  $("expense-amount").addEventListener("input", renderSplitParticipants);
  $("clear-expense-form").addEventListener("click", clearExpenseForm);
  $("parse-mintsense").addEventListener("click", parseMintSense);
  ["search-filter", "participant-filter", "date-from-filter", "date-to-filter", "amount-min-filter", "amount-max-filter"]
    .forEach((id) => $(id).addEventListener("input", renderExpenseHistory));
}

function showAuthTab(tab) {
  $("login-tab").classList.toggle("active", tab === "login");
  $("register-tab").classList.toggle("active", tab === "register");
  $("login-form").classList.toggle("hidden", tab !== "login");
  $("register-form").classList.toggle("hidden", tab !== "register");
  $("login-error").textContent = "";
  $("register-error").textContent = "";
}

async function handleLogin(event) {
  event.preventDefault();
  try {
    const { user, token } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("login-email").value.trim().toLowerCase(),
        password: $("login-password").value
      })
    });
    state.user = user;
    state.token = token;
    localStorage.setItem("splitmint-token", token);
    await refreshGroups();
    if (state.groups.length === 0) {
      await createDefaultGroup();
      await refreshGroups();
    }
    render();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  try {
    const { user, token } = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("register-name").value.trim(),
        email: $("register-email").value.trim().toLowerCase(),
        password: $("register-password").value
      })
    });
    state.user = user;
    state.token = token;
    localStorage.setItem("splitmint-token", token);
    await createDefaultGroup();
    await refreshGroups();
    render();
  } catch (error) {
    $("register-error").textContent = error.message;
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.groups = [];
  state.activeGroupId = null;
  state.dashboard = null;
  localStorage.removeItem("splitmint-token");
  render();
}

async function createDefaultGroup() {
  await api("/api/groups", {
    method: "POST",
    body: JSON.stringify({
      name: "Karbon Trip",
      participants: [{ name: state.user.name, color: COLORS[0], isPrimary: true }]
    })
  });
}

async function refreshGroups() {
  const { groups } = await api("/api/groups");
  state.groups = groups;
  if (!state.activeGroupId || !groups.some((group) => group.id === state.activeGroupId)) {
    state.activeGroupId = groups[0]?.id || null;
  }
  if (state.activeGroupId) await refreshDashboard();
}

async function refreshDashboard() {
  if (!state.activeGroupId) {
    state.dashboard = null;
    return;
  }
  state.dashboard = await api(`/api/groups/${state.activeGroupId}/dashboard`);
}

function render() {
  const loggedIn = Boolean(state.user && state.token);
  $("auth-view").classList.toggle("hidden", loggedIn);
  $("app-view").classList.toggle("hidden", !loggedIn);
  if (!loggedIn) return;
  $("current-user").textContent = state.user.email;
  renderGroups();
  renderGroupDashboard();
}

function activeGroup() {
  return state.dashboard?.group || state.groups.find((group) => group.id === state.activeGroupId);
}

function groupExpenses() {
  return state.dashboard?.expenses || [];
}

function renderGroups() {
  $("group-list").innerHTML = state.groups.map((group) => `
    <button class="group-item ${group.id === state.activeGroupId ? "active" : ""}" type="button" data-group-id="${group.id}">
      <strong>${escapeHtml(group.name)}</strong>
      <span>${group.participants.length} participants - ${money(group.totalSpent || 0)} spent</span>
    </button>
  `).join("");
  document.querySelectorAll(".group-item").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeGroupId = button.dataset.groupId;
      clearExpenseForm();
      await refreshDashboard();
      render();
    });
  });
}

function renderGroupDashboard() {
  const group = activeGroup();
  if (!group) {
    $("group-title").textContent = "Dashboard";
    $("group-subtitle").textContent = "Create a group to start tracking expenses.";
    return;
  }
  const expenses = groupExpenses();
  const balances = state.dashboard.balances;
  const primary = group.participants.find((participant) => participant.isPrimary);
  const userBalance = balances.net[primary?.id] || 0;
  $("group-title").textContent = group.name;
  $("group-subtitle").textContent = `${group.participants.length} participants - ${expenses.length} transactions`;
  $("total-spent").textContent = money(expenses.reduce((sum, expense) => sum + expense.amount, 0));
  $("you-owe").textContent = money(Math.max(0, -userBalance));
  $("owed-to-you").textContent = money(Math.max(0, userBalance));
  $("expense-count").textContent = expenses.length;
  renderExpenseFormOptions();
  renderSplitParticipants();
  renderParticipantFilter();
  renderBalanceTable(balances);
  renderSettlements(balances.settlements);
  renderCharts(balances);
  renderExpenseHistory();
}

function openGroupDialog(group) {
  $("group-dialog-title").textContent = group ? "Edit group" : "New group";
  $("group-id").value = group?.id || "";
  $("group-name").value = group?.name || "";
  state.editingParticipants = group
    ? structuredClone(group.participants)
    : [{ id: uid(), name: state.user.name, color: COLORS[0], avatar: initials(state.user.name), isPrimary: true }];
  renderParticipantEditor();
  $("group-error").textContent = "";
  $("group-dialog").showModal();
}

function addParticipantEditorRow() {
  if (state.editingParticipants.length >= 4) {
    $("group-error").textContent = "A group can have the primary user plus up to 3 participants.";
    return;
  }
  const next = state.editingParticipants.length;
  state.editingParticipants.push({ id: uid(), name: "", color: COLORS[next % COLORS.length], avatar: "", isPrimary: false });
  renderParticipantEditor();
}

function renderParticipantEditor() {
  $("participant-editor").innerHTML = state.editingParticipants.map((participant, index) => `
    <div class="participant-row" data-index="${index}">
      <input type="text" value="${escapeHtml(participant.name)}" placeholder="Participant name" ${participant.isPrimary ? "readonly" : ""} />
      <input type="color" value="${participant.color || COLORS[index % COLORS.length]}" />
      <button class="icon-btn" type="button" title="Remove participant" ${participant.isPrimary ? "disabled" : ""}>x</button>
    </div>
  `).join("");
  document.querySelectorAll(".participant-row").forEach((row) => {
    const index = Number(row.dataset.index);
    row.querySelector("input[type='text']").addEventListener("input", (event) => {
      state.editingParticipants[index].name = event.target.value;
      state.editingParticipants[index].avatar = initials(event.target.value);
    });
    row.querySelector("input[type='color']").addEventListener("input", (event) => {
      state.editingParticipants[index].color = event.target.value;
    });
    row.querySelector("button").addEventListener("click", () => removeParticipantEditorRow(index));
  });
}

function removeParticipantEditorRow(index) {
  const participant = state.editingParticipants[index];
  if (!participant || participant.isPrimary) return;
  const linked = groupExpenses().some((expense) =>
    expense.payerId === participant.id || expense.splits.some((split) => split.participantId === participant.id)
  );
  if (linked && !confirm("This participant is linked to expenses. Remove them and delete affected expenses?")) return;
  state.editingParticipants.splice(index, 1);
  renderParticipantEditor();
}

async function saveGroup(event) {
  event.preventDefault();
  const groupId = $("group-id").value;
  const payload = {
    name: $("group-name").value.trim(),
    participants: state.editingParticipants
      .map((participant, index) => ({
        ...participant,
        name: participant.name.trim(),
        color: participant.color || COLORS[index % COLORS.length],
        avatar: initials(participant.name)
      }))
      .filter((participant) => participant.name)
  };
  try {
    if (groupId) {
      await api(`/api/groups/${groupId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      const { group } = await api("/api/groups", { method: "POST", body: JSON.stringify(payload) });
      state.activeGroupId = group.id;
    }
    $("group-dialog").close();
    await refreshGroups();
    render();
  } catch (error) {
    $("group-error").textContent = error.message;
  }
}

async function deleteActiveGroup() {
  const group = activeGroup();
  if (!group) return;
  if (!confirm(`Delete "${group.name}" and all linked expenses?`)) return;
  await api(`/api/groups/${group.id}`, { method: "DELETE" });
  state.activeGroupId = null;
  await refreshGroups();
  if (state.groups.length === 0) await createDefaultGroup();
  await refreshGroups();
  render();
}

function renderExpenseFormOptions() {
  const group = activeGroup();
  $("expense-payer").innerHTML = group.participants.map((participant) => `<option value="${participant.id}">${escapeHtml(participant.name)}</option>`).join("");
}

function renderSplitParticipants() {
  const group = activeGroup();
  if (!group) return;
  const mode = $("split-mode").value;
  const amount = Number($("expense-amount").value || 0);
  $("split-participants").innerHTML = group.participants.map((participant) => {
    const equalValue = mode === "equal" ? evenSplit(amount, group.participants.map((item) => item.id))[participant.id] || 0 : "";
    const disabled = mode === "equal" ? "disabled" : "";
    return `<div class="split-row">
      <input type="checkbox" checked data-participant-check="${participant.id}" />
      <span><span class="avatar-dot" style="display:inline-block;background:${participant.color}"></span> ${escapeHtml(participant.name)}</span>
      <input type="number" min="0" step="0.01" value="${equalValue}" ${disabled} data-participant-value="${participant.id}" />
    </div>`;
  }).join("");
}

async function saveExpense(event) {
  event.preventDefault();
  const group = activeGroup();
  const id = $("expense-id").value;
  const amount = round2(Number($("expense-amount").value));
  const mode = $("split-mode").value;
  const selectedIds = [...document.querySelectorAll("[data-participant-check]:checked")].map((input) => input.dataset.participantCheck);
  const splitResult = buildSplits(selectedIds, amount, mode);
  if (splitResult.error) {
    $("expense-error").textContent = splitResult.error;
    return;
  }
  const payload = {
    amount,
    description: $("expense-description").value.trim(),
    date: $("expense-date").value,
    payerId: $("expense-payer").value,
    mode,
    splits: splitResult.values
  };
  try {
    if (id) {
      await api(`/api/expenses/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api(`/api/groups/${group.id}/expenses`, { method: "POST", body: JSON.stringify(payload) });
    }
    clearExpenseForm();
    await refreshGroups();
    render();
  } catch (error) {
    $("expense-error").textContent = error.message;
  }
}

function buildSplits(selectedIds, amount, mode) {
  if (selectedIds.length === 0) return { error: "Select at least one participant." };
  if (!amount || amount <= 0) return { error: "Amount must be greater than zero." };
  if (mode === "equal") {
    const equal = evenSplit(amount, selectedIds);
    return { values: selectedIds.map((participantId) => ({ participantId, amount: equal[participantId] })) };
  }
  const inputs = selectedIds.map((participantId) => ({
    participantId,
    value: Number(document.querySelector(`[data-participant-value="${participantId}"]`).value || 0)
  }));
  if (mode === "custom") {
    const total = round2(inputs.reduce((sum, item) => sum + item.value, 0));
    if (total !== amount) return { error: `Custom split must total ${money(amount)}.` };
    return { values: inputs.map((item) => ({ participantId: item.participantId, amount: round2(item.value) })) };
  }
  const percentTotal = round2(inputs.reduce((sum, item) => sum + item.value, 0));
  if (percentTotal !== 100) return { error: "Percentage split must total 100%." };
  return { values: distributeRounding(inputs.map((item) => ({ participantId: item.participantId, raw: (amount * item.value) / 100 })), amount) };
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

function distributeRounding(items, amount) {
  const targetCents = Math.round(amount * 100);
  const rounded = items.map((item) => ({
    participantId: item.participantId,
    amount: Math.floor(item.raw * 100) / 100,
    fraction: item.raw % 0.01
  }));
  let cents = targetCents - Math.round(rounded.reduce((sum, item) => sum + item.amount, 0) * 100);
  rounded.sort((a, b) => b.fraction - a.fraction);
  let index = 0;
  while (cents > 0) {
    rounded[index % rounded.length].amount = round2(rounded[index % rounded.length].amount + 0.01);
    cents -= 1;
    index += 1;
  }
  return rounded.map(({ participantId, amount }) => ({ participantId, amount }));
}

function clearExpenseForm() {
  $("expense-id").value = "";
  $("expense-description").value = "";
  $("expense-amount").value = "";
  $("expense-date").value = new Date().toISOString().slice(0, 10);
  $("split-mode").value = "equal";
  $("expense-error").textContent = "";
  renderExpenseFormOptions();
  renderSplitParticipants();
}

function editExpense(id) {
  const expense = groupExpenses().find((item) => item.id === id);
  if (!expense) return;
  $("expense-id").value = expense.id;
  $("expense-description").value = expense.description;
  $("expense-amount").value = expense.amount;
  $("expense-date").value = expense.date;
  $("expense-payer").value = expense.payerId;
  $("split-mode").value = expense.mode;
  renderSplitParticipants();
  document.querySelectorAll("[data-participant-check]").forEach((input) => {
    input.checked = false;
  });
  expense.splits.forEach((split) => {
    const check = document.querySelector(`[data-participant-check="${split.participantId}"]`);
    const input = document.querySelector(`[data-participant-value="${split.participantId}"]`);
    if (check) check.checked = true;
    if (input) {
      input.value = expense.mode === "percentage" ? round2((split.amount / expense.amount) * 100) : split.amount;
    }
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteExpense(id) {
  if (!confirm("Delete this expense?")) return;
  await api(`/api/expenses/${id}`, { method: "DELETE" });
  await refreshGroups();
  render();
}

function renderBalanceTable(balances) {
  const group = activeGroup();
  $("balance-table").innerHTML = group.participants.map((participant) => {
    const value = balances.net[participant.id] || 0;
    const label = value > 0 ? `gets back ${money(value)}` : value < 0 ? `owes ${money(Math.abs(value))}` : "settled";
    return `<div class="balance-row">
      <span class="ledger-dot" style="background:${participant.color}"></span>
      <div><strong>${escapeHtml(participant.name)}</strong><div class="balance-meta">${label}</div></div>
      <strong>${money(value)}</strong>
    </div>`;
  }).join("");
}

function renderSettlements(settlements) {
  const group = activeGroup();
  if (!settlements.length) {
    $("settlements").innerHTML = `<div class="settlement-row"><span>All balances are settled.</span></div>`;
    return;
  }
  $("settlements").innerHTML = settlements.map((item) => {
    const from = group.participants.find((participant) => participant.id === item.from);
    const to = group.participants.find((participant) => participant.id === item.to);
    return `<div class="settlement-row">
      <span><strong>${escapeHtml(from.name)}</strong> pays <strong>${escapeHtml(to.name)}</strong></span>
      <strong>${money(item.amount)}</strong>
    </div>`;
  }).join("");
}

function renderCharts(balances) {
  renderChart("contribution-chart", balances.paid);
  renderChart("share-chart", balances.shares);
}

function renderChart(id, values) {
  const group = activeGroup();
  const max = Math.max(...Object.values(values), 1);
  $(id).innerHTML = group.participants.map((participant) => {
    const value = values[participant.id] || 0;
    const width = Math.max(3, (value / max) * 100);
    return `<div class="chart-row">
      <strong>${escapeHtml(participant.name)}</strong>
      <div class="bar"><span style="width:${width}%;background:${participant.color}"></span></div>
      <span>${money(value)}</span>
    </div>`;
  }).join("");
}

function renderParticipantFilter() {
  const group = activeGroup();
  $("participant-filter").innerHTML = `<option value="">All participants</option>` +
    group.participants.map((participant) => `<option value="${participant.id}">${escapeHtml(participant.name)}</option>`).join("");
}

function renderExpenseHistory() {
  const group = activeGroup();
  const query = $("search-filter").value.trim().toLowerCase();
  const participantId = $("participant-filter").value;
  const dateFrom = $("date-from-filter").value;
  const dateTo = $("date-to-filter").value;
  const amountMin = Number($("amount-min-filter").value || 0);
  const amountMax = Number($("amount-max-filter").value || Infinity);
  const filtered = groupExpenses().filter((expense) => {
    const matchesText = !query || expense.description.toLowerCase().includes(query) || expense.category.toLowerCase().includes(query);
    const matchesParticipant = !participantId || expense.payerId === participantId || expense.splits.some((split) => split.participantId === participantId);
    const matchesDate = (!dateFrom || expense.date >= dateFrom) && (!dateTo || expense.date <= dateTo);
    const matchesAmount = expense.amount >= amountMin && expense.amount <= amountMax;
    return matchesText && matchesParticipant && matchesDate && matchesAmount;
  });
  $("expense-history").innerHTML = filtered.length ? filtered.map((expense) => {
    const payer = group.participants.find((participant) => participant.id === expense.payerId);
    return `<div class="expense-row">
      <div>
        <strong>${escapeHtml(expense.description)}</strong>
        <div class="expense-meta">${expense.date} - paid by ${escapeHtml(payer?.name || "Unknown")} - ${expense.mode} - ${expense.category}</div>
      </div>
      <div class="expense-actions">
        <strong>${money(expense.amount)}</strong>
        <button class="icon-btn" type="button" title="Edit expense" data-edit-expense="${expense.id}">e</button>
        <button class="icon-btn" type="button" title="Delete expense" data-delete-expense="${expense.id}">x</button>
      </div>
    </div>`;
  }).join("") : `<div class="expense-row"><span>No expenses match the current filters.</span></div>`;
  document.querySelectorAll("[data-edit-expense]").forEach((button) => button.addEventListener("click", () => editExpense(button.dataset.editExpense)));
  document.querySelectorAll("[data-delete-expense]").forEach((button) => button.addEventListener("click", () => deleteExpense(button.dataset.deleteExpense)));
}

function parseMintSense() {
  const text = $("mintsense-input").value.trim();
  const group = activeGroup();
  if (!text) {
    $("mintsense-output").textContent = "Enter a sentence to parse.";
    return;
  }
  const lower = text.toLowerCase();
  const amountMatch = text.match(/(?:rs\.?|inr|\$)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  const payer = group.participants.find((participant) => lower.includes(participant.name.toLowerCase()));
  const participants = group.participants.filter((participant) => lower.includes(participant.name.toLowerCase()));
  const amount = amountMatch ? Number(amountMatch[1]) : 0;
  const description = text
    .replace(/paid|split|equally|with|for|yesterday|today/gi, " ")
    .replace(/[0-9.]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Parsed expense";
  if (amount) $("expense-amount").value = amount;
  if (description) $("expense-description").value = titleCase(description);
  if (payer) $("expense-payer").value = payer.id;
  $("split-mode").value = lower.includes("%") || lower.includes("percent") ? "percentage" : "equal";
  renderSplitParticipants();
  if (participants.length) {
    document.querySelectorAll("[data-participant-check]").forEach((input) => {
      input.checked = participants.some((participant) => participant.id === input.dataset.participantCheck);
    });
  }
  $("mintsense-output").innerHTML = `<strong>Parsed:</strong> ${money(amount)} as ${escapeHtml(categorize(description))}, payer ${escapeHtml(payer?.name || "not found")}, participants ${participants.length || "all by default"}.`;
}

function categorize(description) {
  const lower = description.toLowerCase();
  if (/food|pizza|dinner|lunch|breakfast|cafe|restaurant/.test(lower)) return "Food";
  if (/cab|taxi|uber|train|bus|flight|fuel/.test(lower)) return "Travel";
  if (/movie|ticket|game|show|concert/.test(lower)) return "Entertainment";
  if (/rent|hotel|stay|room/.test(lower)) return "Stay";
  return "General";
}

function initials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "U";
}

function titleCase(value) {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setToday() {
  $("expense-date").value = new Date().toISOString().slice(0, 10);
}

init();
