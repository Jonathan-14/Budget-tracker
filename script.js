const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const AUTO_BACKUP_KEY = "moneymap_v2_auto_backups";
const STORAGE = {
  transactions: "moneymap_v2_transactions",
  budgets: "moneymap_v2_budgets",
  categoryBudgets: "moneymap_v2_category_budgets",
  recurring: "moneymap_v2_recurring",
  goals: "moneymap_v2_goals",
  theme: "moneymap_v2_theme"
};
const CATEGORIES = ["Food & dining","Housing","Transportation","Shopping","Bills & utilities","Health","Entertainment","Salary","Freelance","Savings","Other"];
const COLORS = ["#16845a","#5287e8","#e97968","#e8b84d","#9270d6","#35a8a0","#df88ac","#7895a6","#c58c58","#6f9e57","#a4aca7"];
const ICONS = {"Food & dining":"◒","Housing":"⌂","Transportation":"↗","Shopping":"◇","Bills & utilities":"▤","Health":"＋","Entertainment":"♫","Salary":"↙","Freelance":"✳","Savings":"◉","Other":"•"};
let transactions = load(STORAGE.transactions, []);
let budgets = load(STORAGE.budgets, { monthly: 2500 });
let categoryBudgets = load(STORAGE.categoryBudgets, {});
let recurring = load(STORAGE.recurring, []);
let goals = load(STORAGE.goals, []);
let spendingChart = null;
let monthlyChart = null;
let toastTimer;

