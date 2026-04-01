import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const STORAGE_KEY = "financas_supabase_config_v1";
const EMBEDDED_SUPABASE_URL = "https://pakxecgwpuevczusngoo.supabase.co";
const EMBEDDED_SUPABASE_ANON_KEY = "sb_publishable_SCD8S0hgJ4gOa7CXyAh3QQ_y2dzysC7";
const SETUP_SQL = `create table if not exists public.transactions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('income','expense','credit')),
  date date not null,
  description text not null,
  category text,
  amount_cents int not null check (amount_cents >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_transactions_user_date on public.transactions(user_id, date);

create table if not exists public.bills (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  due_date date not null,
  description text not null,
  category text,
  amount_cents int not null check (amount_cents >= 0),
  status text not null check (status in ('open','paid')) default 'open',
  paid_date date,
  created_at timestamptz not null default now()
);

create index if not exists idx_bills_user_due on public.bills(user_id, due_date);

create unique index if not exists uq_bills_dedupe
on public.bills(user_id, due_date, description, amount_cents);

create table if not exists public.recurring_bills (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  category text,
  amount_cents int not null check (amount_cents >= 0),
  day_of_month int not null check (day_of_month between 1 and 28),
  start_ym text not null,
  end_ym text,
  created_at timestamptz not null default now()
);

create index if not exists idx_rb_user on public.recurring_bills(user_id);

create table if not exists public.balances (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  bank text not null,
  balance_cents int not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_balances_user_date on public.balances(user_id, date);

alter table public.transactions enable row level security;
alter table public.bills enable row level security;
alter table public.recurring_bills enable row level security;
alter table public.balances enable row level security;

create policy "transactions_rw_own" on public.transactions
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "bills_rw_own" on public.bills
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "recurring_bills_rw_own" on public.recurring_bills
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "balances_rw_own" on public.balances
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
`;

