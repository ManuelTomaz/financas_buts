import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const STORAGE_KEY = "financas_supabase_config_v1";
const EMBEDDED_SUPABASE_URL = "https://pakxecgwpuevczusngoo.supabase.co";
const EMBEDDED_SUPABASE_ANON_KEY = "sb_publishable_SCD8S0hgJ4gOa7CXyAh3QQ_y2dzysC7";
const AUTH_EMAIL_KEY = "financas_auth_email_v1";
const AUTH_REMEMBER_EMAIL_KEY = "financas_auth_remember_email_v1";
const UI_ACTIVE_TAB_KEY = "financas_active_tab_v1";
const SETUP_SQL = `create table if not exists public.cards (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  limit_cents int,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_cards_user_name on public.cards(user_id, name);

create table if not exists public.categories (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('income','expense','credit','bill')),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_categories_user_kind_name on public.categories(user_id, kind, name);

create table if not exists public.transactions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('income','expense','credit')),
  card_id bigint references public.cards(id) on delete set null,
  date date not null,
  description text not null,
  category text,
  amount_cents int not null check (amount_cents >= 0),
  created_at timestamptz not null default now()
);

alter table public.transactions add column if not exists card_id bigint references public.cards(id) on delete set null;

create index if not exists idx_transactions_user_date on public.transactions(user_id, date);
create index if not exists idx_transactions_user_card_date on public.transactions(user_id, card_id, date);

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

alter table public.cards enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.bills enable row level security;
alter table public.recurring_bills enable row level security;
alter table public.balances enable row level security;

drop policy if exists "cards_rw_own" on public.cards;
create policy "cards_rw_own" on public.cards
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "categories_rw_own" on public.categories;
create policy "categories_rw_own" on public.categories
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "transactions_rw_own" on public.transactions;
create policy "transactions_rw_own" on public.transactions
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bills_rw_own" on public.bills;
create policy "bills_rw_own" on public.bills
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "recurring_bills_rw_own" on public.recurring_bills;
create policy "recurring_bills_rw_own" on public.recurring_bills
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "balances_rw_own" on public.balances;
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

function kindLabel(kind) {
  if (kind === "income") return "Entrada";
  if (kind === "expense") return "Despesa";
  if (kind === "credit") return "Cartão";
  if (kind === "bill") return "Conta";
  return kind;
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

function getActiveTab() {
  const raw = localStorage.getItem(UI_ACTIVE_TAB_KEY);
  if (raw === "dashboard" || raw === "lancar" || raw === "contas" || raw === "relatorios" || raw === "cadastros") return raw;
  return "dashboard";
}

function setActiveTab(tab) {
  localStorage.setItem(UI_ACTIVE_TAB_KEY, tab);
  const app = $("app");
  const tabTargets = app.querySelectorAll("[data-tab-target]");
  tabTargets.forEach((btn) => {
    const isActive = btn.getAttribute("data-tab-target") === tab;
    btn.classList.toggle("bg-slate-900", isActive);
    btn.classList.toggle("text-white", isActive);
    btn.classList.toggle("hover:bg-slate-800", isActive);
    btn.classList.toggle("text-slate-700", !isActive);
    btn.classList.toggle("hover:bg-slate-50", !isActive);
  });

  const sections = app.querySelectorAll("[data-tab]");
  sections.forEach((el) => {
    el.classList.toggle("hidden", el.getAttribute("data-tab") !== tab);
  });

  const containers = app.querySelectorAll("[data-tab-container]");
  containers.forEach((container) => {
    const anyVisible = Array.from(container.querySelectorAll("[data-tab]")).some((child) => !child.classList.contains("hidden"));
    container.classList.toggle("hidden", !anyVisible);
  });
}

function setInitialTab() {
  setActiveTab(getActiveTab());
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
let dataUserId = null;
let cardsCache = [];
let categoriesCache = [];
let seededDefaultsForUser = false;
let lastMonthSnapshot = null;

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
  supabase = createClient(cfg.url, cfg.anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: localStorage,
    },
  });
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

function readRememberEmailState() {
  return localStorage.getItem(AUTH_REMEMBER_EMAIL_KEY) === "1";
}

function applyRememberEmailState(checked) {
  localStorage.setItem(AUTH_REMEMBER_EMAIL_KEY, checked ? "1" : "0");
}

function storeRememberedEmail(email) {
  localStorage.setItem(AUTH_EMAIL_KEY, email);
}

function clearRememberedEmail() {
  localStorage.removeItem(AUTH_EMAIL_KEY);
}

function loadAuthFormDefaults() {
  const remember = readRememberEmailState();
  const rememberedEmail = localStorage.getItem(AUTH_EMAIL_KEY) || "";
  $("remember-email").checked = remember;
  if (rememberedEmail) $("auth-email").value = rememberedEmail;
}

function persistEmailIfNeeded() {
  const email = $("auth-email").value.trim();
  const remember = $("remember-email").checked;
  applyRememberEmailState(remember);
  if (remember && email) storeRememberedEmail(email);
  if (!remember) clearRememberedEmail();
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

function findCardNameById(cardId) {
  if (!cardId) return "";
  const c = cardsCache.find((x) => x.id === cardId);
  return c?.name || "";
}

function renderTxRows(rows) {
  const tbody = $("tx-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const cardName = r.card?.name || findCardNameById(r.card_id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${r.date}</td>
      <td class="px-3 py-2 whitespace-nowrap">${kindLabel(r.kind)}</td>
      <td class="px-3 py-2">${escapeHtml(r.description)}</td>
      <td class="px-3 py-2">${escapeHtml(r.category || "")}</td>
      <td class="px-3 py-2">${escapeHtml(cardName)}</td>
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

function renderCardsRegistry(rows) {
  const tbody = $("cards-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2">${escapeHtml(r.name)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${r.limit_cents == null ? "—" : formatBRLFromCents(r.limit_cents)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-right">
        <button data-card-id="${r.id}" class="btn-del-card rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".btn-del-card").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-card-id"));
      await deleteCard(id);
    });
  });
}

function renderCategoriesRegistry(rows) {
  const tbody = $("categories-table");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(kindLabel(r.kind))}</td>
      <td class="px-3 py-2">${escapeHtml(r.name)}</td>
      <td class="px-3 py-2 whitespace-nowrap text-right">
        <button data-cat-id="${r.id}" class="btn-del-cat rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".btn-del-cat").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-cat-id"));
      await deleteCategory(id);
    });
  });
}

function renderCardsSummary(cards, txRows, startIso, endIso) {
  const tbody = $("cards-summary-table");
  tbody.innerHTML = "";

  const spentByCard = new Map();
  for (const t of txRows) {
    if (t.kind !== "credit") continue;
    if (!t.card_id) continue;
    spentByCard.set(t.card_id, (spentByCard.get(t.card_id) || 0) + t.amount_cents);
  }

  for (const c of cards) {
    const spent = spentByCard.get(c.id) || 0;
    const limit = c.limit_cents == null ? null : c.limit_cents;
    const available = limit == null ? null : limit - spent;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-3 py-2">${escapeHtml(c.name)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${limit == null ? "—" : formatBRLFromCents(limit)}</td>
      <td class="px-3 py-2 whitespace-nowrap font-medium text-fuchsia-700">${formatBRLFromCents(spent)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${available == null ? "—" : formatBRLFromCents(available)}</td>
    `;
    tbody.appendChild(tr);
  }

  if (!cards.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="px-3 py-3 text-slate-600" colspan="4">Nenhum cartão cadastrado. Abra “Cadastros” e adicione.</td>`;
    tbody.appendChild(tr);
  }
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

function monthKeyFromPicker() {
  const v = $("month-picker").value;
  return String(v || "");
}

function setTxKindUI() {
  const kind = $("tx-kind").value;
  $("tx-card-wrap").classList.toggle("hidden", kind !== "credit");
  rebuildCategoryDatalists();
}

function setAfterOpenBillsKpi(projectedCents, billsOpenCents) {
  const v = projectedCents - billsOpenCents;
  $("kpi-after-open-bills").textContent = formatBRLFromCents(v);
  $("kpi-after-open-bills").classList.toggle("text-rose-700", v < 0);
  $("kpi-after-open-bills").classList.toggle("text-emerald-700", v >= 0);
}

function renderMainChart({ incomeCents, expenseCents, creditCents, billsPaidCents }) {
  const svg = $("main-chart");
  const w = 520;
  const h = 120;
  const pad = 18;
  const barH = 20;

  const outflow = expenseCents + creditCents + billsPaidCents;
  const max = Math.max(incomeCents, outflow, 1);

  const incomeW = Math.round(((w - pad * 2) * incomeCents) / max);
  const outflowW = Math.round(((w - pad * 2) * outflow) / max);

  const segExpense = outflow === 0 ? 0 : Math.round((outflowW * expenseCents) / outflow);
  const segCredit = outflow === 0 ? 0 : Math.round((outflowW * creditCents) / outflow);
  const segBills = Math.max(0, outflowW - segExpense - segCredit);

  const incomeY = 32;
  const outflowY = 78;

  const textIncome = escapeHtml(formatBRLFromCents(incomeCents));
  const textOut = escapeHtml(formatBRLFromCents(outflow));

  svg.innerHTML = `
    <rect x="0" y="0" width="${w}" height="${h}" fill="transparent"></rect>

    <text x="${pad}" y="20" font-size="11" fill="#334155">Entradas</text>
    <rect x="${pad}" y="${incomeY}" rx="10" ry="10" width="${w - pad * 2}" height="${barH}" fill="#e2e8f0"></rect>
    <rect x="${pad}" y="${incomeY}" rx="10" ry="10" width="${incomeW}" height="${barH}" fill="#10b981"></rect>
    <text x="${pad}" y="${incomeY + 15}" font-size="11" fill="#0f172a">${textIncome}</text>

    <text x="${pad}" y="66" font-size="11" fill="#334155">Saídas</text>
    <rect x="${pad}" y="${outflowY}" rx="10" ry="10" width="${w - pad * 2}" height="${barH}" fill="#e2e8f0"></rect>
    <rect x="${pad}" y="${outflowY}" rx="10" ry="10" width="${outflowW}" height="${barH}" fill="#64748b"></rect>
    <rect x="${pad}" y="${outflowY}" rx="10" ry="10" width="${segExpense}" height="${barH}" fill="#ef4444"></rect>
    <rect x="${pad + segExpense}" y="${outflowY}" width="${segCredit}" height="${barH}" fill="#d946ef"></rect>
    <rect x="${pad + segExpense + segCredit}" y="${outflowY}" width="${segBills}" height="${barH}" fill="#64748b"></rect>
    <text x="${pad}" y="${outflowY + 15}" font-size="11" fill="#0f172a">${textOut}</text>
  `;
}

function rebuildCategoryDatalists() {
  const kind = $("tx-kind").value;
  const txList = $("tx-cat-list");
  const billList = $("bill-cat-list");
  txList.innerHTML = "";
  billList.innerHTML = "";

  const txOptions = categoriesCache.filter((c) => c.kind === kind).map((c) => c.name);
  for (const name of txOptions) {
    const opt = document.createElement("option");
    opt.value = name;
    txList.appendChild(opt);
  }

  const billOptions = categoriesCache.filter((c) => c.kind === "bill").map((c) => c.name);
  for (const name of billOptions) {
    const opt = document.createElement("option");
    opt.value = name;
    billList.appendChild(opt);
  }
}

function rebuildCardSelect() {
  const sel = $("tx-card");
  sel.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Selecione";
  sel.appendChild(empty);
  for (const c of cardsCache) {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
}

function openRegistry() {
  setActiveTab("cadastros");
}

function closeRegistry() {
  setActiveTab("dashboard");
}

function openMonthReport() {
  $("month-report-wrap").classList.remove("hidden");
}

function closeMonthReport() {
  $("month-report-wrap").classList.add("hidden");
}

async function copyMonthReport() {
  const text = $("month-report-text").value || "";
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Relatório copiado.", "success");
  } catch {
    $("month-report-text").focus();
    $("month-report-text").select();
    setStatus("Selecionei o relatório. Copie (Ctrl+C).", "info");
  }
}

function buildMonthReportText(snapshot) {
  if (!snapshot) return "";
  const {
    month,
    incomeCents,
    expenseCents,
    creditCents,
    billsPaidCents,
    billsOpenCents,
    openingBalanceCents,
    projectedCents,
    balanceLastCents,
    topExpenseCategories,
    topCreditByCard,
  } = snapshot;

  const lines = [];
  lines.push(`Relatório ${month}`);
  lines.push("");
  lines.push(`Saldo anterior: ${formatBRLFromCents(openingBalanceCents)}`);
  lines.push(`Saldo no mês (último): ${balanceLastCents == null ? "—" : formatBRLFromCents(balanceLastCents)}`);
  lines.push("");
  lines.push(`Entradas: ${formatBRLFromCents(incomeCents)}`);
  lines.push(`Despesas: ${formatBRLFromCents(expenseCents)}`);
  lines.push(`Cartão: ${formatBRLFromCents(creditCents)}`);
  lines.push(`Contas pagas: ${formatBRLFromCents(billsPaidCents)}`);
  lines.push(`Contas em aberto: ${formatBRLFromCents(billsOpenCents)}`);
  lines.push("");
  lines.push(`Saldo projetado (saldo anterior + entradas - saídas): ${formatBRLFromCents(projectedCents)}`);
  lines.push(`Se pagar as contas em aberto: ${formatBRLFromCents(projectedCents - billsOpenCents)}`);

  if (topExpenseCategories.length) {
    lines.push("");
    lines.push("Top despesas por categoria");
    for (const item of topExpenseCategories) {
      lines.push(`- ${item.name}: ${formatBRLFromCents(item.total_cents)}`);
    }
  }

  if (topCreditByCard.length) {
    lines.push("");
    lines.push("Cartões (gasto no mês)");
    for (const item of topCreditByCard) {
      lines.push(`- ${item.name}: ${formatBRLFromCents(item.total_cents)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function ensureDefaults(userId) {
  if (seededDefaultsForUser && dataUserId === userId) return;
  const client = await ensureClient();
  if (!client) return;

  const defaults = [
    { kind: "income", name: "Salário" },
    { kind: "income", name: "Freelance" },
    { kind: "income", name: "Outros" },
    { kind: "expense", name: "Alimentação" },
    { kind: "expense", name: "Transporte" },
    { kind: "expense", name: "Moradia" },
    { kind: "expense", name: "Saúde" },
    { kind: "expense", name: "Educação" },
    { kind: "expense", name: "Lazer" },
    { kind: "expense", name: "Assinaturas" },
    { kind: "expense", name: "Compras" },
    { kind: "expense", name: "Outros" },
    { kind: "credit", name: "Compras" },
    { kind: "credit", name: "Assinaturas" },
    { kind: "credit", name: "Outros" },
    { kind: "bill", name: "Aluguel" },
    { kind: "bill", name: "Internet" },
    { kind: "bill", name: "Energia" },
    { kind: "bill", name: "Água" },
    { kind: "bill", name: "Telefone" },
    { kind: "bill", name: "Outros" },
  ].map((d) => ({ user_id: userId, ...d }));

  const res = await client.from("categories").upsert(defaults, { onConflict: "user_id,kind,name", ignoreDuplicates: true });
  if (res.error) return;
  seededDefaultsForUser = true;
  dataUserId = userId;
}

async function loadCardsAndCategories() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  await ensureDefaults(user.id);

  const cardsRes = await client.from("cards").select("id, name, limit_cents").order("name", { ascending: true });
  const catsRes = await client.from("categories").select("id, kind, name").order("kind", { ascending: true }).order("name", { ascending: true });

  if (cardsRes.error) throw new Error(cardsRes.error.message);
  if (catsRes.error) throw new Error(catsRes.error.message);

  cardsCache = cardsRes.data || [];
  categoriesCache = catsRes.data || [];

  rebuildCardSelect();
  rebuildCategoryDatalists();
  renderCardsRegistry(cardsCache);
  renderCategoriesRegistry(categoriesCache);
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
  setActiveTab(getActiveTab());

  const { startIso, endIso } = monthRangeFromMonthInput($("month-picker").value);
  setStatus("Carregando dados…");

  const txPromise = client
    .from("transactions")
    .select("id, kind, date, description, category, amount_cents, card_id, card:cards(name)")
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

  const openingBalancePromise = client
    .from("balances")
    .select("id, date, bank, balance_cents")
    .lt("date", startIso)
    .order("date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  const recurringPromise = client
    .from("recurring_bills")
    .select("id, description, category, amount_cents, day_of_month, start_ym, end_ym")
    .order("description", { ascending: true });

  const metaPromise = loadCardsAndCategories().catch((e) => e);

  const [txRes, billsRes, balRes, openingRes, rbRes, metaRes] = await Promise.all([
    txPromise,
    billsPromise,
    balancePromise,
    openingBalancePromise,
    recurringPromise,
    metaPromise,
  ]);

  const firstError = txRes.error || billsRes.error || balRes.error || openingRes.error || rbRes.error || (metaRes instanceof Error ? metaRes : null);
  if (firstError) {
    setupUI();
    if (isMissingTablesError(firstError.message || firstError)) {
      showOnly("setup");
      setStatus("As tabelas ainda não existem no Supabase. Use o Setup do banco para criar tudo.", "error");
      return;
    }
    setStatus(
      `Erro ao ler dados: ${firstError.message || firstError}. Se for a primeira vez, crie as tabelas e as políticas no Supabase.`,
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
  const openingBalanceCents = openingRes.data ? openingRes.data.balance_cents : 0;
  const availableCents = openingBalanceCents + incomeCents;
  const projectedCents = openingBalanceCents + incomeCents - (expenseCents + creditCents + billsPaidCents);

  setKpis({ incomeCents, expenseCents, creditCents, netCents, balanceCents, billsOpenCents });
  $("kpi-opening-balance").textContent = formatBRLFromCents(openingBalanceCents);
  $("kpi-available").textContent = formatBRLFromCents(availableCents);
  $("kpi-projected").textContent = formatBRLFromCents(projectedCents);
  setAfterOpenBillsKpi(projectedCents, billsOpenCents);

  renderTxRows(txRows);
  renderBillsRows(billRows);
  renderRecurringRows(rbRows);
  renderCardsSummary(cardsCache, txRows, startIso, endIso);
  renderMainChart({ incomeCents, expenseCents, creditCents, billsPaidCents });

  const expenseByCat = new Map();
  for (const t of txRows) {
    if (t.kind !== "expense") continue;
    const key = t.category || "Sem categoria";
    expenseByCat.set(key, (expenseByCat.get(key) || 0) + t.amount_cents);
  }
  const topExpenseCategories = Array.from(expenseByCat.entries())
    .map(([name, total_cents]) => ({ name, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 8);

  const creditByCard = new Map();
  for (const t of txRows) {
    if (t.kind !== "credit") continue;
    const key = findCardNameById(t.card_id) || "Sem cartão";
    creditByCard.set(key, (creditByCard.get(key) || 0) + t.amount_cents);
  }
  const topCreditByCard = Array.from(creditByCard.entries())
    .map(([name, total_cents]) => ({ name, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents);

  lastMonthSnapshot = {
    month: $("month-picker").value,
    incomeCents,
    expenseCents,
    creditCents,
    billsPaidCents,
    billsOpenCents,
    openingBalanceCents,
    projectedCents,
    balanceLastCents: balanceCents,
    topExpenseCategories,
    topCreditByCard,
  };

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
  const card_id = kind === "credit" ? Number($("tx-card").value || "") || null : null;

  if (!date) throw new Error("Informe a data.");
  if (!description) throw new Error("Informe a descrição.");

  const { error } = await client
    .from("transactions")
    .insert([{ user_id: user.id, kind, date, description, category, amount_cents, card_id }]);
  if (error) throw new Error(error.message);

  $("tx-desc").value = "";
  $("tx-cat").value = "";
  $("tx-amount").value = "";
  $("tx-card").value = "";
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

async function addCard() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const name = $("card-name").value.trim();
  const limitRaw = $("card-limit").value.trim();
  const limit_cents = limitRaw ? parseAmountToCents(limitRaw) : null;
  if (!name) throw new Error("Informe o nome do cartão.");

  const { error } = await client.from("cards").insert([{ user_id: user.id, name, limit_cents }]);
  if (error) throw new Error(error.message);

  $("card-name").value = "";
  $("card-limit").value = "";
  await loadCardsAndCategories();
  await refreshDashboard();
}

async function deleteCard(id) {
  const client = await ensureClient();
  if (!client) return;
  const { error } = await client.from("cards").delete().eq("id", id);
  if (error) {
    setStatus(`Erro ao excluir cartão: ${error.message}`, "error");
    return;
  }
  await loadCardsAndCategories();
  await refreshDashboard();
}

async function addCategory() {
  const client = await ensureClient();
  if (!client) return;
  const user = await requireAuth();
  if (!user) return;

  const kind = $("cat-kind").value;
  const name = $("cat-name").value.trim();
  if (!name) throw new Error("Informe o nome da categoria.");

  const { error } = await client.from("categories").insert([{ user_id: user.id, kind, name }]);
  if (error) throw new Error(error.message);

  $("cat-name").value = "";
  await loadCardsAndCategories();
}

async function deleteCategory(id) {
  const client = await ensureClient();
  if (!client) return;
  const { error } = await client.from("categories").delete().eq("id", id);
  if (error) {
    setStatus(`Erro ao excluir categoria: ${error.message}`, "error");
    return;
  }
  await loadCardsAndCategories();
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

  persistEmailIfNeeded();

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

  persistEmailIfNeeded();

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

async function signInMagicLink() {
  if (authActionInFlight) return;
  authActionInFlight = true;
  try {
    const client = await ensureClient();
    if (!client) return;
    const email = $("auth-email").value.trim();
    if (!email) throw new Error("Informe seu e-mail.");

    persistEmailIfNeeded();

    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const res = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (res.error) throw new Error(res.error.message);
    setStatus("Link enviado para seu e-mail. Abra e volte para finalizar o login.", "success");
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
  loadAuthFormDefaults();
}

function bindUI() {
  $("btn-open-settings").addEventListener("click", openSettings);
  $("btn-close-settings").addEventListener("click", closeSettings);
  $("btn-open-setup").addEventListener("click", () => showOnly("setup"));
  $("btn-close-setup").addEventListener("click", () => showOnly("auth"));
  $("btn-back-to-auth").addEventListener("click", () => showOnly("auth"));
  $("btn-copy-setup").addEventListener("click", copySetupSQL);
  $("btn-close-registry").addEventListener("click", closeRegistry);

  $("tab-dashboard").addEventListener("click", () => setActiveTab("dashboard"));
  $("tab-lancar").addEventListener("click", () => setActiveTab("lancar"));
  $("tab-contas").addEventListener("click", () => setActiveTab("contas"));
  $("tab-relatorios").addEventListener("click", () => setActiveTab("relatorios"));
  $("tab-cadastros").addEventListener("click", () => setActiveTab("cadastros"));

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

  $("auth-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("btn-signin");
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Entrando...";
    setStatus("Entrando…", "info");
    try {
      await signIn();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  });

  $("btn-signup").addEventListener("click", async () => {
    const btn = $("btn-signup");
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Criando...";
    setStatus("Criando conta…", "info");
    try {
      await signUp();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  });

  $("btn-magiclink").addEventListener("click", async () => {
    const btn = $("btn-magiclink");
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando...";
    setStatus("Enviando link…", "info");
    try {
      await signInMagicLink();
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  });

  $("btn-signout").addEventListener("click", signOut);
  $("btn-refresh").addEventListener("click", refreshDashboard);

  $("tx-kind").addEventListener("change", setTxKindUI);

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

  $("btn-add-card").addEventListener("click", async () => {
    try {
      await addCard();
      setStatus("Cartão cadastrado.", "success");
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-add-category").addEventListener("click", async () => {
    try {
      await addCategory();
      setStatus("Categoria cadastrada.", "success");
    } catch (e) {
      setStatus(String(e?.message || e), "error");
    }
  });

  $("btn-month-report").addEventListener("click", () => {
    $("month-report-text").value = buildMonthReportText(lastMonthSnapshot);
    openMonthReport();
  });
  $("btn-close-report").addEventListener("click", closeMonthReport);
  $("btn-copy-report").addEventListener("click", copyMonthReport);

  $("month-picker").addEventListener("change", refreshDashboard);
}

async function bootstrap() {
  $("month-picker").value = nowISOMonth();
  $("tx-date").value = nowISODate();
  $("bill-due").value = nowISODate();
  $("bal-date").value = nowISODate();
  $("rb-start").value = nowISOMonth();
  $("rb-day").value = "5";
  closeMonthReport();
  setTxKindUI();

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
  loadAuthFormDefaults();

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
    loadAuthFormDefaults();
    return;
  }

  showOnly("app");
  setInitialTab();
  await refreshDashboard();
}

bindUI();
bootstrap().catch((e) => setStatus(String(e?.message || e), "error"));