function load(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
let cloudClient = null;
let cloudUser = null;
let cloudReady = false;
let cloudHydrating = false;
let cloudSaveTimer = null;
let cloudRevision = null;
let cloudSaveInFlight = false;
const CLOUD_TABLE = "moneymap_sync";
const CLOUD_CONFIG = window.MONEYMAP_SUPABASE_CONFIG || {};
const cloudConfigured = Boolean(CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey && !String(CLOUD_CONFIG.url).includes("YOUR_PROJECT") && !String(CLOUD_CONFIG.anonKey).includes("YOUR_SUPABASE"));
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  createAutomaticBackup();
  if (cloudReady && cloudUser && !cloudHydrating) scheduleCloudSave();
}
function createAutomaticBackup() {
  try {
    if (typeof transactions === "undefined" || typeof budgets === "undefined" || typeof recurring === "undefined" || typeof goals === "undefined") return;
    const data = { transactions, budgets, categoryBudgets, recurring, goals, theme: load(STORAGE.theme, "light") };
    const fingerprint = JSON.stringify(data);
    const history = load(AUTO_BACKUP_KEY, []);
    if (history[0]?.fingerprint === fingerprint) return;
    history.unshift({ savedAt: new Date().toISOString(), fingerprint, data });
    localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(history.slice(0, 10)));
    updateAutoBackupStatus();
  } catch (error) {
    console.warn("MoneyMap automatic backup could not be saved", error);
    const status = $("#auto-backup-status");
    if (status) status.textContent = "Automatic backup unavailable — download a backup file to protect your data.";
  }
}
function updateAutoBackupStatus() {
  const status = $("#auto-backup-status");
  if (!status) return;
  const history = load(AUTO_BACKUP_KEY, []);
  if (!history.length) { status.textContent = "Automatic backup will be created when your data changes."; return; }
  const latest = new Date(history[0].savedAt);
  status.textContent = `Automatic backup saved on ${latest.toLocaleDateString()} at ${latest.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}. Up to ${history.length} recent versions are kept on this device.`;
}
function currentPayload() {
  return { version: 1, transactions, budgets, categoryBudgets, recurring, goals, theme: load(STORAGE.theme, "light"), updatedAt: new Date().toISOString() };
}
function setPayload(payload) {
  cloudHydrating = true;
  try {
    const data = payload || {};
    transactions = Array.isArray(data.transactions) ? data.transactions : [];
    budgets = data.budgets && typeof data.budgets === "object" ? data.budgets : { monthly: 2500 };
    categoryBudgets = data.categoryBudgets && typeof data.categoryBudgets === "object" ? data.categoryBudgets : {};
    recurring = Array.isArray(data.recurring) ? data.recurring : [];
    goals = Array.isArray(data.goals) ? data.goals : [];
    const theme = data.theme === "dark" ? "dark" : "light";
    save(STORAGE.transactions, transactions); save(STORAGE.budgets, budgets); save(STORAGE.categoryBudgets, categoryBudgets);
    save(STORAGE.recurring, recurring); save(STORAGE.goals, goals); save(STORAGE.theme, theme);
    document.body.classList.toggle("dark", theme === "dark");
  } finally { cloudHydrating = false; }
}
function setCloudStatus(message, state = "ready") {
  const el = $("#cloud-sync-status");
  if (!el) return;
  el.textContent = message; el.dataset.state = state; el.classList.remove("hidden");
}
function authMessage(message, error = false) {
  const el = $("#cloud-auth-message"); if (!el) return;
  el.textContent = message; el.classList.toggle("error", error);
}
function showAuthScreen(show) {
  $("#cloud-auth-screen")?.classList.toggle("hidden", !show);
  document.body.classList.toggle("cloud-locked", show);
}
function hasLocalData() {
  return transactions.length || recurring.length || goals.length || Object.keys(categoryBudgets).length || Number(budgets.monthly) !== 2500;
}
function scheduleCloudSave() {
  clearTimeout(cloudSaveTimer);
  if (!cloudReady || !cloudUser) return;
  setCloudStatus("Syncing changes…", "syncing");
  cloudSaveTimer = setTimeout(() => {
    saveCloudData().catch(async error => {
      console.error("MoneyMap cloud save failed", error);
      if (error?.code === "MM_SYNC_CONFLICT") {
        await handleCloudConflict();
      } else {
        setCloudStatus("Sync failed — local changes are saved on this device", "error");
      }
    });
  }, 700);
}
async function saveCloudData(allowDuringInitialSetup = false) {
  if (!cloudClient || !cloudUser || (!cloudReady && !allowDuringInitialSetup)) return;
  if (cloudSaveInFlight) {
    scheduleCloudSave();
    return;
  }
  cloudSaveInFlight = true;
  try {
    const expectedRevision = Number.isInteger(cloudRevision) ? cloudRevision : 0;
    const { data, error } = await cloudClient.rpc("moneymap_sync_save", {
      p_payload: currentPayload(),
      p_expected_revision: expectedRevision
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.saved) {
      const conflict = new Error("Cloud data changed on another device.");
      conflict.code = "MM_SYNC_CONFLICT";
      conflict.currentRevision = result?.current_revision ?? null;
      throw conflict;
    }
    cloudRevision = Number(result.current_revision);
    setCloudStatus("All changes synced", "ready");
  } finally {
    cloudSaveInFlight = false;
  }
}
async function handleCloudConflict() {
  cloudReady = false;
  setCloudStatus("Sync conflict — local changes not uploaded", "conflict");
  const reloadCloud = confirm(
    "MoneyMap detected newer cloud data, possibly saved from another device. Your current browser still has its local changes.\n\n" +
    "Before choosing OK, export a local backup if you may need these changes.\n\n" +
    "OK = load the latest cloud version into this browser (replaces its current local data).\n" +
    "Cancel = keep the local data here and pause cloud syncing."
  );
  if (!reloadCloud) {
    setCloudStatus("Sync paused — local changes remain on this device", "conflict");
    return;
  }
  try {
    const { data, error } = await cloudClient.from(CLOUD_TABLE)
      .select("payload, revision, updated_at")
      .eq("user_id", cloudUser.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("No cloud data was found to reload.");
    cloudRevision = Number(data.revision || 1);
    setPayload(data.payload);
    render();
    cloudReady = true;
    setCloudStatus("Latest cloud data loaded", "ready");
    notify("Loaded the latest cloud version.");
  } catch (error) {
    console.error("Could not reload cloud version", error);
    setCloudStatus("Could not reload cloud data — sync remains paused", "error");
  }
}
async function hydrateFromCloud(user) {
  cloudReady = false; cloudUser = user; cloudRevision = null;
  setCloudStatus("Connecting to your private data…", "syncing");
  const { data, error } = await cloudClient.from(CLOUD_TABLE)
    .select("payload, revision, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.payload) {
    cloudRevision = Number(data.revision || 1);
    setPayload(data.payload);
    render();
  } else {
    cloudRevision = 0;
    const uploadLocal = hasLocalData() && confirm("No MoneyMap cloud data exists for this account yet. Upload the MoneyMap data currently saved in this browser? Choose Cancel to start this cloud account with an empty MoneyMap and replace this browser's current app data.");
    if (uploadLocal) {
      await saveCloudData(true);
    } else {
      setPayload({ transactions: [], budgets: { monthly: 2500 }, categoryBudgets: {}, recurring: [], goals: [], theme: "light" });
      render(); await saveCloudData(true);
    }
  }
  cloudReady = true;
  setCloudStatus("All changes synced", "ready");
  $("#cloud-account-button").textContent = "Sign out";
  $("#cloud-account-button").classList.remove("hidden");
  showAuthScreen(false);
}
async function initializeCloud() {
  const screen = $("#cloud-auth-screen");
  if (!cloudConfigured || !window.supabase?.createClient) {
    screen?.classList.add("hidden");
    $("#cloud-account-button")?.classList.add("hidden");
    setCloudStatus("Local-only — cloud sync not configured", "error");
    return;
  }
  cloudClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  $("#cloud-signin-form")?.classList.remove("hidden");
  $("#cloud-reset-password")?.classList.remove("hidden");
  $("#cloud-setup-notice")?.classList.add("hidden");
  showAuthScreen(true);
  const { data, error } = await cloudClient.auth.getSession();
  if (error) { authMessage("Could not check your sign-in session. Please sign in again.", true); return; }
  if (data.session?.user) {
    try { await hydrateFromCloud(data.session.user); }
    catch (err) { console.error(err); authMessage("Could not load your private cloud data. Check the database setup and try again.", true); showAuthScreen(true); }
  }
  cloudClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      showAuthScreen(true);
      $("#cloud-signin-form")?.classList.add("hidden");
      $("#cloud-reset-password")?.classList.add("hidden");
      $("#cloud-new-password-form")?.classList.remove("hidden");
      authMessage("Choose a new password for your MoneyMap account.");
      return;
    }
    if (event === "SIGNED_OUT" || !session?.user) {
      cloudUser = null; cloudReady = false; showAuthScreen(true); $("#cloud-account-button")?.classList.add("hidden");
      $("#cloud-signin-form")?.classList.remove("hidden"); $("#cloud-reset-password")?.classList.remove("hidden"); $("#cloud-new-password-form")?.classList.add("hidden");
      setCloudStatus("Signed out", "ready");
    }
  });
}
function localDate(date = new Date()) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function monthNow() { return localDate().slice(0,7); }
function populateMonthPicker() {
  const picker = $("#month-picker");
  if (!picker) return;
  const current = monthNow();
  const currentYear = Number(current.slice(0,4));
  const options = [];
  // Native input[type=month] is inconsistent in some browsers, so use a regular select.
  for (let year = currentYear - 10; year <= currentYear + 10; year++) {
    for (let month = 1; month <= 12; month++) {
      const value = `${year}-${String(month).padStart(2,"0")}`;
      options.push(`<option value="${value}">${monthName(value)}</option>`);
    }
  }
  picker.innerHTML = options.join("");
  picker.value = current;
}
function selectedMonth() { return $("#month-picker").value || monthNow(); }
function money(amount) { return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(amount)||0); }
function monthTransactions(month = selectedMonth()) { return transactions.filter(t => t.date?.startsWith(month)); }
function sum(list, type) { return list.filter(t => !type || t.type === type).reduce((n,t) => n + Number(t.amount || 0),0); }
function safe(value) { return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch])); }
function prettyDate(date) { if (!date) return "—"; return new Date(`${date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
function monthName(month) { const [y,m] = month.split("-").map(Number); return new Date(y,m-1,1).toLocaleDateString("en-US",{month:"long",year:"numeric"}); }
function notify(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),2600); }
function openDialog(id) { const d=$("#"+id); if (d.showModal) d.showModal(); else d.setAttribute("open",""); }
function closeDialog(id) { const d=$("#"+id); if (d.close) d.close(); else d.removeAttribute("open"); }
function iconFor(category) { return ICONS[category] || "•"; }
function getSpending(list=monthTransactions()) { const result={}; list.filter(t=>t.type==="expense").forEach(t=>result[t.category]=(result[t.category]||0)+Number(t.amount)); return result; }

function render() {
  const month=selectedMonth(), list=monthTransactions(month);
  const income=sum(list,"income"), expenses=sum(list,"expense"), savings=sum(list,"saving");
  $("#stat-balance").textContent=money(income-expenses-savings);
  $("#stat-income").textContent=money(income);
  $("#stat-expenses").textContent=money(expenses);
  $("#stat-savings").textContent=income ? `${Math.round((savings/income)*100)}%` : "0%";
  $("#spend-month-label").textContent=monthName(month);
  $("#spending-overview-subtitle").textContent=`Where your money went in ${monthName(month)}`;
  $("#home-budget-subtitle").textContent=`Actual ${monthName(month)} spending compared with your monthly limits`;
  $("#chart-total").textContent=money(expenses);
  $("#budget-limit-display").textContent=money(budgets.monthly);
  $("#budget-used").textContent=money(expenses);
  const ratio=budgets.monthly>0?expenses/budgets.monthly:0;
  $("#overall-progress").style.width=`${Math.min(100,ratio*100)}%`;
  $("#overall-progress").style.background=ratio>1?"#e97968":ratio>.8?"#e8b84d":"var(--green)";
  $("#budget-percent").textContent=`${Math.round(ratio*100)}% used`;
  $("#budget-left").textContent=expenses>budgets.monthly?`${money(expenses-budgets.monthly)} over budget`:`${money(budgets.monthly-expenses)} left`;
  $("#overall-budget-input").value=budgets.monthly;
  $("#greeting").textContent=`${new Date().getHours()<12?"Good morning":new Date().getHours()<18?"Good afternoon":"Good evening"} 👋`;
  $("#today-label").textContent=monthName(month).toUpperCase()+" FINANCIAL SNAPSHOT";
  renderSpendingChart(list); renderMiniBudgets(list); renderRecent(list); populateTransactionCategoryFilter(); renderAllTransactions(); renderBudgetBreakdown(list); renderReports(); renderRecurring(); renderGoals(); renderUpcomingPayments(); renderMonthEndForecast();
  // Charts can be measured while their view is hidden; resize after the selected month has rendered.
  requestAnimationFrame(() => { spendingChart?.resize(); if (monthlyChart) monthlyChart.resize(); });
}

function renderUpcomingPayments() {
  const today = localDate();
  const horizon = new Date(); horizon.setHours(0,0,0,0); horizon.setDate(horizon.getDate()+30);
  const endDate = localDate(horizon);
  const items = recurring.filter(item => item.nextDate && item.nextDate >= today && item.nextDate <= endDate)
    .sort((a,b) => a.nextDate.localeCompare(b.nextDate));
  const list = $("#upcoming-payments");
  list.innerHTML = items.slice(0,8).map(item => {
    const isIncome = item.type === "income";
    const isBill = item.type !== "income" && item.type !== "saving";
    const paid = item.paymentStatus === "paid" && item.paymentStatusDate === item.nextDate;
    return `<div class="upcoming-row"><span class="upcoming-date"><strong>${new Date(item.nextDate+"T12:00:00").toLocaleDateString(undefined,{month:"short"})}</strong><small>${new Date(item.nextDate+"T12:00:00").getDate()}</small></span><div class="upcoming-details"><strong>${safe(item.description)}</strong><small>${safe(item.category || "Other")} · ${isIncome ? "Expected income" : item.type === "saving" ? "Savings" : "Bill"}${isBill ? ` · <span class="payment-status ${paid ? "is-paid" : "is-pending"}">${paid ? "Paid" : "Not marked paid"}</span>` : ""}</small></div><div class="upcoming-actions"><strong class="upcoming-amount ${isIncome ? "amount-positive" : ""}">${isIncome?"+":"−"}${money(item.amount)}</strong>${isBill ? (paid ? `<span class="payment-paid-label">✓ Paid</span>` : `<button class="payment-action" data-mark-paid="${safe(item.id)}" type="button">Mark paid</button>`) : ""}</div></div>`;
  }).join("");
  $("#upcoming-empty").classList.toggle("hidden", items.length > 0);
  if (items.length > 8) list.insertAdjacentHTML("beforeend", `<p class="upcoming-more">And ${items.length-8} more scheduled items in the next 30 days.</p>`);
}

function renderMonthEndForecast() {
  const now = new Date(); now.setHours(0,0,0,0);
  const today = localDate(now);
  const monthStart = `${today.slice(0,7)}-01`;
  const monthEndDate = new Date(now.getFullYear(), now.getMonth()+1, 0);
  const monthEnd = localDate(monthEndDate);
  const thisMonth = transactions.filter(t => t.date >= monthStart && t.date <= monthEnd);
  const recordedNet = sum(thisMonth,"income") - sum(thisMonth,"expense") - sum(thisMonth,"saving");
  let scheduledNet = 0;
  recurring.forEach(item => {
    if (!item.nextDate || !item.frequency) return;
    let date = item.nextDate;
    const anchor = Number(item.anchorDay) || Number(date.slice(8,10));
    let guard = 0;
    while (date <= monthEnd && guard < 100) {
      if (date > today) {
        const alreadyRecorded = transactions.some(t => t.recurringId === item.id && t.recurringOccurrenceDate === date);
        const markedPaid = item.type !== "income" && item.type !== "saving" && item.paymentStatus === "paid" && item.paymentStatusDate === date;
        if (!alreadyRecorded && !markedPaid) scheduledNet += (item.type === "income" ? 1 : -1) * Number(item.amount || 0);
      }
      date = advanceRecurringDate(date, item.frequency, anchor);
      guard++;
    }
  });
  const projected = recordedNet + scheduledNet;
  $("#forecast-period").textContent = `Estimated net by ${monthEndDate.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;
  $("#forecast-balance").textContent = money(projected);
  $("#forecast-balance").classList.toggle("forecast-negative", projected < 0);
  $("#forecast-recorded").textContent = money(recordedNet);
  $("#forecast-scheduled").textContent = `${scheduledNet > 0 ? "+" : scheduledNet < 0 ? "−" : ""}${money(Math.abs(scheduledNet))}`;
  $("#forecast-caption").textContent = scheduledNet === 0 ? "No unrecorded recurring items are scheduled for the rest of this month." : `${scheduledNet < 0 ? "Upcoming scheduled outflows reduce" : "Upcoming scheduled income increases"} your recorded net by ${money(Math.abs(scheduledNet))}.`;
}

function renderSpendingChart(list) {
  const data=getSpending(list), entries=Object.entries(data).sort((a,b)=>b[1]-a[1]);
  const ctx=$("#spending-chart").getContext("2d");
  if(spendingChart) spendingChart.destroy();
  spendingChart=new Chart(ctx,{type:"doughnut",data:{labels:entries.map(e=>e[0]),datasets:[{data:entries.length?entries.map(e=>e[1]):[1],backgroundColor:entries.length?entries.map(e=>COLORS[CATEGORIES.indexOf(e[0])%COLORS.length]):["#edf2ee"],borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:"76%",plugins:{legend:{display:false},tooltip:{enabled:entries.length>0,callbacks:{label:c=>`${c.label}: ${money(c.raw)}`}}}}});
  $("#category-legend").innerHTML=entries.length?entries.slice(0,6).map(([name,amount])=>`<div class="legend-item"><span class="legend-dot" style="background:${COLORS[CATEGORIES.indexOf(name)%COLORS.length]}"></span><span class="legend-name">${safe(name)}</span><strong class="legend-amount">${money(amount)}</strong></div>`).join(""):`<div class="muted" style="font-size:11px;grid-column:1/-1;text-align:center">Your spending categories will appear here.</div>`;
}

function renderMiniBudgets(list) {
  const spent=getSpending(list);
  const defaults=Object.entries(categoryBudgets).filter(([,v])=>Number(v)>0);
  const rows=(defaults.length?defaults:[["Food & dining",400],["Housing",1200],["Transportation",250]]).slice(0,4);
  $("#mini-budget-list").innerHTML=rows.map(([name,limit])=>{
    const amount=spent[name]||0, pct=limit?amount/limit:0, color=pct>1?"#e97968":pct>.8?"#e8b84d":COLORS[CATEGORIES.indexOf(name)%COLORS.length];
    return `<div class="mini-budget-row"><div class="mini-budget-heading"><span class="legend-dot" style="background:${color}"></span><span>${safe(name)}</span><strong>${money(amount)}</strong><span>/ ${money(limit)}</span></div><div class="tiny-track"><span style="width:${Math.min(100,pct*100)}%;background:${color}"></span></div></div>`;
  }).join("");
}
function rowMarkup(t, includeDelete=false) {
  const type=t.type||"expense", amountClass=type==="income"?"amount-income":type==="saving"?"amount-saving":"amount-expense";
  const sign=type==="income"?"+":"−";
  return `<tr><td><div class="transaction-name"><span class="transaction-symbol">${iconFor(t.category)}</span><span>${safe(t.description)}<small>${t.recurring?"Recurring transaction":"Personal finance"}</small></span></div></td><td><span class="category-chip">${safe(t.category)}</span></td><td>${prettyDate(t.date)}</td>${includeDelete?`<td>${type[0].toUpperCase()+type.slice(1)}</td>`:""}<td class="${amountClass}">${sign}${money(t.amount)}</td>${includeDelete?`<td><button class="edit-button" data-edit="${safe(t.id)}" aria-label="Edit transaction">Edit</button><button class="delete-button" data-delete="${safe(t.id)}" aria-label="Delete transaction">×</button></td>`:""}</tr>`;
}
function renderRecent(list) {
  const sorted=[...list].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  $("#recent-rows").innerHTML=sorted.map(t=>rowMarkup(t)).join("");
  $("#recent-empty").classList.toggle("hidden",sorted.length>0);
}
function getFilteredTransactions() {
  const query=$("#transaction-search").value.trim().toLocaleLowerCase();
  const type=$("#type-filter").value;
  const category=$("#category-filter").value;
  const period=$("#transaction-period-filter").value;
  const from=$("#transaction-date-from").value;
  const to=$("#transaction-date-to").value;
  const sort=$("#transaction-sort").value;
  if(from && to && from > to) return [];
  const filtered=transactions.filter(t=>{
    const searchable=`${t.description||""} ${t.category||""}`.toLocaleLowerCase();
    if(query&&!searchable.includes(query)) return false;
    if(type!=="all"&&(t.type||"expense")!==type) return false;
    if(category!=="all"&&t.category!==category) return false;
    if(period==="month"&&!from&&!to&&!t.date?.startsWith(selectedMonth())) return false;
    if(from&&(!t.date||t.date<from)) return false;
    if(to&&(!t.date||t.date>to)) return false;
    return true;
  });
  filtered.sort((a,b)=>{
    if(sort==="oldest") return String(a.date||"").localeCompare(String(b.date||""));
    if(sort==="amount-desc") return Number(b.amount||0)-Number(a.amount||0);
    if(sort==="amount-asc") return Number(a.amount||0)-Number(b.amount||0);
    if(sort==="description") return String(a.description||"").localeCompare(String(b.description||""));
    return String(b.date||"").localeCompare(String(a.date||""));
  });
  return filtered;
}
function renderAllTransactions() {
  const filtered=getFilteredTransactions();
  $("#all-rows").innerHTML=filtered.map(t=>rowMarkup(t,true)).join("");
  const hasAnyTransactions=transactions.length>0;
  $("#all-empty").textContent=hasAnyTransactions?"No transactions match these filters. Try changing your search or resetting the filters.":"Nothing here yet. Add a transaction to see it listed.";
  $("#all-empty").classList.toggle("hidden",filtered.length>0);
  $("#transaction-results-count").textContent=`${filtered.length} transaction${filtered.length===1?"":"s"} found`;
  const total=filtered.reduce((n,t)=>n+(t.type==="income"?1:-1)*Number(t.amount||0),0);
  $("#transaction-results-total").textContent=`Net total: ${money(total)}`;
  $("#export-csv").disabled=filtered.length===0;
}
function populateTransactionCategoryFilter() {
  const select=$("#category-filter"), current=select.value;
  const categories=[...new Set([...CATEGORIES,...transactions.map(t=>t.category).filter(Boolean)])].sort((a,b)=>a.localeCompare(b));
  select.innerHTML='<option value="all">All categories</option>'+categories.map(category=>`<option value="${safe(category)}">${safe(category)}</option>`).join("");
  select.value=categories.includes(current)?current:"all";
}
function resetTransactionFilters() {
  $("#transaction-search").value="";
  $("#type-filter").value="all";
  $("#category-filter").value="all";
  $("#transaction-period-filter").value="month";
  $("#transaction-date-from").value="";
  $("#transaction-date-to").value="";
  $("#transaction-sort").value="newest";
  renderAllTransactions();
}
function renderBudgetBreakdown(list) {
  const spent=getSpending(list), keys=Object.keys(categoryBudgets);
  $("#budget-breakdown").innerHTML=keys.length?keys.map(name=>{
    const limit=Number(categoryBudgets[name])||0, amount=spent[name]||0,pct=limit?amount/limit:0,color=pct>1?"#e97968":pct>.8?"#e8b84d":COLORS[CATEGORIES.indexOf(name)%COLORS.length];
    return `<div class="budget-break-row"><div class="budget-break-top"><span class="legend-dot" style="background:${color}"></span><span>${safe(name)}</span><strong>${money(amount)} / ${money(limit)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100,pct*100)}%;background:${color}"></div></div><div class="budget-break-foot"><span>${Math.round(pct*100)}% used</span><span>${amount>limit?money(amount-limit)+" over":money(limit-amount)+" remaining"}</span></div></div>`;
  }).join(""):`<div class="empty-state">No category budgets yet. Add one above to start planning.</div>`;
}
function renderFinancialInsights(list, yearly, year, month, totals, categoryData) {
  const { income, expenses, savings, net } = totals;
  const previousKey = yearly ? String(year - 1) : (() => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const previousList = yearly
    ? transactions.filter(t => t.date?.startsWith(previousKey + "-"))
    : monthTransactions(previousKey);
  const previousExpenses = sum(previousList, "expense");
  const previousIncome = sum(previousList, "income");
  const periodLabel = yearly ? String(year) : monthName(month);
  const previousLabel = yearly ? String(year - 1) : monthName(previousKey);
  const insights = [];
  const addInsight = (kind, title, detail) => insights.push({ kind, title, detail });

  if (!list.length) {
    addInsight("neutral", "Ready when you are", `Record transactions for ${periodLabel} to see spending patterns and budget guidance.`);
  } else {
    if (previousExpenses > 0) {
      const change = ((expenses - previousExpenses) / previousExpenses) * 100;
      const rounded = Math.round(Math.abs(change));
      if (Math.abs(change) >= 5) {
        addInsight(change > 0 ? "warning" : "positive", change > 0 ? "Spending increased" : "Spending decreased", `Expenses are ${rounded}% ${change > 0 ? "higher" : "lower"} than ${previousLabel} (${money(expenses)} vs. ${money(previousExpenses)}).`);
      } else {
        addInsight("positive", "Spending is steady", `Expenses are within 5% of ${previousLabel}.`);
      }
    } else {
      addInsight("neutral", "Build your trend history", `Once ${previousLabel} has recorded expenses, MoneyMap can compare periods for you.`);
    }

    const top = Object.entries(categoryData).sort((a, b) => b[1] - a[1])[0];
    if (top && expenses > 0) {
      addInsight("neutral", "Biggest spending category", `${top[0]} accounts for ${Math.round((top[1] / expenses) * 100)}% of your expenses (${money(top[1])}).`);
    }
    const previousCategorySpend = getSpending(previousList);
    const categoryChanges = Object.entries(categoryData).map(([name, amount]) => {
      const previous = Number(previousCategorySpend[name] || 0);
      return { name, amount, previous, change: previous > 0 ? ((amount - previous) / previous) * 100 : (amount > 0 ? 100 : 0) };
    }).filter(item => item.amount >= 25 && ((item.previous > 0 && item.amount - item.previous >= 25 && item.change >= 20) || (item.previous === 0 && item.amount >= 75)))
      .sort((a, b) => (b.amount - b.previous) - (a.amount - a.previous));
    if (categoryChanges.length) {
      const trend = categoryChanges[0];
      addInsight("warning", `${trend.name} spending is rising`, trend.previous > 0
        ? `You spent ${money(trend.amount - trend.previous)} more in ${trend.name} than ${previousLabel} (${Math.round(trend.change)}% higher). Consider reviewing recent purchases in this category.`
        : `You recorded ${money(trend.amount)} in ${trend.name} this period, compared with no recorded spending in ${previousLabel}. Check whether this is a one-off expense or a new pattern.`);
    }
    if (income > 0) {
      const rate = Math.round((savings / income) * 100);
      addInsight(rate >= 20 ? "positive" : rate > 0 ? "neutral" : "warning", "Savings rate", `${rate}% of recorded income was marked as savings in ${periodLabel}.`);
    }
    if (net < 0) {
      addInsight("warning", "Outflow exceeded income", `Recorded expenses and savings were ${money(Math.abs(net))} more than income in ${periodLabel}.`);
    } else if (income > 0) {
      addInsight("positive", "Positive cash flow", `${money(net)} remains after recorded expenses and savings for ${periodLabel}.`);
    }

    const overallLimit = (Number(budgets.monthly) || 0) * (yearly ? 12 : 1);
    if (overallLimit > 0) {
      const pct = expenses / overallLimit;
      if (pct >= 1) addInsight("warning", "Overall budget exceeded", `Spending is ${Math.round((pct - 1) * 100)}% over your ${yearly ? "annualized" : "monthly"} overall budget.`);
      else if (pct >= 0.8) addInsight("warning", "Overall budget nearly used", `${Math.round(pct * 100)}% of your ${yearly ? "annualized" : "monthly"} overall budget has been used.`);
    }
    Object.entries(categoryBudgets).forEach(([name, limit]) => {
      const target = (Number(limit) || 0) * (yearly ? 12 : 1);
      const amount = categoryData[name] || 0;
      if (target > 0 && amount / target >= 0.8) {
        const pct = Math.round((amount / target) * 100);
        addInsight("warning", `${name} budget alert`, `${pct}% used (${money(amount)} of ${money(target)}). ${pct >= 100 ? "Consider reviewing this category's spending." : "You're approaching the limit."}`);
      }
    });
  }

  $("#financial-insights-description").textContent = `Automated observations for ${periodLabel}. Based on recorded data, not financial advice.`;
  $("#financial-insights").innerHTML = insights.map(item => `<div class="insight-item insight-${item.kind}"><span class="insight-icon" aria-hidden="true">${item.kind === "warning" ? "!" : item.kind === "positive" ? "✓" : "↗"}</span><div><strong>${safe(item.title)}</strong><p>${safe(item.detail)}</p></div></div>`).join("");
}

function renderReports() {
  const month=selectedMonth(), [year,mo]=month.split("-").map(Number);
  const period=$("#report-period")?.value || "monthly";
  const yearly=period==="yearly";
  const startKey=yearly?`${year}-01` : month;
  const list=yearly?transactions.filter(t=>t.date?.startsWith(String(year)+"-")):monthTransactions(month);
  const expenses=list.filter(t=>t.type==="expense"), data=getSpending(list);
  const totalIncome=sum(list,"income"), totalExpenses=sum(list,"expense"), totalSavings=sum(list,"saving");
  const net=totalIncome-totalExpenses-totalSavings;
  renderFinancialInsights(list, yearly, year, month, { income: totalIncome, expenses: totalExpenses, savings: totalSavings, net }, data);
  const top=Object.entries(data).sort((a,b)=>b[1]-a[1])[0];
  $("#report-income-label").textContent=yearly?`Income in ${year}`:"Income this month";
  $("#report-expenses-label").textContent=yearly?`Expenses in ${year}`:"Expenses this month";
  $("#report-net-label").textContent=yearly?`Net for ${year}`:"Net after expenses & savings";
  $("#report-income").textContent=money(totalIncome);
  $("#report-expenses").textContent=money(totalExpenses);
  $("#report-net").textContent=money(net);
  $("#report-net").style.color=net<0?"#d96f61":"";
  $("#top-category").textContent=top?top[0]:"—";
  $("#top-category-detail").textContent=top?`${money(top[1])} spent in ${top[0].toLowerCase()}${yearly?` in ${year}`:""}`:"Add expenses to see your top category.";
  $("#average-expense").textContent=money(expenses.length?totalExpenses/expenses.length:0);
  $("#average-expense-detail").textContent=yearly?`Across ${expenses.length} expense transaction${expenses.length===1?"":"s"} in ${year}`:"Per expense transaction this month";
  $("#report-savings-label").textContent=yearly?`Savings in ${year}`:"Savings this month";
  $("#report-savings").textContent=money(totalSavings);

  const labels=[], incomes=[], outgoings=[];
  const count=yearly?12:6;
  for(let offset=count-1;offset>=0;offset--){
    const d=yearly?new Date(year,11-offset,1):new Date(year,mo-1-offset,1);
    const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    labels.push(yearly?d.toLocaleDateString("en-US",{month:"short"}):d.toLocaleDateString("en-US",{month:"short",year:"2-digit"}));
    const arr=monthTransactions(key); incomes.push(sum(arr,"income")); outgoings.push(sum(arr,"expense"));
  }
  $("#report-chart-description").textContent=yearly?`Month-by-month income and expenses for ${year}`:`Monthly comparison for the six months ending in ${monthName(month)}`;
  const categoryEntries=Object.entries(data).sort((a,b)=>b[1]-a[1]);
  $("#report-category-breakdown").innerHTML=categoryEntries.length?categoryEntries.map(([name,amount])=>{
    const pct=totalExpenses?amount/totalExpenses:0;
    return `<div class="budget-break-row"><div class="budget-break-top"><span class="legend-dot" style="background:${COLORS[CATEGORIES.indexOf(name)%COLORS.length]}"></span><span>${safe(name)}</span><strong>${money(amount)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100,pct*100)}%;background:${COLORS[CATEGORIES.indexOf(name)%COLORS.length]}"></div></div><div class="budget-break-foot"><span>${Math.round(pct*100)}% of expenses</span><span>${money(amount)}</span></div></div>`;
  }).join(""):`<div class="empty-state">No expenses recorded for ${yearly?year:safe(monthName(month))}.</div>`;
  const warningRows=[];
  const overallLimit=Number(budgets.monthly)||0;
  const overallTarget=yearly?overallLimit*12:overallLimit;
  const overallPct=overallTarget>0?totalExpenses/overallTarget:0;
  if(overallTarget>0&&overallPct>=.8)warningRows.push(`<div class="budget-break-row"><div class="budget-break-top"><span class="legend-dot" style="background:${overallPct>1?"#e97968":"#e8b84d"}"></span><span>${yearly?"Annualized overall budget":"Overall monthly budget"}</span><strong>${Math.round(overallPct*100)}% used</strong></div><div class="budget-break-foot"><span>${overallPct>1?"Over budget by":"Remaining"}</span><span>${money(Math.abs(overallTarget-totalExpenses))}</span></div></div>`);
  Object.entries(categoryBudgets).forEach(([name,limit])=>{
    const target=(Number(limit)||0)*(yearly?12:1), amount=data[name]||0, pct=target>0?amount/target:0;
    if(pct>=.8)warningRows.push(`<div class="budget-break-row"><div class="budget-break-top"><span class="legend-dot" style="background:${pct>1?"#e97968":"#e8b84d"}"></span><span>${safe(name)}</span><strong>${Math.round(pct*100)}% used</strong></div><div class="budget-break-foot"><span>${pct>1?"Over budget by":"Remaining"}</span><span>${money(Math.abs(target-amount))}</span></div></div>`);
  });
  $("#report-budget-warnings").innerHTML=warningRows.length?warningRows.join(""):`<div class="empty-state">You're below 80% of your tracked ${yearly?"annualized budgets":"budgets"} for ${yearly?year:safe(monthName(month))}. Keep it up!</div>`;
  if(monthlyChart)monthlyChart.destroy();
  monthlyChart=new Chart($("#monthly-chart").getContext("2d"),{type:"bar",data:{labels,datasets:[{label:"Income",data:incomes,backgroundColor:"#16845a",borderRadius:5,barPercentage:.55},{label:"Expenses",data:outgoings,backgroundColor:"#f0a092",borderRadius:5,barPercentage:.55}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{usePointStyle:true,boxWidth:7,boxHeight:7,padding:22,font:{family:"DM Sans",size:11}}}},scales:{x:{grid:{display:false},ticks:{color:"#8b9690",font:{family:"DM Sans",size:10}},border:{display:false}},y:{beginAtZero:true,grid:{color:"#eef2ef"},ticks:{color:"#8b9690",font:{family:"DM Sans",size:10},callback:v=>"$"+v.toLocaleString()},border:{display:false}}}}});
}
function renderRecurring() {
  const typeFilter = $("#recurring-type-filter")?.value || "all";
  const statusFilter = $("#recurring-status-filter")?.value || "all";
  const sort = $("#recurring-sort")?.value || "date-asc";
  const filtered = recurring.filter(r => {
    if (typeFilter !== "all" && (r.type || "expense") !== typeFilter) return false;
    const isBill = (r.type || "expense") !== "income" && (r.type || "expense") !== "saving";
    const paid = isBill && r.paymentStatus === "paid" && r.paymentStatusDate === r.nextDate;
    if (statusFilter === "paid" && !paid) return false;
    if (statusFilter === "pending" && (!isBill || paid)) return false;
    return true;
  }).sort((a,b) => {
    if (sort === "date-desc") return String(b.nextDate||"").localeCompare(String(a.nextDate||""));
    if (sort === "name-asc") return String(a.description||"").localeCompare(String(b.description||""));
    if (sort === "name-desc") return String(b.description||"").localeCompare(String(a.description||""));
    if (sort === "amount-desc") return Number(b.amount||0)-Number(a.amount||0);
    if (sort === "amount-asc") return Number(a.amount||0)-Number(b.amount||0);
    if (sort === "frequency") return String(a.frequency||"").localeCompare(String(b.frequency||""));
    return String(a.nextDate||"").localeCompare(String(b.nextDate||""));
  });
  $("#recurring-list").innerHTML=filtered.map(r=>{
    const isBill = r.type !== "income" && r.type !== "saving";
    const paid = r.paymentStatus === "paid" && r.paymentStatusDate === r.nextDate;
    const frequencyLabels = {weekly:"Weekly",biweekly:"Biweekly",monthly:"Monthly",yearly:"Yearly"};
    return `<div class="recurring-row"><span class="transaction-symbol">${iconFor(r.category)}</span><div class="recurring-item-details"><strong>${safe(r.description)}</strong><small>${safe(r.category)} · ${frequencyLabels[r.frequency] || safe(r.frequency)} · Next ${prettyDate(r.nextDate)}${isBill ? ` · <span class="payment-status ${paid ? "is-paid" : "is-pending"}">${paid ? "Paid for this due date" : "Payment not marked paid"}</span>` : ""}</small></div><div class="recurring-amount">${r.type==="income"?"+":"−"}${money(r.amount)}<small>${safe(r.type)}</small></div>${isBill && !paid ? `<button class="payment-action" data-mark-paid="${safe(r.id)}" type="button">Mark paid</button>` : ""}<button class="delete-button" data-delete-recurring="${safe(r.id)}" aria-label="Delete recurring item">×</button></div>`;
  }).join("");
  $("#recurring-empty").classList.toggle("hidden",filtered.length>0);
  $("#recurring-empty").textContent = recurring.length ? "No recurring items match these filters." : "No recurring items yet. Add rent, subscriptions, or a regular paycheck.";
}
function markRecurringPaid(id) {
  const item = recurring.find(entry => entry.id === id);
  if (!item || item.type === "income" || item.type === "saving" || !item.nextDate) return;
  const occurrenceDate = item.nextDate;
  if (item.paymentStatus === "paid" && item.paymentStatusDate === occurrenceDate) return;
  item.paymentStatus = "paid";
  item.paymentStatusDate = occurrenceDate;
  const alreadyRecorded = transactions.some(t => t.recurringId === item.id && t.recurringOccurrenceDate === occurrenceDate);
  if (!alreadyRecorded) {
    transactions.push({ id: crypto.randomUUID(), description: item.description,
      amount: Math.round(Number(item.amount || 0) * 100) / 100, type: item.type || "expense",
      category: item.category || "Bills & utilities", date: localDate(), recurring: true,
      recurringId: item.id, recurringOccurrenceDate: occurrenceDate, paymentStatusEntry: true });
    save(STORAGE.transactions, transactions);
  }
  save(STORAGE.recurring, recurring);
  render();
  notify(`${item.description} marked as paid.`);
}

function renderGoals() {
  const totalSaved = goals.reduce((n, goal) => n + Number(goal.current || 0), 0);
  const totalTarget = goals.reduce((n, goal) => n + Number(goal.target || 0), 0);
  const completed = goals.filter(goal => Number(goal.current) >= Number(goal.target)).length;
  const summary = $("#goals-summary");
  summary.innerHTML = goals.length ? `<article class="goal-summary-card"><span>Saved toward goals</span><strong>${money(totalSaved)}</strong></article><article class="goal-summary-card"><span>Total targets</span><strong>${money(totalTarget)}</strong></article><article class="goal-summary-card"><span>Goals completed</span><strong>${completed} of ${goals.length}</strong></article>` : "";
  $("#goals-empty").classList.toggle("hidden", goals.length > 0);
  $("#goals-list").innerHTML = goals.map(goal => {
    const target = Number(goal.target) || 0;
    const current = Number(goal.current) || 0;
    const ratio = target > 0 ? Math.min(100, current / target * 100) : 0;
    const remaining = Math.max(0, target - current);
    const deadline = goal.deadline ? `Target date: ${prettyDate(goal.deadline)}` : "No target date set";
    const done = current >= target;
    return `<article class="panel goal-card"><div class="goal-card-top"><div class="goal-icon">◎</div><button class="delete-button" data-delete-goal="${safe(goal.id)}" aria-label="Delete ${safe(goal.name)}" title="Delete goal">×</button></div><h3>${safe(goal.name)}</h3><p class="goal-deadline">${deadline}</p><div class="goal-amounts"><strong>${money(current)}</strong><span>of ${money(target)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${ratio}%;${done ? 'background:#16845a' : ''}"></div></div><div class="goal-progress-meta"><span>${Math.round(ratio)}% saved</span><span>${done ? 'Goal reached!' : `${money(remaining)} to go`}</span></div><form class="goal-contribute-form" data-goal-form="${safe(goal.id)}"><label for="contribute-${safe(goal.id)}">Add contribution ($)</label><div class="goal-contribute-row"><input id="contribute-${safe(goal.id)}" type="number" min="0.01" step="0.01" required placeholder="25.00" aria-label="Contribution amount for ${safe(goal.name)}"><button class="outline-button" type="submit">Add</button></div></form></article>`;
  }).join("");
}
function addGoal(event) {
  event.preventDefault();
  const name = $("#goal-name").value.trim();
  const target = Number($("#goal-target").value);
  const current = Number($("#goal-current").value || 0);
  const deadline = $("#goal-deadline").value;
  if (!name || !Number.isFinite(target) || target <= 0 || !Number.isFinite(current) || current < 0) { notify("Enter a name and valid goal amounts."); return; }
  goals.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, name, target: Math.round(target * 100) / 100, current: Math.round(current * 100) / 100, deadline });
  save(STORAGE.goals, goals);
  $("#goal-form").reset(); $("#goal-current").value = "0";
  renderGoals(); notify("Savings goal created.");
}
function contributeToGoal(form) {
  const id = form.dataset.goalForm;
  const input = form.querySelector('input[type="number"]');
  const amount = Number(input.value);
  const goal = goals.find(item => String(item.id) === String(id));
  if (!goal || !Number.isFinite(amount) || amount <= 0) { notify("Enter a contribution greater than zero."); return; }
  goal.current = Math.round((Number(goal.current || 0) + amount) * 100) / 100;
  save(STORAGE.goals, goals); renderGoals(); notify(`Added ${money(amount)} to ${goal.name}.`);
}
function deleteGoal(id) {
  goals = goals.filter(goal => String(goal.id) !== String(id));
  save(STORAGE.goals, goals); renderGoals(); notify("Savings goal deleted.");
}

function resetTransactionDialog() {
  $("#transaction-form").reset();
  $("#editing-transaction-id").value = "";
  $("#transaction-dialog-title").textContent = "Add transaction";
  $("#transaction-dialog-subtitle").textContent = "Record a little money detail.";
  $("#transaction-submit").textContent = "Save transaction";
  $("#is-recurring").disabled = false;
  $("#is-recurring").parentElement.classList.remove("editing-recurring-note");
  $("#date").value = localDate();
}
function editTransaction(id) {
  const t = transactions.find(item => item.id === id);
  if (!t) return;
  $("#editing-transaction-id").value = t.id;
  $("#description").value = t.description;
  $("#amount").value = t.amount;
  $("#transaction-type").value = t.type || "expense";
  $("#category").value = t.category;
  $("#date").value = t.date;
  $("#is-recurring").checked = Boolean(t.recurring);
  $("#is-recurring").disabled = true;
  $("#transaction-dialog-title").textContent = "Edit transaction";
  $("#transaction-dialog-subtitle").textContent = t.recurring ? "Update this transaction. Its recurring schedule stays unchanged." : "Update the details and save your changes.";
  $("#transaction-submit").textContent = "Save changes";
  openDialog("transaction-dialog");
}
function addTransaction(event) {
  event.preventDefault();
  const amount = Number($("#amount").value);
  if (!Number.isFinite(amount) || amount <= 0) { notify("Enter an amount greater than zero."); return; }
  const editingId = $("#editing-transaction-id").value;
  const description = $("#description").value.trim();
  const date = $("#date").value;
  if (!description || !date) { notify("Please complete all required fields."); return; }
  if (editingId) {
    transactions = transactions.map(t => t.id === editingId ? {...t, description, amount: Math.round(amount*100)/100, type: $("#transaction-type").value, category: $("#category").value, date} : t);
    save(STORAGE.transactions, transactions);
    resetTransactionDialog(); closeDialog("transaction-dialog"); render(); notify("Transaction updated."); return;
  }
  const t = {id: crypto.randomUUID(), description, amount: Math.round(amount*100)/100, type: $("#transaction-type").value, category: $("#category").value, date, recurring: $("#is-recurring").checked};
  transactions.push(t); save(STORAGE.transactions, transactions);
  if (t.recurring) { const nextDate = nextMonthDate(t.date); recurring.push({id:crypto.randomUUID(), description:t.description, amount:t.amount, type:t.type, category:t.category, frequency:"monthly", nextDate, anchorDay:Number(t.date.slice(8,10))}); save(STORAGE.recurring, recurring); }
  resetTransactionDialog(); closeDialog("transaction-dialog"); render(); notify("Transaction saved.");
}
function nextMonthDate(dateStr){const [y,m,d]=dateStr.split("-").map(Number), target=new Date(y,m,Math.min(d,new Date(y,m+1,0).getDate()));return localDate(target);}
function advanceRecurringDate(dateStr, frequency, anchorDay) {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (frequency === "weekly" || frequency === "biweekly") {
    const next = new Date(year, month - 1, day + (frequency === "biweekly" ? 14 : 7));
    return localDate(next);
  }
  if (frequency === "yearly") {
    const targetYear = year + 1;
    const next = new Date(targetYear, month - 1, 1);
    const maxDay = new Date(targetYear, month, 0).getDate();
    next.setDate(Math.min(anchorDay || day, maxDay));
    return localDate(next);
  }
  const targetMonth = month; // JavaScript month index for the next calendar month
  const next = new Date(year, targetMonth, 1);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(anchorDay || day, maxDay));
  return localDate(next);
}
function processDueRecurringItems() {
  const today = localDate();
  let created = 0;
  const updated = recurring.map(item => {
    if (!item.nextDate || !item.frequency) return item;
    const anchorDay = Number(item.anchorDay) || Number(item.nextDate.slice(8, 10));
    let nextDate = item.nextDate;
    let guard = 0;
    while (nextDate <= today && guard < 600) {
      const alreadyExists = transactions.some(t => t.recurringId === item.id && t.recurringOccurrenceDate === nextDate);
      if (!alreadyExists) {
        transactions.push({
          id: crypto.randomUUID(),
          description: item.description,
          amount: Math.round(Number(item.amount) * 100) / 100,
          type: item.type || "expense",
          category: item.category || "Other",
          date: nextDate,
          recurring: true,
          recurringId: item.id,
          recurringOccurrenceDate: nextDate
        });
        created++;
      }
      nextDate = advanceRecurringDate(nextDate, item.frequency, anchorDay);
      guard++;
    }
    return { ...item, anchorDay, nextDate };
  });
  if (created > 0) save(STORAGE.transactions, transactions);
  if (JSON.stringify(updated) !== JSON.stringify(recurring)) save(STORAGE.recurring, updated);
  recurring = updated;
  return created;
}
function addRecurring(event) {
  event.preventDefault();const amount=Number($("#recurring-amount").value);
  if(!Number.isFinite(amount)||amount<=0){notify("Enter an amount greater than zero.");return;}
  const nextDate = $("#recurring-date").value;
  recurring.push({id:crypto.randomUUID(),description:$("#recurring-description").value.trim(),amount:Math.round(amount*100)/100,type:$("#recurring-type").value,category:$("#recurring-category").value,frequency:$("#recurring-frequency").value,nextDate,anchorDay:Number(nextDate.slice(8,10))});
  save(STORAGE.recurring,recurring);processDueRecurringItems();$("#recurring-form").reset();$("#recurring-date").value=localDate();closeDialog("recurring-dialog");render();notify("Recurring item saved.");
}
function deleteTransaction(id) { transactions=transactions.filter(t=>t.id!==id);save(STORAGE.transactions,transactions);render();notify("Transaction deleted."); }
function deleteRecurring(id) { recurring=recurring.filter(t=>t.id!==id);save(STORAGE.recurring,recurring);renderRecurring();notify("Recurring item deleted."); }

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function buildBackup() {
  return {format:"MoneyMap backup", version:1, exportedAt:new Date().toISOString(), data:{
    transactions, budgets, categoryBudgets, recurring, goals, theme:load(STORAGE.theme,"light")
  }};
}
function exportBackup() {
  const backup = buildBackup();
  downloadJSON(backup, `moneymap-backup-${localDate()}.json`);
  notify("Full backup downloaded.");
}
function validBackup(value) {
  if (!value || value.format !== "MoneyMap backup" || value.version !== 1 || !value.data || typeof value.data !== "object") return false;
  const d=value.data;
  if (!Array.isArray(d.transactions) || !Array.isArray(d.recurring) || !Array.isArray(d.goals)) return false;
  if (!d.budgets || typeof d.budgets !== "object" || !d.categoryBudgets || typeof d.categoryBudgets !== "object") return false;
  if (!d.transactions.every(t => t && typeof t === "object" && typeof t.description === "string" && Number.isFinite(Number(t.amount)) && typeof t.date === "string")) return false;
  if (!d.recurring.every(t => t && typeof t === "object" && typeof t.description === "string" && Number.isFinite(Number(t.amount)))) return false;
  if (!d.goals.every(g => g && typeof g === "object" && typeof g.name === "string")) return false;
  return true;
}
async function importBackup() {
  const input=$("#backup-file"), file=input.files?.[0];
  if (!file) { notify("Choose a backup file first."); return; }
  let parsed;
  try { parsed=JSON.parse(await file.text()); } catch { notify("That file isn't valid JSON."); return; }
  if (!validBackup(parsed)) { notify("This doesn't look like a valid MoneyMap backup."); return; }
  if (!confirm("Restore this backup? MoneyMap will first download a safety copy of your current data. The selected backup will then replace the data currently stored in this browser.")) return;
  try {
    downloadJSON(buildBackup(), `moneymap-safety-before-restore-${localDate()}.json`);
    const d=parsed.data;
    transactions=d.transactions; budgets=d.budgets; categoryBudgets=d.categoryBudgets; recurring=d.recurring; goals=d.goals;
    save(STORAGE.transactions,transactions); save(STORAGE.budgets,budgets); save(STORAGE.categoryBudgets,categoryBudgets); save(STORAGE.recurring,recurring); save(STORAGE.goals,goals);
    const theme=d.theme === "dark" ? "dark" : "light"; save(STORAGE.theme,theme); document.body.classList.toggle("dark",theme === "dark");
    render(); updateAutoBackupStatus(); input.value=""; $("#import-backup").disabled=true; notify("Backup restored. A safety copy of the previous data was downloaded.");
  } catch (error) { console.error(error); notify("Restore failed. Check browser storage and try again."); }
}

function exportCSV() {
  const filtered=getFilteredTransactions();
  if(!filtered.length){notify("There are no transactions to export.");return;}
  const rows=[["Description","Amount","Type","Category","Date","Recurring"],...filtered.map(t=>[t.description,t.amount,t.type,t.category,t.date,t.recurring?"Yes":"No"])];
  const csv=rows.map(row=>row.map(value=>`"${String(value??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"})), a=document.createElement("a");a.href=url;a.download=`moneymap-transactions-${$("#transaction-period-filter").value==="month"?selectedMonth():"all-dates"}.csv`;a.click();URL.revokeObjectURL(url);notify(`${filtered.length} filtered transaction${filtered.length===1?"":"s"} exported.`);
}
function exportReportCSV() {
  const month=selectedMonth(), [year]=month.split("-").map(Number), yearly=$("#report-period")?.value==="yearly";
  const period=yearly?String(year):month;
  const list=yearly?transactions.filter(t=>t.date?.startsWith(String(year)+"-")):monthTransactions(month);
  const rows=[[yearly?"MoneyMap Annual Report":"MoneyMap Monthly Report",period],["Type","Description","Category","Date","Amount"],...list.map(t=>[t.type,t.description,t.category,t.date,Number(t.amount||0)])];
  rows.push([], ["Summary","Amount"],["Income",sum(list,"income")],["Expenses",sum(list,"expense")],["Savings",sum(list,"saving")],["Net after expenses and savings",sum(list,"income")-sum(list,"expense")-sum(list,"saving")]);
  const csv=rows.map(row=>row.map(value=>`"${String(value??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"})),a=document.createElement("a");a.href=url;a.download=`moneymap-report-${period}.csv`;a.click();URL.revokeObjectURL(url);notify(`${yearly?"Annual":"Monthly"} report exported.`);
}
function setView(view) {
  const target = document.getElementById(`view-${view}`) ? view : "overview";
  $$(".view").forEach(el=>el.classList.toggle("active",el.id===`view-${target}`));
  $$(".nav-item").forEach(el=>el.classList.toggle("active",el.dataset.view===target));
  const names={overview:"Overview",transactions:"Transactions",budgets:"Budgets",reports:"Reports",recurring:"Recurring",goals:"Savings goals",backup:"Backup & restore"};
  $("#page-name").textContent=names[target]||"Overview";
  if(target==="reports")renderReports();
  closeMobileNavigation();
}