function $(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Elemento não encontrado: ${id}`);
  }
  return el;
}

function setStatus(message, tone = "info") {
  const el = $("status");
  const base = "rounded-2xl border p-4 text-sm";
  const classes =
    tone === "error"
      ? `${base} border-rose-200 bg-rose-50 text-rose-800`
      : tone === "success"
        ? `${base} border-emerald-200 bg-emerald-50 text-emerald-800`
        : `${base} border-slate-200 bg-white text-slate-700`;
  el.className = classes;
  el.textContent = message;
}

function isAuthLockError(message) {
  return String(message || "").includes("Lock broken by another request");
}

function isMissingTablesError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("could not find the table") ||
    m.includes("schema cache") ||
    m.includes("relation") ||
    m.includes("does not exist")
  );
}

function setupUI() {
  $("setup-sql").value = SETUP_SQL;
  $("btn-open-setup").classList.remove("hidden");
}

function setSettingsButtonVisible(visible) {
  $("btn-open-settings").classList.toggle("hidden", !visible);
}

function getEmbeddedConfig() {
  const fromWindow = window.__FINANCAS_SUPABASE_CONFIG__;
  const url = String(fromWindow?.url || EMBEDDED_SUPABASE_URL || "").trim();
  const anon = String(fromWindow?.anon || EMBEDDED_SUPABASE_ANON_KEY || "").trim();
  if (!url || !anon) return null;
  if (url.includes("xxxx.supabase.co")) return null;
  if (anon.includes("eyJhbGciOi")) return { url, anon };
  if (anon.startsWith("sb_publishable_")) return { url, anon };
  if (anon.startsWith("ey")) return { url, anon };
  return { url, anon };
}

function getEffectiveConfig() {
  return getEmbeddedConfig() || loadConfig();
}

async function copySetupSQL() {
  const text = $("setup-sql").value;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("SQL copiado. Cole no Supabase → SQL Editor e execute.", "success");
  } catch {
    $("setup-sql").focus();
    $("setup-sql").select();
    setStatus("Selecionei o SQL. Copie (Ctrl+C) e cole no SQL Editor do Supabase.", "info");
  }
}

function formatBRLFromCents(cents) {
  const value = (Number(cents || 0) / 100) * 1;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function parseAmountToCents(input) {
  const raw = String(input || "")
    .trim()
    .replace("R$", "")
    .trim()
    .replaceAll(".", "")
    .replaceAll(",", ".");
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new Error("Valor inválido. Exemplo: 123,45");
  }
  return Math.round(v * 100);
}

function monthRangeFromMonthInput(monthValue) {
  const [yearStr, monthStr] = String(monthValue || "").split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error("Mês inválido.");
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  return { year, month, startIso, endIso };
}

function nowISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowISOMonth() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function kindLabel(kind) {
  if (kind === "income") return "Entrada";
  if (kind === "expense") return "Despesa";
  if (kind === "credit") return "Fatura";
  return kind;
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.url || !parsed.anon) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveConfig(url, anon) {
  const payload = { url: String(url || "").trim(), anon: String(anon || "").trim() };
  if (!payload.url || !payload.anon) {
    throw new Error("Preencha SUPABASE_URL e SUPABASE_ANON_KEY.");
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    throw new Error("Não foi possível salvar no navegador. Tente fora do modo anônimo/privado e permita armazenamento do site.");
  }
  return payload;
}

function clearConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}

let supabase = null;
let authSubscriptionUnsubscribe = null;
let refreshInFlight = false;
let refreshQueued = false;
let authActionInFlight = false;

function getConfigFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("supabase_url") || params.get("SUPABASE_URL");
  const anon = params.get("supabase_anon_key") || params.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  return { url, anon };
}

function stripSensitiveUrlParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("supabase_url");
  url.searchParams.delete("SUPABASE_URL");
  url.searchParams.delete("supabase_anon_key");
  url.searchParams.delete("SUPABASE_ANON_KEY");
  history.replaceState(null, "", url.toString());
}

async function ensureClient() {
  if (supabase) return supabase;
  const cfg = getEffectiveConfig();
  if (!cfg) {
    setSettingsButtonVisible(true);
    showOnly("settings");
    setStatus("Configure o Supabase para continuar.", "error");
    return null;
  }
  setSettingsButtonVisible(!getEmbeddedConfig());
  supabase = createClient(cfg.url, cfg.anon);
  return supabase;
}

function showOnly(section) {
  const ids = ["settings", "setup", "auth", "app"];
  for (const id of ids) {
    const el = $(id);
    el.classList.toggle("hidden", id !== section);
  }
  $("btn-signout").classList.toggle("hidden", section !== "app");
}

function syncSettingsUI() {
  const cfg = loadConfig();
  $("supabase-url").value = cfg?.url || "";
  $("supabase-anon").value = cfg?.anon || "";
}

function openSettings() {
  syncSettingsUI();
  $("settings").classList.remove("hidden");
}

function closeSettings() {
  $("settings").classList.add("hidden");
}

function setKpis({ incomeCents, expenseCents, creditCents, netCents, balanceCents, billsOpenCents }) {
  $("kpi-income").textContent = formatBRLFromCents(incomeCents);
  $("kpi-expense").textContent = formatBRLFromCents(expenseCents);
  $("kpi-credit").textContent = formatBRLFromCents(creditCents);
  $("kpi-net").textContent = formatBRLFromCents(netCents);
  $("kpi-balance").textContent = balanceCents == null ? "—" : formatBRLFromCents(balanceCents);
  $("kpi-bills-open").textContent = formatBRLFromCents(billsOpenCents);
  $("kpi-net").classList.toggle("text-rose-700", netCents < 0);
  $("kpi-net").classList.toggle("text-emerald-700", netCents >= 0);
}

function renderTxRows(rows) {
  const tbody = $("tx-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${r.date}</td>
      <td class="px-3 py-2 whitespace-nowrap">${kindLabel(r.kind)}</td>
      <td class="px-3 py-2">${escapeHtml(r.description)}</td>
      <td class="px-3 py-2">${escapeHtml(r.category || "")}</td>
      <td class="px-3 py-2 whitespace-nowrap font-medium">${formatBRLFromCents(r.amount_cents)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-right">
        <button data-tx-id="${r.id}" class="btn-del-tx rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".btn-del-tx").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-tx-id"));
      await deleteTx(id);
    });
  });
}

function renderBillsRows(rows) {
  const tbody = $("bills-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const status = r.status === "paid" ? "PAGA" : "ABERTA";
    const paidInfo = r.paid_date ? ` (${r.paid_date})` : "";
    const action =
      r.status === "open"
        ? `<button data-bill-id="${r.id}" class="btn-pay-bill rounded-lg bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800">Marcar paga</button>`
        : `<button data-bill-id="${r.id}" class="btn-unpay-bill rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50">Reabrir</button>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${r.due_date}</td>
      <td class="px-3 py-2 whitespace-nowrap">${status}${paidInfo}</td>
      <td class="px-3 py-2">${escapeHtml(r.description)}</td>
      <td class="px-3 py-2">${escapeHtml(r.category || "")}</td>
      <td class="px-3 py-2 whitespace-nowrap font-medium">${formatBRLFromCents(r.amount_cents)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-right">${action}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".btn-pay-bill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-bill-id"));
      await payBill(id);
    });
  });
  tbody.querySelectorAll(".btn-unpay-bill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-bill-id"));
      await reopenBill(id);
    });
  });
}

function renderRecurringRows(rows) {
  const tbody = $("rb-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2">${escapeHtml(r.description)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${r.day_of_month}</td>
      <td class="px-3 py-2 whitespace-nowrap font-medium">${formatBRLFromCents(r.amount_cents)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-right">
        <button data-rb-id="${r.id}" class="btn-del-rb rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".btn-del-rb").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-rb-id"));
      await deleteRecurring(id);
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getUserId() {
  const client = await ensureClient();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data?.user?.id || null;
}

async function requireAuth() {
  const client = await ensureClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  if (data?.session?.user) return data.session.user;
  return null;
}

async function refreshDashboard() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) {
    showOnly("auth");
    setStatus("Entre para acessar seus dados.", "info");
    return;
  }

  $("user-label").textContent = user.email ? `Conectado: ${user.email}` : `Conectado`;

  const { startIso, endIso } = monthRangeFromMonthInput($("month-picker").value);
  setStatus("Carregando dados…");

  const txPromise = client
    .from("transactions")
    .select("id, kind, date, description, category, amount_cents")
    .gte("date", startIso)
    .lt("date", endIso)
    .order("date", { ascending: true })
    .order("id", { ascending: true });

  const billsPromise = client
    .from("bills")
    .select("id, due_date, description, category, amount_cents, status, paid_date")
    .gte("due_date", startIso)
    .lt("due_date", endIso)
    .order("due_date", { ascending: true })
    .order("id", { ascending: true });

  const balancePromise = client
    .from("balances")
    .select("id, date, bank, balance_cents")
    .gte("date", startIso)
    .lt("date", endIso)
    .order("date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  const recurringPromise = client
    .from("recurring_bills")
    .select("id, description, category, amount_cents, day_of_month, start_ym, end_ym")
    .order("description", { ascending: true });

  const [txRes, billsRes, balRes, rbRes] = await Promise.all([txPromise, billsPromise, balancePromise, recurringPromise]);

  const firstError = txRes.error || billsRes.error || balRes.error || rbRes.error;
  if (firstError) {
    setupUI();
    if (isMissingTablesError(firstError.message)) {
      showOnly("setup");
      setStatus("As tabelas ainda não existem no Supabase. Use o Setup do banco para criar tudo.", "error");
      return;
    }
    setStatus(
      `Erro ao ler dados: ${firstError.message}. Se for a primeira vez, crie as tabelas e as políticas no Supabase.`,
      "error",
    );
    return;
  }

  const txRows = txRes.data || [];
  const billRows = billsRes.data || [];
  const rbRows = rbRes.data || [];

  let incomeCents = 0;
  let expenseCents = 0;
  let creditCents = 0;
  for (const r of txRows) {
    if (r.kind === "income") incomeCents += r.amount_cents;
    if (r.kind === "expense") expenseCents += r.amount_cents;
    if (r.kind === "credit") creditCents += r.amount_cents;
  }

  let billsOpenCents = 0;
  let billsPaidCents = 0;
  for (const r of billRows) {
    if (r.status === "open") billsOpenCents += r.amount_cents;
    if (r.status === "paid") billsPaidCents += r.amount_cents;
  }

  const netCents = incomeCents - (expenseCents + creditCents + billsPaidCents);
  const balanceCents = balRes.data ? balRes.data.balance_cents : null;

  setKpis({ incomeCents, expenseCents, creditCents, netCents, balanceCents, billsOpenCents });
  renderTxRows(txRows);
  renderBillsRows(billRows);
  renderRecurringRows(rbRows);
  showOnly("app");
  setStatus("Pronto.", "success");
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshDashboard();
    }
  }
}