function closeMobileNavigation() {
  const sidebar=$("#app-sidebar"), toggle=$("#mobile-menu-toggle"), backdrop=$("#sidebar-backdrop");
  if (sidebar) {
    sidebar.classList.remove("mobile-open");
    sidebar.style.transform = "";
  }
  if (backdrop) {
    backdrop.classList.remove("is-visible");
    backdrop.style.display = "none";
  }
  toggle?.setAttribute("aria-expanded","false");
  toggle?.setAttribute("aria-label","Open navigation menu");
}
function toggleMobileNavigation() {
  const sidebar=$("#app-sidebar"), toggle=$("#mobile-menu-toggle"), backdrop=$("#sidebar-backdrop");
  if (!sidebar) return;
  const isOpen = !sidebar.classList.contains("mobile-open");
  sidebar.classList.toggle("mobile-open", isOpen);
  sidebar.style.display = isOpen ? "flex" : "";
  sidebar.style.transform = isOpen ? "translateX(0)" : "";
  if (backdrop) {
    backdrop.classList.toggle("is-visible", isOpen);
    backdrop.style.display = isOpen ? "block" : "none";
  }
  toggle?.setAttribute("aria-expanded",String(isOpen));
  toggle?.setAttribute("aria-label",isOpen?"Close navigation menu":"Open navigation menu");
}
window.toggleMobileNavigation = toggleMobileNavigation;
window.closeMobileNavigation = closeMobileNavigation;