async function addTx() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const kind = $("tx-kind").value;
  const date = $("tx-date").value;
  const description = $("tx-desc").value.trim();
  const category = $("tx-cat").value.trim() || null;
  const amount_cents = parseAmountToCents($("tx-amount").value);

  if (!date) throw new Error("Informe a data.");
  if (!description) throw new Error("Informe a descrição.");

  const { error } = await client.from("transactions").insert([{ user_id: user.id, kind, date, description, category, amount_cents }]);
  if (error) throw new Error(error.message);

  $("tx-desc").value = "";
  $("tx-cat").value = "";
  $("tx-amount").value = "";
  await refreshDashboard();
}

async function deleteTx(id) {
  const client = await ensureClient();
  if (!client) return;
  const { error } = await client.from("transactions").delete().eq("id", id);
  if (error) {
    setStatus(`Erro ao excluir: ${error.message}`, "error");
    return;
  }
  await refreshDashboard();
}

async function addBill() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const due_date = $("bill-due").value;
  const description = $("bill-desc").value.trim();
  const category = $("bill-cat").value.trim() || null;
  const amount_cents = parseAmountToCents($("bill-amount").value);

  if (!due_date) throw new Error("Informe o vencimento.");
  if (!description) throw new Error("Informe a descrição.");

  const { error } = await client.from("bills").insert([{ user_id: user.id, due_date, description, category, amount_cents, status: "open" }]);
  if (error) throw new Error(error.message);

  $("bill-desc").value = "";
  $("bill-cat").value = "";
  $("bill-amount").value = "";
  await refreshDashboard();
}

async function payBill(id) {
  const client = await ensureClient();
  if (!client) return;
  const paid_date = nowISODate();
  const { error } = await client.from("bills").update({ status: "paid", paid_date }).eq("id", id);
  if (error) {
    setStatus(`Erro ao marcar como paga: ${error.message}`, "error");
    return;
  }
  await refreshDashboard();
}

async function reopenBill(id) {
  const client = await ensureClient();
  if (!client) return;
  const { error } = await client.from("bills").update({ status: "open", paid_date: null }).eq("id", id);
  if (error) {
    setStatus(`Erro ao reabrir: ${error.message}`, "error");
    return;
  }
  await refreshDashboard();
}

async function addBalance() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const date = $("bal-date").value;
  const bank = $("bal-bank").value.trim();
  const balance_cents = parseAmountToCents($("bal-amount").value);

  if (!date) throw new Error("Informe a data.");
  if (!bank) throw new Error("Informe o banco/conta.");

  const { error } = await client.from("balances").insert([{ user_id: user.id, date, bank, balance_cents }]);
  if (error) throw new Error(error.message);

  $("bal-amount").value = "";
  await refreshDashboard();
}

function monthInputToYm(monthValue) {
  const { year, month } = monthRangeFromMonthInput(monthValue);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function ymToInt(ym) {
  const [y, m] = String(ym).split("-");
  return Number(y) * 100 + Number(m);
}

async function addRecurringBill() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const description = $("rb-desc").value.trim();
  const category = $("rb-cat").value.trim() || null;
  const amount_cents = parseAmountToCents($("rb-amount").value);
  const day_of_month = Number($("rb-day").value);
  const start_ym = monthInputToYm($("rb-start").value);
  const endMonth = $("rb-end").value.trim();
  const end_ym = endMonth ? monthInputToYm(endMonth) : null;

  if (!description) throw new Error("Informe a descrição.");
  if (!Number.isFinite(day_of_month) || day_of_month < 1 || day_of_month > 28) throw new Error("Dia inválido (1–28).");

  const { error } = await client
    .from("recurring_bills")
    .insert([{ user_id: user.id, description, category, amount_cents, day_of_month, start_ym, end_ym }]);
  if (error) throw new Error(error.message);

  $("rb-desc").value = "";
  $("rb-cat").value = "";
  $("rb-amount").value = "";
  await refreshDashboard();
}

async function deleteRecurring(id) {
  const client = await ensureClient();
  if (!client) return;
  const { error } = await client.from("recurring_bills").delete().eq("id", id);
  if (error) {
    setStatus(`Erro ao excluir: ${error.message}`, "error");
    return;
  }
  await refreshDashboard();
}

async function generateRecurringForSelectedMonth() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const { year, month, startIso, endIso } = monthRangeFromMonthInput($("month-picker").value);
  const ym = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  const ymInt = ymToInt(ym);

  const rbRes = await client.from("recurring_bills").select("id, description, category, amount_cents, day_of_month, start_ym, end_ym");
  if (rbRes.error) throw new Error(rbRes.error.message);

  const existingBillsRes = await client
    .from("bills")
    .select("due_date, description, amount_cents")
    .gte("due_date", startIso)
    .lt("due_date", endIso);
  if (existingBillsRes.error) throw new Error(existingBillsRes.error.message);

  const existingKey = new Set((existingBillsRes.data || []).map((b) => `${b.due_date}|${b.description}|${b.amount_cents}`));
  const inserts = [];

  for (const r of rbRes.data || []) {
    const startInt = ymToInt(r.start_ym);
    const endInt = r.end_ym ? ymToInt(r.end_ym) : null;
    if (ymInt < startInt) continue;
    if (endInt != null && ymInt > endInt) continue;

    const due = `${ym}-${String(r.day_of_month).padStart(2, "0")}`;
    const key = `${due}|${r.description}|${r.amount_cents}`;
    if (existingKey.has(key)) continue;

    inserts.push({
      user_id: user.id,
      due_date: due,
      description: r.description,
      category: r.category || null,
      amount_cents: r.amount_cents,
      status: "open",
      paid_date: null,
    });
  }

  if (!inserts.length) {
    setStatus("Nenhuma conta recorrente para criar (ou já existem).", "info");
    return;
  }

  const insRes = await client.from("bills").insert(inserts);
  if (insRes.error) throw new Error(insRes.error.message);
  await refreshDashboard();
}

async function signIn() {
  if (authActionInFlight) return;
  authActionInFlight = true;
  try {
  const client = await ensureClient();
  if (!client) return;
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || !password) throw new Error("Informe e-mail e senha.");

  let res = await client.auth.signInWithPassword({ email, password });
  if (res.error && isAuthLockError(res.error.message)) {
    await new Promise((r) => setTimeout(r, 400));
    res = await client.auth.signInWithPassword({ email, password });
  }
  if (res.error) throw new Error(res.error.message);
  await refreshDashboard();
  } finally {
    authActionInFlight = false;
  }
}