populateMonthPicker();$("#date").value=localDate();$("#recurring-date").value=localDate();$("#year").textContent=new Date().getFullYear();
$$(".nav-item").forEach(button=>button.addEventListener("click",()=>setView(button.dataset.view)));
$$("[data-view-link]").forEach(button=>button.addEventListener("click",event=>{event.preventDefault();setView(button.dataset.viewLink);}));
$("#mobile-menu-toggle")?.addEventListener("click",toggleMobileNavigation);
$("#sidebar-backdrop")?.addEventListener("click",closeMobileNavigation);
$("#mobile-home")?.addEventListener("click",()=>setView("overview"));
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeMobileNavigation();});
window.addEventListener("resize",()=>{if(window.innerWidth>760)closeMobileNavigation();});
$("#open-add").addEventListener("click",()=>{resetTransactionDialog();openDialog("transaction-dialog");});
$("#open-recurring").addEventListener("click",()=>openDialog("recurring-dialog"));
$$("[data-close]").forEach(button=>button.addEventListener("click",()=>closeDialog(button.dataset.close)));
$("#transaction-form").addEventListener("submit",addTransaction);
$("#recurring-form").addEventListener("submit",addRecurring);
["#recurring-type-filter", "#recurring-status-filter", "#recurring-sort"].forEach(selector => $(selector)?.addEventListener("change", renderRecurring));
$("#reset-recurring-filters")?.addEventListener("click", () => {
  $("#recurring-type-filter").value = "all";
  $("#recurring-status-filter").value = "all";
  $("#recurring-sort").value = "date-asc";
  renderRecurring();
});
$("#goal-form").addEventListener("submit",addGoal);
$("#month-picker").addEventListener("change",()=>{
  const chosen = $("#month-picker").value;
  if (!/^\d{4}-\d{2}$/.test(chosen)) return;
  render();
  // Keep overview chart and all month-sensitive budget totals in sync with the newly selected month.
  const monthList = monthTransactions(chosen);
  const expenseTotal = sum(monthList, "expense");
  $("#chart-total").textContent = money(expenseTotal);
  renderSpendingChart(monthList);
  renderMiniBudgets(monthList);
  renderBudgetBreakdown(monthList);
});
$("#report-period").addEventListener("change",()=>renderReports());
$("#transaction-search").addEventListener("input",renderAllTransactions);
["#type-filter","#category-filter","#transaction-period-filter","#transaction-sort"].forEach(selector=>$(selector).addEventListener("change",renderAllTransactions));
function isValidISODate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}
["#transaction-date-from","#transaction-date-to"].forEach(selector=>$(selector).addEventListener("change",()=>{
  const input=$(selector);
  if (!isValidISODate(input.value)) {
    notify("Enter dates in YYYY-MM-DD format, for example 2025-04-30.");
    input.focus();
    return;
  }
  if($("#transaction-date-from").value || $("#transaction-date-to").value) $("#transaction-period-filter").value="all";
  renderAllTransactions();
}));
$("#reset-transaction-filters").addEventListener("click",resetTransactionFilters);
$("#export-csv").addEventListener("click",exportCSV);
$("#export-report").addEventListener("click",exportReportCSV);
$("#export-backup").addEventListener("click",exportBackup);
$("#backup-file").addEventListener("change",()=>{$("#import-backup").disabled=!$("#backup-file").files?.length;});
$("#import-backup").addEventListener("click",importBackup);
$("#overall-budget-form").addEventListener("submit",event=>{event.preventDefault();const amount=Number($("#overall-budget-input").value);if(!Number.isFinite(amount)||amount<0){notify("Enter a valid budget.");return;}budgets.monthly=Math.round(amount*100)/100;save(STORAGE.budgets,budgets);render();notify("Monthly budget updated.");});
$("#category-budget-form").addEventListener("submit",event=>{event.preventDefault();const name=$("#budget-category").value,amount=Number($("#category-budget-input").value);if(!Number.isFinite(amount)||amount<=0){notify("Enter a category budget greater than zero.");return;}categoryBudgets[name]=Math.round(amount*100)/100;save(STORAGE.categoryBudgets,categoryBudgets);$("#category-budget-input").value="";render();notify(`${name} budget saved.`);});
document.addEventListener("submit",event=>{const goalForm=event.target.closest("[data-goal-form]");if(goalForm){event.preventDefault();contributeToGoal(goalForm);}});
document.addEventListener("click",event=>{const paid=event.target.closest("[data-mark-paid]");if(paid){markRecurringPaid(paid.dataset.markPaid);return;}const goalDelete=event.target.closest("[data-delete-goal]");if(goalDelete){deleteGoal(goalDelete.dataset.deleteGoal);return;}const edit=event.target.closest("[data-edit]");if(edit){editTransaction(edit.dataset.edit);return;}const del=event.target.closest("[data-delete]");if(del)deleteTransaction(del.dataset.delete);const rec=event.target.closest("[data-delete-recurring]");if(rec)deleteRecurring(rec.dataset.deleteRecurring);});
$("#theme-toggle").addEventListener("click",()=>{document.body.classList.toggle("dark");save(STORAGE.theme,document.body.classList.contains("dark")?"dark":"light");});
if(load(STORAGE.theme,"light")==="dark")document.body.classList.add("dark");
updateAutoBackupStatus();
const autoCreatedCount = processDueRecurringItems();
render();
if (autoCreatedCount > 0) notify(`${autoCreatedCount} due recurring transaction${autoCreatedCount === 1 ? "" : "s"} added.`);