async function signUp() {
  if (authActionInFlight) return;
  authActionInFlight = true;
  try {
  const client = await ensureClient();
  if (!client) return;
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || !password) throw new Error("Informe e-mail e senha.");

  let res = await client.auth.signUp({ email, password });
  if (res.error && isAuthLockError(res.error.message)) {
    await new Promise((r) => setTimeout(r, 400));
    res = await client.auth.signUp({ email, password });
  }
  if (res.error) throw new Error(res.error.message);
  setStatus("Conta criada. Se o seu Supabase exigir confirmação por e-mail, confirme e depois entre.", "success");
  } finally {
    authActionInFlight = false;
  }
}

async function signOut() {
  const client = await ensureClient();
  if (!client) return;
  await client.auth.signOut();
  showOnly("auth");
  setStatus("Saiu.", "info");
}

function bindUI() {
  $("btn-open-settings").addEventListener("click", openSettings);
  $("btn-close-settings").addEventListener("click", closeSettings);
  $("btn-open-setup").addEventListener("click", () => showOnly("setup"));
  $("btn-close-setup").addEventListener("click", () => showOnly("auth"));
  $("btn-back-to-auth").addEventListener("click", () => showOnly("auth"));
  $("btn-copy-setup").addEventListener("click", copySetupSQL);

  $("btn-save-settings").addEventListener("click", async () => {
    try {
      saveConfig($("supabase-url").value, $("supabase-anon").value);
      supabase = null;
      closeSettings();
      await bootstrap();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-clear-settings").addEventListener("click", async () => {
    clearConfig();
    supabase = null;
    syncSettingsUI();
    await bootstrap();
  });

  $("btn-signin").addEventListener("click", async () => {
    try {
      await signIn();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-signup").addEventListener("click", async () => {
    try {
      await signUp();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-signout").addEventListener("click", signOut);
  $("btn-refresh").addEventListener("click", refreshDashboard);

  $("btn-add-tx").addEventListener("click", async () => {
    try {
      await addTx();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-add-bill").addEventListener("click", async () => {
    try {
      await addBill();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-add-balance").addEventListener("click", async () => {
    try {
      await addBalance();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-add-recurring").addEventListener("click", async () => {
    try {
      await addRecurringBill();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-generate-recurring").addEventListener("click", async () => {
    try {
      await generateRecurringForSelectedMonth();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("month-picker").addEventListener("change", refreshDashboard);
}

async function bootstrap() {
  $("month-picker").value = nowISOMonth();
  $("tx-date").value = nowISODate();
  $("bill-due").value = nowISODate();
  $("bal-date").value = nowISODate();
  $("rb-start").value = nowISOMonth();
  $("rb-day").value = "5";

  const fromUrl = getConfigFromUrlParams();
  if (fromUrl) {
    try {
      saveConfig(fromUrl.url, fromUrl.anon);
      supabase = null;
      stripSensitiveUrlParams();
    } catch (e) {
      setSettingsButtonVisible(true);
      showOnly("settings");
      syncSettingsUI();
      setStatus(String(e?.message || e), "error");
      return;
    }
  }

  const existing = getEffectiveConfig();
  if (!existing) {
    setSettingsButtonVisible(true);
    showOnly("settings");
    syncSettingsUI();
    setStatus("Configure o Supabase para continuar. Depois disso, a tela inicial será o login.", "info");
    return;
  }

  showOnly("auth");
  setStatus("Entre para acessar seus dados.", "info");

  const client = await ensureClient();
  if (!client) return;
  setupUI();

  if (authSubscriptionUnsubscribe) {
    authSubscriptionUnsubscribe();
    authSubscriptionUnsubscribe = null;
  }
  const { data } = client.auth.onAuthStateChange(async () => {
    await refreshDashboard();
  });
  if (data?.subscription) {
    authSubscriptionUnsubscribe = () => data.subscription.unsubscribe();
  }

  const user = await requireAuth();
  if (!user) {
    showOnly("auth");
    setStatus("Entre para acessar seus dados.", "info");
    return;
  }

  await refreshDashboard();
}

bindUI();
bootstrap().catch((e) => setStatus(String(e?.message || e), "error"));