$("#cloud-signin-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!cloudClient) { authMessage("Cloud sync is not configured. Follow SETUP-CLOUD-SYNC.md first.", true); return; }
  const button = $("#cloud-signin-button"); button.disabled = true; button.textContent = "Signing in…"; authMessage("");
  try {
    const { data, error } = await cloudClient.auth.signInWithPassword({ email: $("#cloud-email").value.trim(), password: $("#cloud-password").value });
    if (error) throw error;
    if (data.user) await hydrateFromCloud(data.user);
    $("#cloud-password").value = "";
  } catch (error) { authMessage(error.message || "Sign-in failed. Check your email and password.", true); }
  finally { button.disabled = false; button.textContent = "Sign in"; }
});
$("#cloud-new-password-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("#cloud-new-password").value;
  if (password.length < 12) { authMessage("Use at least 12 characters for your new password.", true); return; }
  if (password !== $("#cloud-confirm-password").value) { authMessage("The passwords do not match.", true); return; }
  const button = $("#cloud-update-password-button"); button.disabled = true; button.textContent = "Updating…";
  try {
    const { error } = await cloudClient.auth.updateUser({ password });
    if (error) throw error;
    $("#cloud-new-password").value = ""; $("#cloud-confirm-password").value = "";
    $("#cloud-new-password-form").classList.add("hidden"); $("#cloud-signin-form").classList.remove("hidden"); $("#cloud-reset-password").classList.remove("hidden");
    await cloudClient.auth.signOut(); authMessage("Password updated. Sign in with your new password.");
  } catch (error) { authMessage(error.message || "Could not update password. Request a new reset email and try again.", true); }
  finally { button.disabled = false; button.textContent = "Update password"; }
});
$("#cloud-reset-password")?.addEventListener("click", async () => {
  if (!cloudClient) return;
  const email = $("#cloud-email").value.trim();
  if (!email) { authMessage("Enter your account email first, then choose Forgot password?", true); return; }
  const { error } = await cloudClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split("#")[0] });
  authMessage(error ? (error.message || "Password reset could not be requested.") : "If this email belongs to your account, password reset instructions will be sent.", Boolean(error));
});
$("#cloud-account-button")?.addEventListener("click", async () => {
  if (!cloudClient || !cloudUser) return;
  if (!confirm("Sign out of MoneyMap on this device? Local data remains saved in this browser.")) return;
  const { error } = await cloudClient.auth.signOut();
  if (error) { notify("Sign out failed. Please try again."); return; }
  cloudUser = null; cloudReady = false; showAuthScreen(true); $("#cloud-account-button").classList.add("hidden");
  $("#cloud-password").value = ""; authMessage("You have signed out.");
});
initializeCloud().catch(error => { console.error("MoneyMap cloud initialization failed", error); showAuthScreen(true); authMessage("Cloud setup could not be initialized. Check SETUP-CLOUD-SYNC.md and your configuration.", true); });
