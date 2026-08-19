const session = { user: "rh.nador", role: "rh", token: null, displayName: "Responsable RH" };
const roleLabels = { admin: "Administrateur", rh: "Responsable RH", manager: "Manager" };
let realDataset = null;
// Lignes brutes / classeur du dernier import Excel, conserves pour pouvoir
// ré-appliquer les filtres du dashboard (matricule / activité / date) en
// relançant exactement la même fonction de calcul (buildDatasetFromRows),
// sans dupliquer ni modifier la logique de calcul existante.
let rawImportRows = null;
let rawImportWorkbook = null;
let rawImportFileName = null;
let currentSearch = "";
let selectedCandidateIndex = 0;

function authHeaders(extra = {}) {
  return session.token ? { ...extra, Authorization: `Bearer ${session.token}` } : extra;
}

// Quand le backend renvoie 401 (jeton expire ou invalide), on ne doit pas
// laisser l'interface afficher "connecte" alors que toutes les actions
// echouent silencieusement: on force un retour a l'ecran de connexion avec
// un message clair.
function forceReauth(message) {
  session.token = null;
  localStorage.removeItem("sonasid_rh_token");
  document.body.classList.remove("is-authenticated");
  const errorEl = byId("loginError");
  if (errorEl) {
    errorEl.textContent = message || "Votre session a expiré. Reconnectez-vous pour continuer.";
    errorEl.classList.remove("is-hidden");
  }
}

const appState = {
  notifications: 3,
  jobFilter: "all",
  candidateStatusFilter: "all",
  candidateOfferFilter: "all",
  minScore: 0,
  interviewFilter: "all",
  notificationsRead: new Set(),
  completedTasks: new Set(),
  uploadFiles: [],
  selectedFiles: [],
  agentStatus: {},
  agentProgress: 0,
  importStatus: { state: "idle" },
  agentLastRun: "En attente",
  chat: [
    ["bot", "Bonjour. Posez une question RH sur le recrutement, l'effectif, le turnover, un candidat ou une offre (ex: JOB-024)."],
  ],
  chatPending: null,
  chatContext: {},
  dashboardFilters: { matricule: "", activite: "", dateFrom: "", dateTo: "" },
  deadlineThresholdDays: 90,
};

// Aucun jeu de KPI de secours: le dashboard doit rester vide tant qu'aucun
// fichier Excel n'a ete importe (voir renderDashboard).

const jobs = [
  ["JOB-024", "Data Analyst RH", "RH", 18, 6, "I. Amrani", "08/07/2026", "open", ["Python", "Power BI", "SQL", "MongoDB"]],
  ["JOB-031", "Technicien maintenance", "Production", 12, 3, "N. Berrada", "10/07/2026", "open", ["Maintenance", "Securite", "Electromecanique"]],
  ["JOB-028", "Responsable formation", "RH", 7, 2, "I. Amrani", "11/07/2026", "paused", ["Ingenierie pedagogique", "Gestion budget formation"]],
  ["JOB-018", "Ingenieur qualite", "Qualite", 24, 8, "M. Rami", "01/07/2026", "closed", ["Qualite", "ISO", "Audit"]],
];

const candidates = [
  ["Salma Bennani", "Data Analyst RH", 86, "3 ans", ["Python", "Power BI", "SQL"], "shortlisted", "17/07", null],
  ["Yassine Amrani", "Data Analyst RH", 74, "2 ans", ["Excel", "Reporting", "RH"], "under_review", "17/07", null],
  ["Noura El Idrissi", "Ingenieur qualite", 68, "4 ans", ["Qualite", "ISO", "Audit"], "requires_review", "16/07", null],
  ["Hamza Rami", "Technicien maintenance", 59, "5 ans", ["Maintenance", "Securite"], "received", "15/07", null],
];

const activities = ["Import Excel TDB_NADOR 09-2025 charge", "Analyse RH effectif terminée", "29 recrutements identifiés dans TDB", "12 départs détectés", "Pipeline RH synchronisé"];
const tasks = ["Valider les 13 candidats à vérifier", "Planifier 3 entretiens", "Compléter fiche JOB-028", "Vérifier 1 CV en erreur"];

const interviews = [
  ["INT-001", "Salma Bennani", "Data Analyst RH", "22/07/2026", "10:00", "I. Amrani", "planned", null, ""],
  ["INT-002", "Mehdi Z.", "Technicien maintenance", "23/07/2026", "14:30", "N. Berrada", "planned", null, ""],
  ["INT-003", "Noura El Idrissi", "Ingenieur qualite", "24/07/2026", "09:00", "M. Rami", "waiting", null, ""],
];
const notificationsData = ["3 CV analyses", "1 CV en erreur", "2 entretiens a planifier", "Rapport turnover pret"];

const statusLabels = { open: "Ouverte", paused: "Pause", closed: "Clôturée", shortlisted: "Présélection", under_review: "En analyse", requires_review: "À vérifier", received: "Reçu", completed: "Terminé", processing: "En cours", duplicate: "Doublon", failed: "Erreur", actif: "Actif", pret: "Prêt", simulation: "Projection", running: "Exécution", done: "Terminé", refused: "Refusé", interview: "Entretien" };

function initials(name) { return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase(); }
function badge(status) { return `<span class="badge ${status}">${statusLabels[status] || status}</span>`; }
function chips(items) { return `<div class="chips">${items.map((x) => `<span>${x}</span>`).join("")}</div>`; }
function byId(id) { return document.getElementById(id); }
function maxValue(rows) { return Math.max(1, ...rows.map((x) => Number(x.value) || 0)); }
function matchesSearch(row) { return !currentSearch || row.join(" ").toLowerCase().includes(currentSearch.toLowerCase()); }

function toast(message, type = "info") {
  const host = byId("toastHost");
  if (!host) return;
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.innerHTML = `<strong>${type === "success" ? "Action terminée" : "Information"}</strong><span>${message}</span>`;
  host.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function pushActivity(message) {
  activities.unshift(message);
  if (activities.length > 10) activities.pop();
}

async function loadRealDataset() {
  try {
    const response = await fetch("/static/data/tdb_nador_09_2025.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Dataset introuvable");
    realDataset = await response.json();
  } catch (error) {
    console.warn("Dataset reel non charge", error);
    realDataset = null;
  }
}

function setView(viewId) {
  const target = document.querySelector(`[data-view="${viewId}"]`);
  if (!target || target.classList.contains("is-hidden")) viewId = "dashboard";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  byId(viewId).classList.add("active");
  const active = document.querySelector(`[data-view="${viewId}"]`);
  active.classList.add("active");
  const label = active.childNodes[active.childNodes.length - 1].textContent.trim();
  byId("pageTitle").textContent = label;
  byId("breadcrumb").textContent = `SONASID Nador / ${label}`;
}

function applyRolePermissions() {
  document.body.dataset.role = session.role;
  document.querySelectorAll("[data-roles]").forEach((el) => {
    const allowed = el.dataset.roles.split(",").includes(session.role);
    el.classList.toggle("is-hidden", !allowed);
  });
  byId("currentUserName").textContent = session.user;
  byId("currentUserRole").textContent = session.displayName || roleLabels[session.role];
  byId("userAvatar").textContent = session.role === "admin" ? "AD" : session.role === "manager" ? "MG" : "RH";
  byId("topAvatar").textContent = byId("userAvatar").textContent;
  setView(document.querySelector(".view.active")?.id || "dashboard");
}

// Corps commun "barres horizontales + pourcentage" (liste classee), reutilise
// par renderDistribution (panneau large) et renderKpiDistributionCard (petite
// carte KPI) pour eviter de dupliquer le calcul de pourcentage/largeur.
function renderRankListBody(rows) {
  const max = maxValue(rows);
  const total = rows.reduce((sum, row) => sum + (row.value || 0), 0) || 1;
  return `<div class="rank-list">${rows.map((row) => `<div><span>${row.label}</span><strong>${row.value}<b class="rank-pct">${((row.value / total) * 100).toFixed(1)}%</b></strong><i style="width:${(row.value / max) * 100}%"></i></div>`).join("")}</div>`;
}

function renderDistribution(title, rows, tag = "dataset reel") {
  if (!rows || !rows.length) return `<section class="panel"><div class="panel-head"><h2>${title}</h2><span>${tag}</span></div><p class="empty-col">Aucune donnée disponible.</p></section>`;
  return `<section class="panel"><div class="panel-head"><h2>${title}</h2><span>${tag}</span></div>${renderRankListBody(rows)}</section>`;
}

// Carte KPI au format compact (meme habillage que renderKpiGroup: memes
// classes .panel.kpi-group / .panel-head, meme etat vide), mais dont le
// contenu est une repartition (barres horizontales + %) plutot que des
// tuiles chiffrees. Utilisee pour "État des départs (motifs)".
function renderKpiDistributionCard(title, tag, rows) {
  if (!rows || !rows.length) {
    return `<section class="panel kpi-group"><div class="panel-head"><h2>${title}</h2><span>${tag}</span></div><div class="kpi-empty"><p>Aucune donnée disponible.</p></div></section>`;
  }
  return `<section class="panel kpi-group"><div class="panel-head"><h2>${title}</h2><span>${tag}</span></div>${renderRankListBody(rows)}</section>`;
}

// Graphique de synthese annuelle: 4 courbes cumulees (departs, recrutements,
// demissions, retraites) mois par mois sur l'annee en cours - remplace les
// anciens panneaux "Recrutements par mois" et "Indicateurs TDB" (retour RH).
function renderMovementsChart(title, rows) {
  if (!rows || !rows.length) {
    return `<section class="panel wide movements-panel"><div class="panel-head"><h2>${title}</h2><span>${realDataset ? "non disponible" : "aucun fichier importé"}</span></div><p class="empty-col">${realDataset ? "Aucun mouvement (recrutement / départ) exploitable dans le fichier importé." : "Importez le fichier Excel annuel pour afficher ce graphique."}</p></section>`;
  }
  const series = [
    { key: "depart", label: "Départs cumulés", color: "#C53030" },
    { key: "recrutement", label: "Recrutements cumulés", color: "#14804A" },
    { key: "demission", label: "Démissions cumulées", color: "#D4A017" },
    { key: "retraite", label: "Retraites cumulées", color: "#F05A28" },
    { key: "licenciement", label: "Licenciements cumulés", color: "#7C3AED" },
  ];
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
  const w = 780, h = 280, padL = 30, padB = 28, padT = 26, padR = 16;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const stepX = rows.length > 1 ? plotW / (rows.length - 1) : 0;
  const scaleY = (v) => padT + plotH - (v / max) * plotH;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${padL}" x2="${w - padR}" y1="${(padT + plotH * (1 - f)).toFixed(1)}" y2="${(padT + plotH * (1 - f)).toFixed(1)}" stroke="#EEF0F3" stroke-width="1" />`).join("");
  const paths = series.map((s) => {
    const points = rows.map((r, i) => `${(padL + i * stepX).toFixed(1)},${scaleY(r[s.key] || 0).toFixed(1)}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
  }).join("");
  // Points + valeur affichee sur chaque point (comme le modele de reference)
  // + un <title> natif pour le survol (tooltip) sans dependance externe.
  const dotsAndLabels = series.map((s, sIdx) => rows.map((r, i) => {
    const cx = (padL + i * stepX).toFixed(1);
    const cy = scaleY(r[s.key] || 0);
    const dy = sIdx % 2 === 0 ? -8 : 14;
    return `<g class="mv-point">
      <circle class="mv-dot" cx="${cx}" cy="${cy.toFixed(1)}" r="3.4" fill="${s.color}" data-series="${s.label}" data-month="${r.label}" data-value="${r[s.key] || 0}" data-color="${s.color}"><title>${s.label} — ${r.label} : ${r[s.key] || 0}</title></circle>
      <text x="${cx}" y="${(cy + dy).toFixed(1)}" font-size="9.5" font-weight="700" fill="${s.color}" text-anchor="middle">${r[s.key] || 0}</text>
    </g>`;
  }).join("")).join("");
  const xLabels = rows.map((r, i) => `<text x="${(padL + i * stepX).toFixed(1)}" y="${h - 8}" font-size="10" fill="#7A838E" text-anchor="middle">${r.label}</text>`).join("");
  return `<section class="panel wide movements-panel">
    <div class="panel-head"><h2>${title}</h2><span>dataset réel — cumul annuel</span></div>
    <ul class="movements-legend">${series.map((s) => `<li><i style="background:${s.color}"></i>${s.label}<b>${rows[rows.length - 1][s.key] || 0}</b></li>`).join("")}</ul>
    <svg viewBox="0 0 ${w} ${h}" class="movements-chart" preserveAspectRatio="xMidYMid meet">${gridLines}${paths}${dotsAndLabels}${xLabels}</svg>
  </section>`;
}

// Info-bulle flottante au survol des points du graphique de mouvements
// (delegation d'evenements: fonctionne meme apres un re-render du dashboard).
let movementsTooltipEl = null;
function ensureMovementsTooltip() {
  if (!movementsTooltipEl) {
    movementsTooltipEl = document.createElement("div");
    movementsTooltipEl.className = "mv-tooltip";
    document.body.appendChild(movementsTooltipEl);
  }
  return movementsTooltipEl;
}
document.addEventListener("mouseover", (e) => {
  const dot = e.target.closest?.(".mv-dot");
  if (!dot) return;
  const tip = ensureMovementsTooltip();
  tip.style.borderColor = dot.dataset.color;
  tip.innerHTML = `<strong style="color:${dot.dataset.color}">${dot.dataset.series}</strong><span>${dot.dataset.month} — ${dot.dataset.value}</span>`;
  tip.style.display = "block";
});
document.addEventListener("mousemove", (e) => {
  if (!movementsTooltipEl || movementsTooltipEl.style.display !== "block") return;
  movementsTooltipEl.style.left = `${e.clientX + 14}px`;
  movementsTooltipEl.style.top = `${e.clientY + 14}px`;
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest?.(".mv-dot") && movementsTooltipEl) movementsTooltipEl.style.display = "none";
});

// Donut CSS pur (conic-gradient) pour un rendu "grand dashboard" (type Power BI / GoodData)
function renderDonut(title, segments, tag = "") {
  const total = segments.reduce((sum, s) => sum + (s.value || 0), 0) || 1;
  let acc = 0;
  const stops = segments.map((s) => {
    const start = (acc / total) * 100;
    acc += s.value || 0;
    const end = (acc / total) * 100;
    return `${s.color} ${start}% ${end}%`;
  }).join(", ");
  return `<section class="panel donut-panel">
    <div class="panel-head"><h2>${title}</h2><span>${tag}</span></div>
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${stops});"><div class="donut-hole"><strong>${total}</strong><span>total</span></div></div>
      <ul class="donut-legend">${segments.map((s) => `<li><i style="background:${s.color}"></i>${s.label}<b>${s.value}</b></li>`).join("")}</ul>
    </div>
  </section>`;
}

function renderCandidatureDonut() {
  if (!candidates.length) return `<section class="panel"><div class="panel-head"><h2>Répartition des candidatures</h2><span>temps réel</span></div><p class="empty-col">Aucune candidature pour le moment.</p></section>`;
  const counts = {};
  candidates.forEach((c) => { counts[c[5]] = (counts[c[5]] || 0) + 1; });
  const palette = { received: "#7C3AED", under_review: "#B7791F", requires_review: "#DB2777", shortlisted: "#14804A", interview: "#2563EB", refused: "#C53030", done: "#0EA5A5" };
  const segments = Object.entries(counts).map(([status, value]) => ({ label: statusLabels[status] || status, value, color: palette[status] || "#94A3B8" }));
  return renderDonut("Répartition des candidatures", segments, "temps réel");
}

// État de recrutement: pilote par le module offres/candidatures (toujours
// disponible independamment du fichier Excel importe).
function renderRecruitmentState() {
  const openJobs = jobs.filter((j) => j[7] === "open").length;
  const pausedJobs = jobs.filter((j) => j[7] === "paused").length;
  const shortlisted = candidates.filter((c) => c[5] === "shortlisted").length;
  const validated = candidates.filter((c) => c[5] === "interview" || c[5] === "done").length;
  return `<section class="panel"><div class="panel-head"><h2>État de recrutement</h2><span>temps réel</span></div><div class="status-list">
    <div><span>Postes ouverts</span><strong>${openJobs}</strong></div>
    <div><span>Postes en pause</span><strong>${pausedJobs}</strong></div>
    <div><span>Candidatures reçues</span><strong>${candidates.length}</strong></div>
    <div><span>Présélectionnés</span><strong>${shortlisted}</strong></div>
    <div><span>Recrutements en voie de validation</span><strong>${validated}</strong></div>
  </div></section>`;
}

function renderDeparturesPanel() {
  if (!realDataset) return `<section class="panel"><div class="panel-head"><h2>État des départs (motifs)</h2><span>aucun fichier importé</span></div><p class="empty-col">Importez le fichier Excel annuel pour afficher les motifs de départ.</p></section>`;
  return renderDistribution("État des départs (motifs)", realDataset.distributions.departureReasons, "dataset réel — colonne \"Motif\"");
}

function renderHsPanel() {
  if (!realDataset) return `<section class="panel"><div class="panel-head"><h2>Heures supplémentaires (HS)</h2><span>aucun fichier importé</span></div><p class="empty-col">Importez le fichier Excel annuel pour afficher ce volet.</p></section>`;
  const hs = realDataset.summary.hs;
  if (!hs) return `<section class="panel"><div class="panel-head"><h2>Heures supplémentaires (HS)</h2><span>non disponible</span></div><p class="empty-col">Aucune colonne "Forfait HS" / heures supplémentaires trouvée dans le fichier importé.</p></section>`;
  return `<section class="panel"><div class="panel-head"><h2>Heures supplémentaires (HS)</h2><span>dataset réel — ${hs.sheet}</span></div><div class="stat-tiles">
    <article><strong>${hs.total.toLocaleString("fr-FR")} DH</strong><span>provision cumulée</span></article>
    <article><strong>${hs.count}</strong><span>salariés concernés</span></article>
  </div></section>`;
}

function renderCongesPanel() {
  if (!realDataset) return `<section class="panel"><div class="panel-head"><h2>Congés (CR)</h2><span>aucun fichier importé</span></div><p class="empty-col">Importez le fichier Excel annuel pour afficher ce volet.</p></section>`;
  const conges = realDataset.summary.conges;
  if (!conges) return `<section class="panel"><div class="panel-head"><h2>Congés (CR)</h2><span>non disponible</span></div><p class="empty-col">Aucune colonne "Congés" trouvée dans le fichier importé.</p></section>`;
  return `<section class="panel"><div class="panel-head"><h2>Congés (CR)</h2><span>dataset réel — ${conges.sheet}</span></div><div class="stat-tiles"><article><strong>${conges.total.toLocaleString("fr-FR")}</strong><span>jours (colonne "${conges.sheet}")</span></article></div></section>`;
}

function renderEffectifErPanel() {
  if (!realDataset) return `<section class="panel"><div class="panel-head"><h2>Effectif E.E (découpage par entreprise)</h2><span>aucun fichier importé</span></div><p class="empty-col">Importez le fichier Excel annuel pour afficher ce volet.</p></section>`;
  const eff = realDataset.summary.effectifEntreprise;
  if (!eff) return `<section class="panel"><div class="panel-head"><h2>Effectif E.E (découpage par entreprise)</h2><span>non disponible</span></div><p class="empty-col">Aucune colonne identifiant SONASID / sous-traitants trouvée dans le fichier importé.</p></section>`;
  return `<section class="panel"><div class="panel-head"><h2>Effectif E.E (découpage par entreprise)</h2><span>dataset réel</span></div><div class="cv-insights"><article><strong>${eff.total}</strong><span>effectif entreprise (colonne "${eff.sheet}")</span></article></div></section>`;
}

function renderPyramid(title, rows) {
  if (!rows || !rows.length) return `<section class="panel wide pyramid-panel"><div class="panel-head"><h2>${title}</h2><span>${realDataset ? "non disponible" : "aucun fichier importé"}</span></div><p class="empty-col">${realDataset ? "Cette répartition n'a pas pu être calculée depuis le fichier importé." : "Importez le fichier Excel annuel pour afficher cette pyramide."}</p></section>`;
  const max = Math.max(1, ...rows.map(([, h, f]) => Math.max(h || 0, f || 0)));
  return `<section class="panel wide pyramid-panel">
    <div class="panel-head"><h2>${title}</h2><span>dataset réel</span></div>
    <div class="pyramid-legend"><span class="pyr-tag men">Hommes</span><span class="pyr-tag women">Femmes</span></div>
    <div class="pyramid-chart">${rows.map(([label, h, f]) => `
      <div class="pyramid-row">
        <div class="pyr-side men"><span class="pyr-value">${h}</span><i style="width:${(h / max) * 100}%"></i></div>
        <div class="pyr-label">${label}</div>
        <div class="pyr-side women"><i style="width:${(f / max) * 100}%"></i><span class="pyr-value">${f}</span></div>
      </div>`).join("")}
    </div>
  </section>`;
}

// Calcule le niveau d'urgence des echeances de contrats hors CDI en fonction
// d'un seuil de jours configurable par l'utilisateur (retour RH), a partir de
// la liste brute des jours restants par contrat (calcul inchange, seule la
// lecture du seuil est nouvelle).
function computeDeadlineAlert(daysList, threshold) {
  if (!daysList) return { level: "unknown", threshold };
  const within = daysList.filter((d) => d != null && d <= threshold);
  if (!within.length) return { level: "ok", count: 0, threshold };
  const urgentCount = within.filter((d) => d <= 30).length;
  return { level: urgentCount > 0 ? "urgent" : "soon", count: within.length, threshold };
}

function renderDeadlinePyramid(title, rows, daysList) {
  const threshold = appState.deadlineThresholdDays;
  const thresholdField = `<label class="deadline-threshold-field">Afficher les contrats arrivant à échéance dans
    <input type="number" min="0" step="1" data-action="deadline-threshold" value="${threshold}" /> jours</label>`;
  if (!rows || !rows.length) return `<section class="panel wide pyramid-panel"><div class="panel-head"><h2>${title}</h2><span>${realDataset ? "non disponible" : "aucun fichier importé"}</span></div>${thresholdField}<p class="empty-col">${realDataset ? "Aucun contrat hors CDI avec date de début exploitable dans le fichier importé." : "Importez le fichier Excel annuel pour afficher cette pyramide."}</p></section>`;
  const max = Math.max(1, ...rows.map(([, v]) => v || 0));
  // Bornes representatives de chaque tranche, pour recolorer dynamiquement les
  // barres en "urgent" des lors que leur borne haute passe sous le seuil
  // choisi (le decoupage et les valeurs des tranches restent inchanges).
  const bucketBounds = { "< 9 jours": 9, "< 30 jours": 30, "30 à 90 jours": 90 };
  const withinCount = daysList ? daysList.filter((d) => d != null && d <= threshold).length : null;
  return `<section class="panel wide pyramid-panel">
    <div class="panel-head"><h2>${title}</h2><span>dataset réel - contrats hors CDI</span></div>
    ${thresholdField}
    ${withinCount != null ? `<p class="deadline-threshold-result">${withinCount ? `⚠️ ${withinCount} contrat(s) hors CDI à échéance sous ${threshold} jour(s).` : `✅ Aucun contrat hors CDI à échéance sous ${threshold} jour(s).`}</p>` : ""}
    <div class="deadline-chart">${rows.map(([label, value, urgency]) => {
      const bound = bucketBounds[label];
      const finalUrgency = bound !== undefined && bound <= threshold ? "urgent" : urgency;
      return `
      <div class="deadline-row">
        <span class="deadline-label">${label}</span>
        <div class="deadline-track"><i class="deadline-fill ${finalUrgency || "mid"}" style="width:${(value / max) * 100}%"></i></div>
        <strong class="deadline-value ${value > 0 ? (finalUrgency || "mid") : ""}">${value}</strong>
      </div>`;
    }).join("")}
    </div>
    <div class="deadline-legend">
      <span class="deadline-tag urgent">&lt; 9 jours — action immédiate</span>
      <span class="deadline-tag soon">&lt; 30 jours — à anticiper</span>
      <span class="deadline-tag mid">30 à 90 jours — à suivre</span>
    </div>
  </section>`;
}

// Banniere en tete de dashboard: remplace l'ancien bloc "Dataset reel connecte"
// par une alerte utile et actionnable, liee a la pyramide des echeances de
// contrats (retour RH: le bloc dataset n'apportait pas d'information utile).
// Le seuil de jours est desormais configurable (voir la pyramide plus bas).
function renderDeadlineAlertBanner(daysList) {
  const threshold = appState.deadlineThresholdDays;
  const alert = computeDeadlineAlert(daysList, threshold);
  if (alert.level === "unknown") {
    return `<section class="alert-banner info"><div><strong>Aucun fichier importé</strong><p>Importez le fichier Excel RH annuel (menu "Import annuel") pour afficher les indicateurs réels et les alertes d'échéance de contrats.</p></div><button class="btn primary" data-action="go-import">Importer le fichier Excel</button></section>`;
  }
  if (alert.level === "urgent") {
    return `<section class="alert-banner urgent"><div><strong>🔴 ${alert.count} contrat${alert.count > 1 ? "s" : ""} à échéance sous ${threshold} jours</strong><p>Action immédiate recommandée : anticipez le renouvellement ou la fin de contrat avec le service RH.</p></div></section>`;
  }
  if (alert.level === "soon") {
    return `<section class="alert-banner soon"><div><strong>🟠 ${alert.count} contrat${alert.count > 1 ? "s" : ""} à échéance sous ${threshold} jours</strong><p>À anticiper avec le service RH dans les prochaines semaines.</p></div></section>`;
  }
  return `<section class="alert-banner ok"><div><strong>✅ Aucune échéance urgente</strong><p>Aucun contrat hors CDI n'arrive à échéance sous ${threshold} jours.</p></div></section>`;
}

// Barre de filtres du dashboard (matricule / activite / date). Ne fonctionne
// que sur les donnees issues d'un import Excel manuel (les seules pour
// lesquelles on dispose des lignes brutes necessaires au filtrage).
function renderDashboardFilters() {
  const f = appState.dashboardFilters;
  const enabled = !!rawImportRows;
  const hasActiveFilter = f.matricule || f.activite || f.dateFrom || f.dateTo;
  return `<section class="filters-bar${enabled ? "" : " disabled"}">
    <span class="filters-bar-label">Filtrer les données</span>
    <input type="text" data-action="filter-matricule" placeholder="Matricule" value="${f.matricule || ""}" ${enabled ? "" : "disabled"} />
    <input type="text" data-action="filter-activite" placeholder="Activité" value="${f.activite || ""}" ${enabled ? "" : "disabled"} />
    <label class="date-filter">Du <input type="date" data-action="filter-date-from" aria-label="Date de début" value="${f.dateFrom || ""}" ${enabled ? "" : "disabled"} /></label>
    <label class="date-filter">Au <input type="date" data-action="filter-date-to" aria-label="Date de fin" value="${f.dateTo || ""}" min="${f.dateFrom || ""}" ${enabled ? "" : "disabled"} /></label>
    ${hasActiveFilter ? `<button type="button" class="btn ghost small" data-action="filter-reset">Réinitialiser</button>` : ""}
    ${enabled ? "" : `<small class="filters-bar-hint">disponible après import du fichier Excel annuel</small>`}
  </section>`;
}

// Carte KPI groupee: regroupe plusieurs indicateurs lies (ex: Effectif,
// Contrats, Genre) dans une seule carte au design uniforme, plutot qu'une
// carte par indicateur (retour RH). Le pourcentage est desormais l'element
// visuel principal (grand, en haut), suivi du nombre puis du libelle.
function renderKpiGroup(group) {
  if (!group.items.length) {
    return `<section class="panel kpi-group"><div class="panel-head"><h2>${group.title}</h2><span>${group.tag}</span></div><div class="kpi-empty"><p>Aucune donnée disponible.</p></div></section>`;
  }
  return `<section class="panel kpi-group"><div class="panel-head"><h2>${group.title}</h2><span>${group.tag}</span></div>
    <div class="kpi-group-grid">${group.items.map((it) => {
      const hasPct = it.pct !== undefined && it.pct !== null;
      return `<div class="kpi-group-item ${it.tone || "info"}">
        <strong class="kpi-pct">${hasPct ? it.pct : it.value}</strong>
        ${hasPct ? `<span class="kpi-num">${it.value}</span>` : ""}
        <small class="kpi-label">${it.label}</small>
      </div>`;
    }).join("")}</div>
  </section>`;
}

function renderDashboard() {
  const daysList = realDataset ? realDataset.distributions.contractDeadlineDays : null;
  if (!realDataset) {
    byId("dashboard").innerHTML = `
      ${renderDeadlineAlertBanner(null)}
      ${renderDashboardFilters()}
      <div class="dashboard-grid">
        ${renderMovementsChart("Mouvements du personnel (cumul annuel)", null)}
        ${renderHsPanel()}
        ${renderCongesPanel()}
        ${renderDeadlinePyramid("Pyramide des échéances de contrats", null, null)}
        ${renderDeparturesPanel()}
        ${renderPyramid("Pyramide des âges (H/F)", null)}
        ${renderPyramid("Pyramide d'ancienneté (H/F)", null)}
        <section class="panel"><div class="panel-head"><h2>Tâches RH prioritaires</h2><span>${appState.completedTasks.size}/${tasks.length}</span></div><div class="task-list clean">${tasks.map((x, index) => `<label class="${appState.completedTasks.has(index) ? "done" : ""}"><input data-action="task-toggle" data-index="${index}" type="checkbox" ${appState.completedTasks.has(index) ? "checked" : ""} /><span>${x}</span></label>`).join("")}</div></section>
        ${renderRecruitmentState()}
        ${renderCandidatureDonut()}
      </div>`;
    return;
  }
  const dist = realDataset.distributions;
  byId("dashboard").innerHTML = `
    ${renderDeadlineAlertBanner(daysList)}
    ${renderDashboardFilters()}
    <div class="kpi-groups-grid">${realDataset.kpiGroups.map((g) => (g.type === "distribution" ? renderKpiDistributionCard(g.title, g.tag, g.rows) : renderKpiGroup(g))).join("")}</div>
    <div class="dashboard-grid">
      ${renderMovementsChart("Mouvements du personnel (cumul annuel)", dist.movementsCumulative)}
      ${renderHsPanel()}
      ${renderCongesPanel()}
      ${renderDeadlinePyramid("Pyramide des échéances de contrats", dist.contractDeadline, daysList)}
      ${renderPyramid("Pyramide des âges (H/F)", dist.ageByGender)}
      ${renderPyramid("Pyramide d'ancienneté (H/F)", dist.seniorityByGender)}
      <section class="panel"><div class="panel-head"><h2>Tâches RH prioritaires</h2><span>${appState.completedTasks.size}/${tasks.length}</span></div><div class="task-list clean">${tasks.map((x, index) => `<label class="${appState.completedTasks.has(index) ? "done" : ""}"><input data-action="task-toggle" data-index="${index}" type="checkbox" ${appState.completedTasks.has(index) ? "checked" : ""} /><span>${x}</span></label>`).join("")}</div></section>
      ${renderRecruitmentState()}
      ${renderCandidatureDonut()}
    </div>`;
}

// Ré-applique les filtres du dashboard (matricule / activité / date) sur les
// lignes brutes du dernier import Excel, en relançant EXACTEMENT la meme
// fonction de calcul que l'import initial (aucune nouvelle logique de calcul).
function applyDashboardFilters() {
  if (!rawImportRows) { renderDashboard(); return; }
  const { matricule, activite, dateFrom, dateTo } = appState.dashboardFilters;
  let filtered = rawImportRows;
  if (matricule && matricule.trim()) {
    const q = matricule.trim().toLowerCase();
    filtered = filtered.filter((r) => { const v = findColumnValue(r, ["matricule"]); return v != null && String(v).toLowerCase().includes(q); });
  }
  if (activite && activite.trim()) {
    const q = activite.trim().toLowerCase();
    filtered = filtered.filter((r) => { const v = findColumnValue(r, ["activit"]); return v != null && String(v).toLowerCase().includes(q); });
  }
  if (dateFrom || dateTo) {
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`) : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`) : null;
    filtered = filtered.filter((r) => {
      const start = excelDateToJs(r["DEB_CONTRAT"]);
      return !start || ((!from || start >= from) && (!to || start <= to));
    });
  }
  realDataset = buildDatasetFromRows(filtered, rawImportFileName, rawImportWorkbook);
  renderDashboard();
}

// Conserve le focus + la position du curseur sur un champ de filtre pendant
// que le dashboard se re-rend entierement (nouvelle saisie en temps reel).
function withFocusPreserved(action, fn) {
  const active = document.activeElement;
  const isTarget = active && active.matches && active.matches(`[data-action="${action}"]`);
  const selStart = isTarget ? active.selectionStart : null;
  const selEnd = isTarget ? active.selectionEnd : null;
  fn();
  if (isTarget) {
    const el = document.querySelector(`[data-action="${action}"]`);
    if (el) {
      el.focus();
      if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* champs sans selection (ex: type=date) */ } }
    }
  }
}

function renderImportData() {
  const status = appState.importStatus || { state: "idle" };
  const banner = realDataset
    ? `<div class="import-current"><span>Dataset actuellement chargé</span><strong>${realDataset.sourceFile}</strong><small>${realDataset.site} - période ${realDataset.period}</small></div>`
    : `<div class="import-current empty"><span>Aucun fichier importé</span><strong>Le dashboard est actuellement vide</strong></div>`;
  let statusMarkup = "";
  if (status.state === "loading") statusMarkup = `<div class="import-status loading">Analyse du fichier Excel en cours...</div>`;
  else if (status.state === "success") statusMarkup = `<div class="import-status success">Import réussi: ${status.message}</div>`;
  else if (status.state === "error") statusMarkup = `<div class="import-status error">Erreur d'import: ${status.message}</div>`;

  const sheetSynthesis = realDataset
    ? `<section class="panel wide sheet-panel"><div class="panel-head"><h2>Synthèse du dernier fichier importé</h2><span>${realDataset.generatedFrom}</span></div><div class="sheet-list">${realDataset.sheets.map((s) => `<article><strong>${s.name}</strong><span>${s.rows} lignes</span><span>${s.columns} colonnes</span><b>${s.nonEmptyCells} cellules</b></article>`).join("")}</div></section>`
    : "";

  byId("import-data").innerHTML = `<div class="import-grid">
    <section class="panel">
      <h2>Importer les données RH annuelles</h2>
      <p class="muted">Déposez le fichier Excel RH (TDB annuel, feuille EFFECTIF) pour mettre à jour automatiquement le tableau de bord: effectifs, pyramides des âges et d'ancienneté par genre, échéances de contrats et indicateurs clés.</p>
      <input id="importExcelInput" class="sr-only" type="file" accept=".xlsx,.xls" />
      <button class="dropzone" data-action="import-excel-trigger">Sélectionner le fichier Excel annuel<br><small>Format accepté: .xlsx</small></button>
      ${statusMarkup}
    </section>
    <section class="panel">
      <h2>État de l'import</h2>
      ${banner}
      <p class="muted">Le tableau de bord se met à jour automatiquement dès la fin de l'analyse du fichier, sans rechargement de page.</p>
    </section>
    ${sheetSynthesis}
  </div>`;
}

function bucketSortKey(label) {
  const match = String(label).match(/(\d+)/);
  return match ? Number(match[1]) : 999;
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v.startsWith("mr") || v.startsWith("m.") || v === "m") return "h";
  return "f";
}

function excelDateToJs(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(Math.round((value - 25569) * 86400 * 1000));
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Cherche une colonne numerique dans n'importe quelle feuille du classeur
// (ex: "Forfait HS", "Congés") pour ne jamais inventer un chiffre quand la
// donnee n'existe pas dans le fichier importe.
function findNumericColumnAcrossSheets(workbook, keywords) {
  if (!workbook) return null;
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
    if (!rows.length) continue;
    const sampleKeys = Object.keys(rows[0] || {});
    const matchKey = sampleKeys.find((k) => keywords.some((kw) => String(k).toLowerCase().includes(kw)));
    if (matchKey) {
      const values = rows
        .filter((r) => r[matchKey] !== null && r[matchKey] !== undefined && r[matchKey] !== "" && !Number.isNaN(Number(r[matchKey])))
        .map((r) => Number(r[matchKey]));
      if (values.length) return { sheetName, column: matchKey, values };
    }
  }
  return null;
}

function buildDatasetFromRows(rows, fileName, workbook) {
  const total = rows.length;
  const active = rows.filter((r) => Number(r["Toujours à la sonasid la sonasid"]) === 1);
  const cdi = rows.filter((r) => r["Type contrat"] === "CDI").length;
  const nonCdi = rows.filter((r) => r["Type contrat"] && r["Type contrat"] !== "CDI");
  const departures = rows.filter((r) => r["Date de départ"]).length;

  // Répartition des motifs de départ (colonne "Motif"), générée uniquement à
  // partir des valeurs réellement présentes dans le dataset: les lignes sans
  // motif exploitable (null / vide / non numérique-texte) sont ignorées
  // plutôt que d'être regroupées dans une fausse catégorie "Non renseigné".
  const motifCounts = { Licenciement: 0 };
  rows.forEach((r) => {
    if (!r["Date de départ"]) return;
    const motifRaw = r["Motif"];
    if (motifRaw === null || motifRaw === undefined) return;
    const motif = String(motifRaw).trim();
    if (!motif) return;
    const normalizedMotif = motif.toLowerCase().includes("licenci") ? "Licenciement" : motif;
    motifCounts[normalizedMotif] = (motifCounts[normalizedMotif] || 0) + 1;
  });
  const departureReasons = Object.entries(motifCounts)
    .filter(([label, value]) => label === "Licenciement" || value > 0)
    .map(([label, value]) => ({ label, value }));
  const licenciements = motifCounts.Licenciement;

  const genderCount = { h: 0, f: 0 };
  const collegeCount = {};
  const contratCount = {};
  const ageBuckets = {};
  const seniorityBuckets = {};
  let ageSum = 0, ageN = 0, senSum = 0, senN = 0;

  active.forEach((r) => {
    const g = normalizeGender(r["Sexe"]);
    genderCount[g] += 1;
    const college = r["Collège"] || "Non renseigné";
    collegeCount[college] = (collegeCount[college] || 0) + 1;
    const contrat = r["Type contrat"] || "Non renseigné";
    contratCount[contrat] = (contratCount[contrat] || 0) + 1;

    const ageBucket = r["pyramide age"];
    if (ageBucket) {
      ageBuckets[ageBucket] = ageBuckets[ageBucket] || { h: 0, f: 0 };
      ageBuckets[ageBucket][g] += 1;
    }
    const senBucket = r["pyramide ANCIENNTE"];
    if (senBucket) {
      seniorityBuckets[senBucket] = seniorityBuckets[senBucket] || { h: 0, f: 0 };
      seniorityBuckets[senBucket][g] += 1;
    }
    if (typeof r["Âge"] === "number") { ageSum += r["Âge"]; ageN += 1; }
    if (typeof r["ANCIENNTE"] === "number") { senSum += r["ANCIENNTE"]; senN += 1; }
  });

  const ageByGender = Object.entries(ageBuckets).sort((a, b) => bucketSortKey(a[0]) - bucketSortKey(b[0])).map(([label, v]) => [label, v.h, v.f]);
  const seniorityByGender = Object.entries(seniorityBuckets).sort((a, b) => bucketSortKey(a[0]) - bucketSortKey(b[0])).map(([label, v]) => [label, v.h, v.f]);

  const now = new Date();
  const deadlineBuckets = { "< 9 jours": 0, "< 30 jours": 0, "30 à 90 jours": 0 };
  const deadlineDaysList = [];
  nonCdi.forEach((r) => {
    if (r["Date de départ"]) return;
    const start = excelDateToJs(r["DEB_CONTRAT"]);
    if (!start) return;
    let deadline = new Date(start);
    while (deadline.getTime() < now.getTime()) deadline.setFullYear(deadline.getFullYear() + 1);
    const days = Math.round((deadline.getTime() - now.getTime()) / 86400000);
    deadlineDaysList.push(days);
    if (days < 9) deadlineBuckets["< 9 jours"] += 1;
    else if (days < 30) deadlineBuckets["< 30 jours"] += 1;
    else if (days <= 90) deadlineBuckets["30 à 90 jours"] += 1;
  });
  const urgencyMap = { "< 9 jours": "urgent", "< 30 jours": "urgent", "30 à 90 jours": "soon" };
  const contractDeadline = Object.entries(deadlineBuckets).map(([label, value]) => [label, value, urgencyMap[label]]);

  const now2 = new Date();
  const monthlyBuckets = [];
  for (let i = 7; i >= 0; i -= 1) {
    const d = new Date(now2.getFullYear(), now2.getMonth() - i, 1);
    monthlyBuckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("fr-FR", { month: "short" }), value: 0 });
  }
  rows.forEach((r) => {
    const start = excelDateToJs(r["DEB_CONTRAT"]);
    if (!start) return;
    const key = `${start.getFullYear()}-${start.getMonth()}`;
    const bucket = monthlyBuckets.find((b) => b.key === key);
    if (bucket) bucket.value += 1;
  });
  const monthlyActivity = monthlyBuckets.map((b) => ({ label: b.label, value: b.value }));

  // Mouvements cumules sur l'annee la plus representee dans le fichier
  // (et non l'annee systeme, qui ne correspond pas forcement aux dates du
  // classeur importe): recrutements, departs, et le detail demission /
  // retraite (colonne "Motif"), pour le graphique de synthese annuelle.
  const yearTally = {};
  rows.forEach((r) => {
    const start = excelDateToJs(r["DEB_CONTRAT"]);
    if (start) yearTally[start.getFullYear()] = (yearTally[start.getFullYear()] || 0) + 1;
    const dep = excelDateToJs(r["Date de départ"]);
    if (dep) yearTally[dep.getFullYear()] = (yearTally[dep.getFullYear()] || 0) + 1;
  });
  const movementYear = Object.keys(yearTally).length
    ? Number(Object.entries(yearTally).sort((a, b) => b[1] - a[1])[0][0])
    : now.getFullYear();
  const monthShortLabels = Array.from({ length: 12 }, (_, i) => new Date(movementYear, i, 1).toLocaleDateString("fr-FR", { month: "short" }));
  const recrPerMonth = new Array(12).fill(0);
  const departPerMonth = new Array(12).fill(0);
  const demissionPerMonth = new Array(12).fill(0);
  const retraitePerMonth = new Array(12).fill(0);
  const licenciementPerMonth = new Array(12).fill(0);
  rows.forEach((r) => {
    const start = excelDateToJs(r["DEB_CONTRAT"]);
    if (start && start.getFullYear() === movementYear) recrPerMonth[start.getMonth()] += 1;
    const dep = excelDateToJs(r["Date de départ"]);
    if (dep && dep.getFullYear() === movementYear) {
      departPerMonth[dep.getMonth()] += 1;
      const motif = String(r["Motif"] || "").toLowerCase();
      if (motif.includes("mission")) demissionPerMonth[dep.getMonth()] += 1;
      else if (motif.includes("retraite")) retraitePerMonth[dep.getMonth()] += 1;
      else if (motif.includes("licenci")) licenciementPerMonth[dep.getMonth()] += 1;
    }
  });
  let accRecr = 0, accDep = 0, accDem = 0, accRet = 0, accLic = 0;
  const hasMovementData = recrPerMonth.some((v) => v > 0) || departPerMonth.some((v) => v > 0);
  const movementsCumulative = hasMovementData
    ? monthShortLabels.map((label, i) => {
        accRecr += recrPerMonth[i];
        accDep += departPerMonth[i];
        accDem += demissionPerMonth[i];
        accRet += retraitePerMonth[i];
        accLic += licenciementPerMonth[i];
        return { label: `${label}-${String(movementYear).slice(2)}`, recrutement: accRecr, depart: accDep, demission: accDem, retraite: accRet, licenciement: accLic };
      })
    : null;

  const dist = {
    contrats: Object.entries(contratCount).map(([label, value]) => ({ label, value })),
    college: Object.entries(collegeCount).map(([label, value]) => ({ label, value })),
    genre: [{ label: "Hommes", value: genderCount.h }, { label: "Femmes", value: genderCount.f }],
    ageByGender,
    seniorityByGender,
    contractDeadline,
    contractDeadlineDays: deadlineDaysList,
    monthlyActivity,
    departureReasons,
    movementsCumulative,
  };

  // On ne recherche ces colonnes que si elles existent reellement dans le
  // classeur importe: si absentes, l'indicateur est marque "non disponible"
  // plutot que de fabriquer une valeur.
  const hsMatch = findNumericColumnAcrossSheets(workbook, ["forfait hs", "heures suppl", "heure suppl"]);
  const congeMatch = findNumericColumnAcrossSheets(workbook, ["conge", "solde cp", "jours conge"]);
  const entrepriseMatch = findNumericColumnAcrossSheets(workbook, ["sous-traitant", "sous traitant"]);

  const summary = {
    effectifTotal: total,
    effectifActif: active.length,
    cdi,
    anapec: nonCdi.length,
    turnover: active.length ? `${((departures / active.length) * 100).toFixed(1)}%` : "0%",
    recruitments: nonCdi.length,
    departures,
    ageAverage: ageN ? Math.round((ageSum / ageN) * 10) / 10 : 0,
    seniorityAverage: senN ? Math.round((senSum / senN) * 10) / 10 : 0,
    encadrement: total ? `${(((collegeCount["Cadre"] || 0) / total) * 100).toFixed(1)}%` : "0%",
    hs: hsMatch ? { total: hsMatch.values.reduce((a, b) => a + b, 0), count: hsMatch.values.filter((v) => v > 0).length, sheet: hsMatch.sheetName } : null,
    conges: congeMatch ? { total: congeMatch.values.reduce((a, b) => a + b, 0), sheet: congeMatch.sheetName } : null,
    effectifEntreprise: entrepriseMatch ? { total: entrepriseMatch.values.reduce((a, b) => a + b, 0), sheet: entrepriseMatch.sheetName } : null,
  };

  const collegeTotal = active.length || 1;
  const pct = (n) => `${((n / collegeTotal) * 100).toFixed(1)}%`;
  const cadreCount = collegeCount["Cadre"] || 0;
  const maitriseCount = collegeCount["Maitrise"] || collegeCount["Maîtrise"] || 0;
  const employeCount = collegeCount["Employé"] || collegeCount["Employe"] || 0;
  const contratAnapec = contratCount["ANAPEC"] || 0;
  const contratCdd = contratCount["CDD"] || 0;
  const totalContrats = summary.cdi + contratAnapec + contratCdd || 1;
  const pctContrat = (n) => `${((n / totalContrats) * 100).toFixed(1)}%`;

  // Cartes KPI regroupees par theme, organisees selon le croquis du
  // responsable RH: Effectif (avec turnover/licenciements/age/anciennete/genre/
  // retraites-cumulees/demissions-cumulees), Répartition du personnel,
  // État des départs (motifs), Contrats, Effectif E.E.
  // Le pourcentage est l'element principal (affiche en grand), le nombre
  // vient juste en dessous, puis le libelle de l'indicateur.
  // L'ordre du tableau pilote le placement dans la grille 3 colonnes
  // (.kpi-groups-grid): col.1 = Effectif (sur 2 lignes), col.2 = Répartition
  // puis Contrats, col.3 = État des départs (motifs) puis Effectif E.E.
  const lastMovement = movementsCumulative && movementsCumulative.length ? movementsCumulative[movementsCumulative.length - 1] : null;
  const kpiGroups = [
    { title: "Effectif", tag: "dataset réel", items: [
      { label: "Effectif actif", pct: pct(summary.effectifActif), value: summary.effectifActif, tone: "up" },
      { label: "Effectif total", value: summary.effectifTotal, tone: "info" },
      { label: "Turnover", pct: summary.turnover, value: `${summary.departures} départ(s)`, tone: summary.departures > 0 ? "warn" : "up" },
      { label: "Licenciements", pct: pct(licenciements), value: licenciements, tone: licenciements > 0 ? "warn" : "up" },
      ...(lastMovement ? [
        { label: "Retraites cumulées", value: lastMovement.retraite, tone: "info" },
        { label: "Démissions cumulées", value: lastMovement.demission, tone: "warn" },
      ] : []),
      { label: "Âge moyen", value: `${summary.ageAverage} ans`, tone: "info" },
      { label: "Ancienneté moyenne", value: `${summary.seniorityAverage} ans`, tone: "info" },
      { label: "Hommes", pct: pct(genderCount.h), value: genderCount.h, tone: "info" },
      { label: "Femmes", pct: pct(genderCount.f), value: genderCount.f, tone: "info" },
    ] },
    { title: "Répartition du personnel", tag: "par collège", items: [
      { label: "Cadres", pct: pct(cadreCount), value: cadreCount, tone: "info" },
      { label: "Maîtrise", pct: pct(maitriseCount), value: maitriseCount, tone: "info" },
      { label: "Employés", pct: pct(employeCount), value: employeCount, tone: "info" },
    ] },
    { title: "État des départs (motifs)", tag: "dataset réel — colonne \"Motif\"", type: "distribution", rows: departureReasons },
    { title: "Contrats", tag: "par type", items: [
      { label: "CDI", pct: pctContrat(summary.cdi), value: summary.cdi, tone: "up" },
      { label: "CDD", pct: pctContrat(contratCdd), value: contratCdd, tone: "warn" },
      { label: "ANAPEC", pct: pctContrat(contratAnapec), value: contratAnapec, tone: "warn" },
    ] },
    { title: "Effectif E.E", tag: "par entreprise", items: entrepriseMatch ? [
      { label: "Effectif entreprise", value: entrepriseMatch.values.reduce((a, b) => a + b, 0), tone: "info" },
    ] : [] },
  ];

  const sheets = workbook
    ? workbook.SheetNames.map((name) => {
        const grid = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null, header: 1 });
        const nonEmptyCells = grid.reduce((sum, r) => sum + r.filter((c) => c !== null && c !== "").length, 0);
        return { name, rows: Math.max(0, grid.length - 1), columns: grid[0] ? grid[0].length : 0, nonEmptyCells };
      })
    : [{ name: "EFFECTIF", rows: total, columns: 20, nonEmptyCells: total * 20 }];

  return {
    sourceFile: fileName,
    site: "SONASID Nador",
    period: new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" }),
    generatedFrom: "import manuel",
    sheets,
    summary,
    distributions: dist,
    kpiGroups,
    agents: [],
  };
}

async function importAnnualExcel(file) {
  if (!file) return;
  if (typeof XLSX === "undefined") {
    appState.importStatus = { state: "error", message: "Bibliothèque de lecture Excel indisponible." };
    rerenderKeepView();
    setView("import-data");
    return;
  }
  appState.importStatus = { state: "loading" };
  rerenderKeepView();
  setView("import-data");
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames.find((n) => n.toUpperCase().includes("EFFECTIF")) || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    if (!rows.length) throw new Error("Feuille EFFECTIF vide ou introuvable.");
    rawImportRows = rows;
    rawImportWorkbook = workbook;
    rawImportFileName = file.name;
    appState.dashboardFilters = { matricule: "", activite: "", dateFrom: "", dateTo: "" };
    realDataset = buildDatasetFromRows(rows, file.name, workbook);
    appState.importStatus = { state: "success", message: `${rows.length} lignes analysées depuis "${sheetName}".` };
    pushActivity(`Import annuel "${file.name}" traité: dashboard mis à jour`);
    toast("Fichier Excel importé, dashboard mis à jour.", "success");
  } catch (error) {
    appState.importStatus = { state: "error", message: error.message || "Fichier illisible." };
    toast(error.message || "Impossible d'importer ce fichier.");
  }
  rerenderKeepView();
  setView("dashboard");
}

function renderJobs() {
  const rows = jobs.filter((j) => {
    const statusOk = appState.jobFilter === "all" || j[7] === appState.jobFilter;
    const searchOk = !currentSearch || j.join(" ").toLowerCase().includes(currentSearch.toLowerCase());
    return statusOk && searchOk;
  });
  document.getElementById("jobs").innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Ajouter une offre RH</h2><span>creation</span></div>
      <form class="job-form" data-action="job-submit">
        <input name="title" placeholder="Intitulé du poste" required />
        <input name="department" placeholder="Département" required />
        <input name="owner" placeholder="Responsable RH" value="${session.user}" required />
        <select name="status"><option value="open">Ouverte</option><option value="paused">En pause</option></select>
        <label class="tag-field">Compétences requises${renderTagInput([])}${renderSkillSuggestions("")}</label>
        <button class="btn primary">Ajouter l'offre</button>
      </form>
    </section>
    <div class="page-actions"><input data-action="local-search" placeholder="Rechercher une offre" value="${currentSearch}" /><select data-action="job-status-filter"><option value="all">Tous statuts</option><option value="open">Ouvertes</option><option value="paused">En pause</option><option value="closed">Clôturées</option></select><button class="btn ghost" data-action="export-jobs-excel">Exporter les offres (Excel)</button></div>
    <div class="table-wrap"><table><thead><tr><th>Référence</th><th>Intitulé</th><th>Département</th><th>CV</th><th>Présélectionnés</th><th>Responsable</th><th>Ouverture</th><th>Statut</th><th>Compétences requises</th></tr></thead><tbody>${rows.map((j, idx) => `<tr><td>${j[0]}</td><td>${j[1]}</td><td>${j[2]}</td><td>${j[3]}</td><td>${j[4]}</td><td>${j[5]}</td><td>${j[6]}</td><td>${badge(j[7])}</td><td>${chips(j[8] || [])}<button class="link-btn" data-action="edit-skills" data-index="${jobs.indexOf(j)}">Modifier</button></td></tr>`).join("") || `<tr><td colspan="9">Aucune offre trouvée.</td></tr>`}</tbody></table></div>`;
  document.querySelector('[data-action="job-status-filter"]').value = appState.jobFilter;

  // Suggestions de competences mises a jour en direct selon l'intitule tape,
  // sans perdre le focus/texte du reste du formulaire.
  const titleInput = document.querySelector("#jobs .job-form input[name='title']");
  const tagField = document.querySelector("#jobs .job-form .tag-field");
  if (titleInput && tagField) {
    titleInput.addEventListener("input", () => {
      const box = tagField.querySelector(".tag-input");
      const current = box ? tagBoxSkills(box) : [];
      const existingSuggestions = tagField.querySelector(".skill-suggestions");
      const html = renderSkillSuggestions(titleInput.value, current);
      if (existingSuggestions) existingSuggestions.outerHTML = html;
      else if (html) tagField.insertAdjacentHTML("beforeend", html);
    });
  }
}

function renderCandidates() {
  const offers = [...new Set(candidates.map((c) => c[1]))];
  const rows = candidates.filter((c) => {
    const statusOk = appState.candidateStatusFilter === "all" || c[5] === appState.candidateStatusFilter;
    const offerOk = appState.candidateOfferFilter === "all" || c[1] === appState.candidateOfferFilter;
    const scoreOk = c[2] >= appState.minScore;
    const searchOk = !currentSearch || c.join(" ").toLowerCase().includes(currentSearch.toLowerCase());
    return statusOk && offerOk && scoreOk && searchOk;
  });
  document.getElementById("candidates").innerHTML = `<div class="page-actions"><input data-action="local-search" placeholder="Rechercher un candidat" value="${currentSearch}" /><select data-action="candidate-status-filter"><option value="all">Tous statuts</option><option value="received">Reçus</option><option value="under_review">En analyse</option><option value="requires_review">À vérifier</option><option value="shortlisted">Présélection</option><option value="interview">Entretien</option><option value="refused">Refusés</option></select><select data-action="candidate-offer-filter"><option value="all">Toutes offres</option>${offers.map((o) => `<option value="${o}">${o}</option>`).join("")}</select><select data-action="candidate-score-filter"><option value="0">Tous scores</option><option value="60">Score >= 60</option><option value="75">Score >= 75</option><option value="85">Score >= 85</option></select></div><div class="table-wrap"><table><thead><tr><th>Candidat</th><th>Offre</th><th>Score</th><th>Expérience</th><th>Compétences</th><th>Statut</th><th>Date</th><th>Actions</th></tr></thead><tbody>${rows.map((c) => { const originalIndex = candidates.indexOf(c); return `<tr><td><div class="person"><span>${initials(c[0])}</span><strong>${c[0]}</strong></div></td><td>${c[1]}</td><td><b class="score-badge">${c[2]}</b></td><td>${c[3]}</td><td>${chips(c[4])}</td><td>${badge(c[5])}</td><td>${c[6]}</td><td><button class="link-btn" data-open-detail data-index="${originalIndex}">Consulter</button></td></tr>`; }).join("") || `<tr><td colspan="8">Aucun candidat trouvé.</td></tr>`}</tbody></table></div>`;
  document.querySelector('[data-action="candidate-status-filter"]').value = appState.candidateStatusFilter;
  document.querySelector('[data-action="candidate-offer-filter"]').value = appState.candidateOfferFilter;
  document.querySelector('[data-action="candidate-score-filter"]').value = String(appState.minScore);
}

function renderCandidateDetail() {
  const c = candidates[selectedCandidateIndex] || candidates[0];
  const detected = c[4] || [];
  const cvMeta = c[8] || null;
  const analysis = computeScoreBreakdown(c);
  const matchedJob = analysis.job;
  const requiredSkills = analysis.requiredSkills;
  const missing = analysis.missing;
  const matched = analysis.matched;
  const hasRealExtraction = !!(cvMeta && (cvMeta.diploma || cvMeta.profileTitle || cvMeta.summary));

  byId("candidate-detail").innerHTML = `<div class="candidate-layout">
    <aside class="panel profile-card">
      <div class="person large"><span>${initials(c[0])}</span><div><h2>${c[0]}</h2><p>${c[1]}</p></div></div>
      <div class="profile-score"><strong class="big-score">${c[2]}</strong><span>/100</span></div>
      ${badge(c[5])}
      <dl class="profile-meta">
        <div><dt>Expérience</dt><dd>${c[3]}</dd></div>
        <div><dt>Diplôme détecté</dt><dd>${cvMeta?.diploma || "Non détecté"}</dd></div>
        <div><dt>Reçu le</dt><dd>${c[6]}</dd></div>
      </dl>
      <div class="actions"><button data-action="candidate-status" data-status="shortlisted">Présélectionner</button><button data-action="candidate-status" data-status="interview">Planifier entretien</button><button data-action="candidate-status" data-status="under_review">Mettre en attente</button><button data-action="candidate-status" data-status="refused">Refuser</button></div>
      <button class="cv-preview cv-preview-clickable" type="button" data-action="view-cv" data-index="${selectedCandidateIndex}"><strong>Fiche CV</strong><small>${c[7] ? "Cliquer pour ouvrir le fichier" : "Aucun fichier rattaché (candidat de démonstration)"}</small></button>
    </aside>

    <div class="candidate-main">
      <section class="panel">
        <div class="panel-head"><h2>Synthèse</h2><span>lecture IA</span></div>
        <p class="muted">Le profil présente une correspondance ${c[2] >= 75 ? "solide" : c[2] >= 55 ? "partielle" : "limitée"} avec l'offre ${c[1]}. ${missing.length ? `${missing.length} élément(s) restent à confirmer par le service RH avant décision finale.` : "Aucun écart majeur détecté par rapport au besoin."}</p>
        <div class="cv-insights"><article><strong>${c[2]}/100</strong><span>score global</span></article><article><strong>${detected.length}</strong><span>compétences détectées</span></article><article><strong>${missing.length}</strong><span>points à vérifier</span></article></div>
        ${hasRealExtraction ? `<div class="extraction-grid">
            <article><span>Profil identifié</span><strong>${cvMeta.profileTitle || "Non identifié"}</strong></article>
            <article><span>Taille du CV analysé</span><strong>${cvMeta.textLength ? `${cvMeta.textLength} caractères` : "Non disponible"}</strong></article>
          </div>
          ${cvMeta.summary ? `<div class="cv-summary"><span>Extrait du contenu détecté (début du CV)</span><p>${cvMeta.summary}</p></div>` : ""}` : `<p class="muted small-note">Candidat de démonstration — aucune extraction réelle de CV disponible.</p>`}
      </section>

      <section class="panel skills-panel">
        <div class="panel-head"><h2>Compétences</h2><span>CV vs offre ${matchedJob ? matchedJob[0] : ""}</span></div>
        <div class="skills-columns">
          <div><h3>Détectées sur le CV</h3>${chips(detected)}</div>
          <div><h3 class="ok">Adaptées au poste</h3>${matched.length ? chips(matched) : `<p class="muted">Aucune compétence requise retrouvée pour le moment.</p>`}</div>
          <div><h3 class="warn">Manquantes / à vérifier</h3>${missing.length ? chips(missing) : `<p class="muted">Aucun manque identifié.</p>`}</div>
        </div>
        ${requiredSkills.length ? `<div class="required-skills"><span>Compétences requises saisies par le RH pour ${matchedJob ? matchedJob[0] : c[1]}</span>${chips(requiredSkills)}</div>` : ""}
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Score détaillé — pourquoi ce score ?</h2><span>détails extraits du CV</span></div>
        ${analysis.rows.map((r) => `<div class="score-row"><span>${r.label}</span><div><i style="width:${r.ratio * 100}%"></i></div><strong>${r.value}</strong></div><p class="score-explain muted">${r.explain}</p>`).join("")}
      </section>

      <div class="candidate-side-by-side">
        <section class="panel"><h2>Recommandation RH</h2><p class="muted">Profil a conserver dans le processus. Un entretien est recommandé pour confirmer l'expérience réelle, la disponibilité et l'adéquation avec le besoin opérationnel.</p></section>
        <section class="panel"><h2>Historique</h2><div class="activity-list"><div><span></span>CV reçu</div><div><span></span>Analyse IA terminée</div><div><span></span>${statusLabels[c[5]] || c[5]}</div></div></section>
      </div>
    </div>
  </div>`;
}

function openCandidateCv(index) {
  const c = candidates[index];
  if (!c) return;
  const file = c[7];
  if (!file) {
    toast("Aucun fichier CV disponible pour ce candidat (donnée de démonstration).");
    return;
  }
  const url = URL.createObjectURL(file);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function renderPipeline() {
  const order = { received: 0, under_review: 1, requires_review: 2, shortlisted: 3, interview: 4, done: 5, refused: 6 };
  const rows = candidates.slice().sort((a, b) => (order[a[5]] ?? 9) - (order[b[5]] ?? 9));
  byId("pipeline").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Candidat</th><th>Offre</th><th>Score</th><th>Expérience</th><th>Compétences</th><th>Statut</th><th>Date</th><th>Actions</th></tr></thead><tbody>${rows.map((c) => { const originalIndex = candidates.indexOf(c); return `<tr><td><div class="person"><span>${initials(c[0])}</span><strong>${c[0]}</strong></div></td><td>${c[1]}</td><td><b class="score-badge">${c[2]}</b></td><td>${c[3]}</td><td>${chips(c[4])}</td><td>${badge(c[5])}</td><td>${c[6]}</td><td><button class="link-btn" data-open-detail data-index="${originalIndex}">Consulter</button></td></tr>`; }).join("") || `<tr><td colspan="8">Aucune candidature.</td></tr>`}</tbody></table></div>`;
}

function renderUpload() {
  const filesMarkup = appState.uploadFiles.length
    ? appState.uploadFiles.map(([f,s,score,error]) => `<div class="file-row"><strong>${f}</strong>${badge(s)}<div><i style="width:${s==='completed'?100:s==='processing'?62:s==='failed'?28:44}%"></i></div>${score !== undefined ? `<span class="file-score">Score ${score}</span>` : ""}${error ? `<small class="file-error">${error}</small>` : ""}</div>`).join("")
    : `<div class="empty-upload"><strong>Aucun CV déposé</strong><span>Le service RH sélectionne les fichiers candidats depuis son poste.</span></div>`;
  // La liste des offres est generee depuis le tableau "jobs" a chaque rendu,
  // pour que toute offre ajoutee dans la page "Offres" apparaisse
  // immediatement ici (auparavant la liste etait figee en HTML).
  const jobOptions = jobs.length
    ? jobs.map((j) => `<option value="${j[0]}">${j[0]} - ${j[1]} (${statusLabels[j[7]] || j[7]})</option>`).join("")
    : `<option value="">Aucune offre créée pour le moment</option>`;
  byId("upload").innerHTML = `<div class="upload-grid"><section class="panel"><h2>Dépôt des CV</h2><p class="muted">Espace réservé au service RH pour rattacher les CV reçus a une offre. Vous pouvez déposer plusieurs CV en une seule fois : chacun est ensuite analysé individuellement par l'agent d'analyse.</p><label>Offre associée<select id="uploadJobId">${jobOptions}</select></label><input id="cvFileInput" class="sr-only" type="file" accept=".pdf,.docx" multiple /><button class="dropzone" data-action="select-cv-files">Sélectionner un ou plusieurs CV<br><small>Formats acceptés: PDF, DOCX — dépôt multiple possible</small></button><div class="upload-actions"><button class="btn ghost" data-action="clear-errors">Retirer les fichiers en erreur</button><button class="btn primary" data-action="analyze-cv-files" ${appState.selectedFiles.length ? "" : "disabled"}>Analyser les CV (${appState.selectedFiles.length})</button></div></section><section class="panel wide"><div class="panel-head"><h2>CV déposés</h2><span>${appState.uploadFiles.length} fichier${appState.uploadFiles.length > 1 ? "s" : ""}</span></div>${filesMarkup}</section></div>`;
}

function computeScoreBreakdown(c) {
  const cvMeta = c[8] || null;
  const matchedJob = jobs.find((j) => j[1] === c[1]);
  const requiredSkills = (cvMeta?.requiredSkills?.length ? cvMeta.requiredSkills : matchedJob?.[8]) || [];
  const detected = c[4] || [];
  const detectedLower = detected.map((d) => d.toLowerCase());
  const matched = cvMeta?.adaptedSkills?.length ? cvMeta.adaptedSkills : requiredSkills.filter((s) => detectedLower.includes(s.toLowerCase()));
  const missing = cvMeta?.notAdaptedSkills?.length
    ? cvMeta.notAdaptedSkills
    : (requiredSkills.length
      ? requiredSkills.filter((s) => !matched.some((m) => m.toLowerCase() === s.toLowerCase()))
      : []);
  const extra = requiredSkills.length ? detected.filter((d) => !requiredSkills.some((s) => s.toLowerCase() === d.toLowerCase())) : [];
  const expYears = parseInt(c[3], 10) || 0;
  const skillsTotal = requiredSkills.length || detected.length || 1;
  const skillsMatchedCount = requiredSkills.length ? matched.length : detected.length;
  const skillsRatio = Math.min(1, skillsMatchedCount / skillsTotal);
  const expRatio = Math.min(1, expYears / 8);

  return {
    job: matchedJob,
    requiredSkills, detected, matched, missing, extra, expYears,
    rows: [
      {
        label: "Compétences requises détectées",
        ratio: skillsRatio,
        value: `${skillsMatchedCount}/${skillsTotal}`,
        explain: requiredSkills.length
          ? `${matched.length} sur ${requiredSkills.length} compétences requises pour "${c[1]}" retrouvées dans le CV${missing.length ? ` — manque: ${missing.join(", ")}` : ""}.`
          : `${detected.length} compétences détectées dans le CV (aucune compétence requise saisie pour cette offre pour le moment).`,
      },
      {
        label: "Expérience mentionnée sur le CV",
        ratio: expRatio,
        value: c[3],
        explain: `Le CV indique ${c[3]} d'expérience${matchedJob ? ` pour un poste de type "${c[1]}".` : "."}`,
      },
      {
        label: "Compétences complémentaires",
        ratio: extra.length ? Math.min(1, extra.length / 3) : (requiredSkills.length ? 0 : skillsRatio),
        value: `${extra.length || (requiredSkills.length ? 0 : detected.length)}`,
        explain: extra.length
          ? `Compétences supplémentaires hors liste requise détectées: ${extra.join(", ")}.`
          : (requiredSkills.length ? "Aucune compétence additionnelle détectée hors la liste requise." : `Compétences détectées: ${detected.join(", ") || "aucune"}.`),
      },
    ],
  };
}

function renderAI() {
  if (!candidates.length) { byId("ai").innerHTML = `<section class="panel"><p class="muted">Aucun candidat à analyser pour le moment.</p></section>`; return; }
  const idx = Math.min(selectedCandidateIndex, candidates.length - 1);
  const c = candidates[idx];
  const cvMeta = c[8] || null;
  const analysis = computeScoreBreakdown(c);
  const dup = cvMeta?.duplicateCheck;

  const duplicateBanner = dup?.is_duplicate
    ? `<div class="duplicate-banner"><strong>⚠ Profil déjà vu</strong><span>Ce CV ressemble fortement (${Math.round((dup.similarity || 0) * 100)}% de similarité) à un CV déjà traité${dup.matched_name ? ` : ${dup.matched_name}` : ""}${dup.matched_file ? ` (${dup.matched_file})` : ""}. Vérifiez qu'il ne s'agit pas d'un doublon avant de poursuivre le traitement.</span></div>`
    : "";

  const contactCard = `<section class="panel contact-card">
    <div class="panel-head"><h2>Coordonnées</h2><span>pour contacter le candidat</span></div>
    <div class="contact-grid">
      <a class="contact-item ${cvMeta?.email ? "" : "empty"}" href="${cvMeta?.email ? `mailto:${cvMeta.email}` : "#"}">
        <span>Email</span><strong>${cvMeta?.email || "Non détecté sur le CV"}</strong>
      </a>
      <a class="contact-item ${cvMeta?.phone ? "" : "empty"}" href="${cvMeta?.phone ? `tel:${cvMeta.phone.replace(/\s/g, "")}` : "#"}">
        <span>Téléphone</span><strong>${cvMeta?.phone || "Non détecté sur le CV"}</strong>
      </a>
    </div>
  </section>`;

  const experienceCard = `<section class="panel">
    <div class="panel-head"><h2>Expérience</h2><span>extraite du CV</span></div>
    <div class="experience-duration"><strong>${c[3]}</strong><span>durée totale mentionnée sur le CV</span></div>
    ${cvMeta?.experienceLines?.length
      ? `<ul class="experience-lines">${cvMeta.experienceLines.map((line) => `<li>${line}</li>`).join("")}</ul>`
      : `<p class="muted small-note">Aucune ligne de parcours (période / poste) détectée automatiquement — se référer au fichier CV original.</p>`}
  </section>`;

  const formationCard = `<section class="panel">
    <div class="panel-head"><h2>Formation & profil</h2><span>extraite du CV</span></div>
    <div class="extraction-grid">
      <article><span>Diplôme obtenu</span><strong>${cvMeta?.diploma || "Non détecté"}</strong></article>
      <article><span>Profil identifié</span><strong>${cvMeta?.profileTitle || c[1]}</strong></article>
    </div>
    ${cvMeta?.summary ? `<div class="cv-summary"><span>Début du CV (extrait brut)</span><p>${cvMeta.summary}</p></div>` : ""}
  </section>`;

  const skillsCard = `<section class="panel wide skills-panel">
    <div class="panel-head"><h2>Compétences</h2><span>pour la décision RH</span></div>
    <div class="skills-columns">
      <div><h3>Détectées sur le CV</h3>${chips(analysis.detected)}</div>
      <div><h3 class="ok">Adaptées au poste "${c[1]}"</h3>${analysis.matched.length ? chips(analysis.matched) : `<p class="muted">Aucune compétence requise retrouvée.</p>`}</div>
      <div><h3 class="warn">Manquantes / à vérifier en entretien</h3>${analysis.missing.length ? chips(analysis.missing) : `<p class="muted">Aucun manque identifié.</p>`}</div>
    </div>
  </section>`;

  byId("ai").innerHTML = `<div class="page-actions"><label class="ai-candidate-picker">Candidat analysé<select data-action="ai-candidate-select">${candidates.map((cand, i) => `<option value="${i}" ${i === idx ? "selected" : ""}>${cand[0]} — ${cand[1]}</option>`).join("")}</select></label></div>
  ${duplicateBanner}
  <div class="ai-grid">
    <section class="panel ai-score"><span>Score global</span><strong>${c[2]}</strong><p>${badge(c[5])}</p><small class="muted">${c[0]} — ${c[1]}</small></section>
    ${contactCard}
    ${formationCard}
    ${experienceCard}
    ${skillsCard}
  </div>`;
}

function renderChatbot() {
  const pendingBanner = appState.chatPending
    ? `<div class="chat-pending"><span>Action en attente de confirmation — répondez "oui" pour valider ou "non" pour annuler.</span></div>`
    : "";
  byId("chatbot").innerHTML = `<section class="panel chatbot-panel"><h2>Chatbot RH</h2><div class="chat-window">${appState.chat.map(([who, text]) => `<div class="chat ${who}">${String(text).replace(/\n/g, "<br>")}</div>`).join("")}</div>${pendingBanner}<form class="chat-form" data-action="chat-submit"><input name="message" placeholder="Ex: quel est le statut de Salma Bennani ?" autocomplete="off" /><button class="btn primary">Envoyer</button></form><div class="quick-prompts"><button data-action="chat-prompt" data-prompt="Quel est le turnover ?">Turnover</button><button data-action="chat-prompt" data-prompt="Combien d'effectifs actifs ?">Effectif</button><button data-action="chat-prompt" data-prompt="Suivre les candidatures">Candidatures</button><button data-action="chat-prompt" data-prompt="Entretiens prévus">Entretiens</button></div></section>`;
}


function renderInterviews() {
  const rows = interviews.filter((x) => appState.interviewFilter === "all" || x[6] === appState.interviewFilter);
  document.getElementById("interviews").innerHTML = `<div class="page-actions"><select data-action="interview-filter"><option value="all">Tous statuts</option><option value="planned">Planifies</option><option value="waiting">En attente</option><option value="done">Termines</option><option value="cancelled">Annules</option></select></div><div class="table-wrap"><table><thead><tr><th>Candidat</th><th>Poste</th><th>Date</th><th>Heure</th><th>Responsable</th><th>Statut</th><th>Score entretien</th><th>Commentaire</th><th>Actions</th></tr></thead><tbody>${rows.map((i) => `<tr><td>${i[1]}</td><td>${i[2]}</td><td>${i[3]}</td><td>${i[4]}</td><td>${i[5]}</td><td>${badge(i[6])}</td><td><input type="number" min="0" max="100" class="interview-score-input" id="score-${i[0]}" value="${i[7] ?? ""}" placeholder="/100" /></td><td><input type="text" class="interview-comment-input" id="comment-${i[0]}" value="${(i[8] || "").replace(/"/g, "&quot;")}" placeholder="Commentaire de l'entretien" /></td><td class="interview-actions"><button class="link-btn" data-action="interview-status" data-id="${i[0]}" data-status="planned">Confirmer</button><button class="link-btn" data-action="interview-status" data-id="${i[0]}" data-status="done">Terminer</button><button class="link-btn" data-action="interview-status" data-id="${i[0]}" data-status="cancelled">Annuler</button><button class="link-btn save-feedback" data-action="save-interview-feedback" data-id="${i[0]}">Enregistrer</button></td></tr>`).join("") || `<tr><td colspan="9">Aucun entretien.</td></tr>`}</tbody></table></div>`;
  document.querySelector('[data-action="interview-filter"]').value = appState.interviewFilter;
}

function saveInterviewFeedback(id) {
  const item = interviews.find((i) => i[0] === id);
  if (!item) return;
  const scoreInput = byId(`score-${id}`);
  const commentInput = byId(`comment-${id}`);
  const scoreValue = scoreInput?.value === "" ? null : Math.max(0, Math.min(100, Number(scoreInput.value)));
  item[7] = scoreValue;
  item[8] = commentInput?.value || "";
  pushActivity(`Entretien ${id} noté (${scoreValue ?? "-"}/100) par ${session.user}`);
  toast("Score et commentaire d'entretien enregistrés.", "success");
  rerenderKeepView();
  setView("interviews");
}

function renderReports() {
  document.getElementById("reports").innerHTML = `<div class="dashboard-grid"><section class="panel"><h2>Rapport recrutement</h2><p class="muted">Synthèse des offres, candidats et scores.</p><button class="btn primary" data-action="download-report" data-type="recruitment">Télécharger CSV</button></section><section class="panel"><h2>Rapport RH TDB</h2><p class="muted">Effectif, turnover, contrats et pyramides.</p><button class="btn primary" data-action="download-report" data-type="tdb">Télécharger CSV</button></section></div>`;
}

function renderNotifications() {
  document.getElementById("notifications").innerHTML = `<section class="panel"><div class="panel-head"><h2>Notifications</h2><button class="btn ghost" data-action="mark-notifications">Tout marquer comme lu</button></div><div class="activity-list">${notificationsData.map((x, index) => `<div class="${appState.notificationsRead.has(index) ? "done" : ""}"><span></span>${x}</div>`).join("")}</div></section>`;
}

function downloadReport(type) {
  const rows = type === "tdb" ? [["indicateur", "valeur"], ["effectif_actif", realDataset?.summary.effectifActif ?? "non disponible"], ["turnover", realDataset?.summary.turnover ?? "non disponible"], ["recrutements", realDataset?.summary.recruitments ?? "non disponible"]] : [["candidat", "offre", "score", "statut"], ...candidates.map((c) => [c[0], c[1], c[2], statusLabels[c[5]]])];
  const csv = rows.map((row) => row.join(";")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${type}_sonasid.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function simplePage(id, title, rows) { byId(id).innerHTML = `<section class="panel"><h2>${title}</h2><div class="activity-list">${rows.map((x) => `<div><span></span>${x}</div>`).join("")}</div></section>`; }

function renderAll() {
  renderDashboard();
  renderImportData();
  renderJobs();
  renderCandidates();
  renderCandidateDetail();
  renderPipeline();
  renderInterviews();
  renderUpload();
  renderAI();
  renderChatbot();
  renderReports();
  renderNotifications();
  simplePage("admin", "Administration", ["Gestion utilisateurs", "Rôles et permissions", "Paramètres scoring", "Collections MongoDB"]);
  simplePage("logs", "Logs", activities);
}
function rerenderKeepView() {
  const active = document.querySelector(".view.active")?.id || "dashboard";
  renderAll();
  applyRolePermissions();
  setView(active);
}

function createJob() {
  const id = `JOB-${String(40 + jobs.length).padStart(3, "0")}`;
  jobs.unshift([id, "Controleur gestion RH", "RH", 0, 0, session.user, "20/07/2026", "open"]);
  pushActivity(`${id} creee par ${session.user}`);
  toast(`${id} ajoutee. Tu peux la voir dans Offres.`, "success");
  rerenderKeepView();
  setView("jobs");
}

function candidateNameFromFile(fileName) {
  return fileName
    .replace(/\.(pdf|docx?)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bcv\b/gi, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Candidat";
}

function importSelectedCv(files) {
  const selected = Array.from(files || []).filter((file) => /\.(pdf|docx?)$/i.test(file.name));
  if (!selected.length) {
    toast("Sélectionnez un ou plusieurs CV au format PDF ou DOCX.");
    return;
  }
  appState.selectedFiles = [...appState.selectedFiles, ...selected];
  appState.uploadFiles = appState.selectedFiles.map((file) => [file.name, "ready"]);
  pushActivity(`${selected.length} CV sélectionné(s) par le service RH`);
  toast(`${selected.length} CV sélectionné(s). Chaque fichier sera analysé individuellement.`, "success");
  rerenderKeepView();
  setView("upload");
}

async function runAgents(agentId = null) {
  const active = document.querySelector(".view.active")?.id || "agents";
  appState.agentLastRun = "execution backend en cours";
  appState.agentProgress = 15;
  (realDataset?.agents || []).forEach((agent) => {
    if (!agentId || agent.id === agentId) appState.agentStatus[agent.id] = "running";
  });
  rerenderKeepView();
  setView(active === "upload" ? "agents" : active);

  try {
    const response = await fetch("/api/v1/agents/run", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(agentId ? { agent_id: agentId } : {}),
    });
    if (response.status === 401) {
      forceReauth("Votre session a expiré. Reconnectez-vous puis relancez les agents.");
      throw new Error("Session expirée : reconnectez-vous puis relancez les agents.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Erreur backend agents.");
    (result.agents || []).forEach((agent) => { appState.agentStatus[agent.id] = agent.status; });
    appState.agentProgress = 100;
    appState.agentLastRun = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    pushActivity(`${result.agents?.length || 0} agent(s) exécuté(s) côté backend`);
    toast("Agents exécutés côté backend FastAPI.", "success");
  } catch (error) {
    appState.agentProgress = 0;
    toast(error.message || "Impossible de lancer les agents backend.");
  }
  rerenderKeepView();
  setView(active === "upload" ? "agents" : active);
}

function buildCvAnalysisFormData() {
  const formData = new FormData();
  appState.selectedFiles.forEach((file) => formData.append("files", file));
  formData.append("job_id", byId("uploadJobId")?.value || "JOB-024");
  return formData;
}

async function postCvAnalysis() {
  const urls = [
    "/api/v1/rh/cv/analyze",
    "/rh/cv/analyze",
    "http://127.0.0.1:8010/api/v1/rh/cv/analyze",
    "http://127.0.0.1:8010/rh/cv/analyze",
    "http://127.0.0.1:8011/api/v1/rh/cv/analyze",
    "http://127.0.0.1:8011/rh/cv/analyze",
    "http://127.0.0.1:8012/api/v1/rh/cv/analyze",
    "http://127.0.0.1:8012/rh/cv/analyze",
  ];
  const errors = [];

  for (const url of urls) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: buildCvAnalysisFormData(),
      });
    } catch (error) {
      errors.push(`${url} -> ${error.message}`);
      continue;
    }
    if (response.status === 401) {
      forceReauth("Votre session a expiré pendant l'analyse des CV. Reconnectez-vous puis relancez l'analyse.");
      throw new Error("SESSION_EXPIRED");
    }
    let result = {};
    try { result = await response.json(); } catch { result = { detail: response.statusText }; }
    if (response.ok) return result;
    errors.push(`${url} -> ${response.status} ${result.detail || response.statusText}`);
  }

  throw new Error(errors.join(" | "));
}

async function analyzeUploadedCvs() {
  if (!appState.selectedFiles.length) {
    toast("Sélectionnez d’abord les CV a analyser.");
    return;
  }
  appState.uploadFiles = appState.uploadFiles.map(([name]) => [name, "processing"]);
  appState.agentLastRun = "analyse CV backend en cours";
  appState.agentProgress = 25;
  rerenderKeepView();
  setView("upload");

  try {
    const result = await postCvAnalysis();
    const filesSnapshot = appState.selectedFiles.slice();
    appState.uploadFiles = (result.files || []).map((file) => [file.file_name, file.status, file.score, file.error || file.warning]);
    appState.agentProgress = 100;
    appState.agentLastRun = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    appState.selectedFiles = [];
    const targetJobId = byId("uploadJobId")?.value || "JOB-024";
    const targetJob = jobs.find((j) => j[0] === targetJobId);
    (result.files || []).filter((file) => file.status === "completed").forEach((file) => {
      const cvFileRef = filesSnapshot.find((f) => f.name === file.file_name) || null;
      const profile = file.profile || {};
      const detectedSkills = file.matched_skills?.length ? file.matched_skills : (profile.skills?.length ? profile.skills : ["Aucune compétence détectée"]);
      const experienceLabel = profile.experience_years ? `${profile.experience_years} an${profile.experience_years > 1 ? "s" : ""}` : "Non détectée sur le CV";
      candidates.unshift([
        profile.name || candidateNameFromFile(file.file_name),
        targetJob ? targetJob[1] : (profile.profile || "Poste non précisé"),
        Math.round(file.score || 0),
        experienceLabel,
        detectedSkills,
        "under_review",
        new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
        cvFileRef,
        {
          diploma: profile.diploma || null,
          profileTitle: profile.profile || null,
          summary: profile.summary || null,
          textLength: profile.text_length || 0,
          adaptedSkills: file.adapted_skills || [],
          notAdaptedSkills: file.not_adapted_skills || [],
          requiredSkills: file.required_skills || [],
          email: profile.email || null,
          phone: profile.phone || null,
          experienceLines: profile.experience_lines || [],
          duplicateCheck: file.duplicate_check || null,
        },
      ]);
    });
    pushActivity(`${result.files?.length || 0} CV analyse(s) côté backend, chacun traité individuellement`);
    toast(`${result.files?.length || 0} CV analysé(s) par le backend RH.`, "success");
  } catch (error) {
    const message = error.message === "SESSION_EXPIRED"
      ? "Session expirée : reconnectez-vous puis relancez l'analyse des CV."
      : (error.message || "Impossible d’analyser les CV.");
    appState.uploadFiles = appState.uploadFiles.map(([name]) => [name, "failed", undefined, message]);
    toast(message);
    if (error.message === "SESSION_EXPIRED") { rerenderKeepView(); return; }
  }
  rerenderKeepView();
  setView("upload");
}
function normalizeForMatch(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Recherche floue par nom: accepte un nom complet ou partiel ("hamza", "rami", "hamza rami").
function findCandidateByName(query) {
  const needle = normalizeForMatch(query).trim();
  if (!needle) return null;
  let best = null;
  candidates.forEach((c, index) => {
    const name = normalizeForMatch(c[0]);
    if (name === needle || name.includes(needle) || needle.includes(name)) {
      if (!best) best = { candidate: c, index };
    } else {
      const tokens = needle.split(/\s+/).filter(Boolean);
      if (tokens.length && tokens.every((t) => name.includes(t))) best = best || { candidate: c, index };
    }
  });
  return best;
}

function findJobByRef(query) {
  const match = String(query).toUpperCase().match(/JOB-\d+/);
  if (match) return jobs.find((j) => j[0] === match[0]) || null;
  return null;
}

const CANDIDATE_STATUS_ACTIONS = {
  "presel": "shortlisted", "présél": "shortlisted", "shortlist": "shortlisted",
  "refus": "refused",
  "entretien": "interview", "planifie": "interview", "planifi": "interview",
  "attente": "under_review", "revoir": "under_review",
};

function detectLocalModification(lowered, rawMessage) {
  for (const [keyword, status] of Object.entries(CANDIDATE_STATUS_ACTIONS)) {
    if (lowered.includes(keyword)) {
      const nameGuess = rawMessage.replace(/[a-zà-ÿ'’-]*(preselectionne|présélectionne|refuse|planifie|entretien|mets?|en|attente|le|la|statut|de|candidat|candidate|pour)/gi, " ");
      const found = findCandidateByName(nameGuess) || candidates.map((c, i) => ({ candidate: c, index: i })).find((entry) => lowered.includes(normalizeForMatch(entry.candidate[0])));
      if (found) return { type: "candidate-status", index: found.index, status, label: `${found.candidate[0]} -> ${statusLabels[status]}` };
    }
  }
  const jobStatusMatch = lowered.match(/(job-\d+).*(ouvre|ouverte|pause|suspend|cloture|ferme)/);
  if (jobStatusMatch) {
    const job = findJobByRef(jobStatusMatch[1]);
    const word = jobStatusMatch[2];
    const status = word.startsWith("ouvr") ? "open" : word.startsWith("pause") || word.startsWith("suspend") ? "paused" : "closed";
    if (job) return { type: "job-status", jobRef: job[0], status, label: `${job[0]} -> ${statusLabels[status]}` };
  }
  return null;
}

function applyLocalModification(action) {
  if (action.type === "candidate-status") {
    const c = candidates[action.index];
    if (!c) return "Ce candidat n'existe plus.";
    c[5] = action.status;
    if (action.status === "interview") interviews.unshift([`INT-${Date.now()}`, c[0], c[1], new Date().toLocaleDateString("fr-FR"), "10:00", session.user, "planned"]);
    pushActivity(`Chatbot RH: ${c[0]} -> ${statusLabels[c[5]]} (confirmé par ${session.user})`);
    return `Statut mis à jour: ${c[0]} est maintenant "${statusLabels[c[5]]}".`;
  }
  if (action.type === "job-status") {
    const job = jobs.find((j) => j[0] === action.jobRef);
    if (!job) return "Cette offre n'existe plus.";
    job[7] = action.status;
    pushActivity(`Chatbot RH: ${job[0]} -> ${statusLabels[job[7]]} (confirmé par ${session.user})`);
    return `Offre mise à jour: ${job[0]} est maintenant "${statusLabels[job[7]]}".`;
  }
  return "Action inconnue.";
}

function answerChatLocal(rawMessage) {
  const lowered = normalizeForMatch(rawMessage);
  const s = realDataset?.summary;

  // Indicateurs globaux du dataset TDB
  if (lowered.includes("turnover")) return s ? `Le turnover du dataset TDB est ${s.turnover}.` : `Aucun fichier Excel importé pour le moment : importez le TDB annuel (menu "Import annuel") pour connaître le turnover.`;
  if (lowered.includes("effectif")) return s ? `L'effectif actif est ${s.effectifActif} sur ${s.effectifTotal} lignes.` : `Aucun fichier Excel importé pour le moment : importez le TDB annuel pour connaître l'effectif.`;
  if (lowered.includes("recrut")) return s ? `Le TDB indique ${s.recruitments} recrutements sur la période.` : `Aucun fichier Excel importé pour le moment : importez le TDB annuel pour ce chiffre.`;
  if (lowered.includes("depart")) return s ? `Le TDB indique ${s.departures} départs.` : `Aucun fichier Excel importé pour le moment : importez le TDB annuel pour ce chiffre.`;
  if (lowered.includes("conge")) return `Les données de congés proviennent du module RH; branchez la collection "conges" pour un chiffre exact ici.`;
  if (lowered.includes("heure") && lowered.includes("suppl")) return `Les heures supplémentaires proviennent du TDB; utilisez "Import annuel" pour les recalculer.`;

  // Une offre precise
  const job = findJobByRef(rawMessage);
  if (job) return `L'offre ${job[0]} (${job[1]}) est au statut "${statusLabels[job[7]]}", ${job[3]} CV reçus, ${job[4]} présélectionnés.`;

  // Vue d'ensemble des candidatures / pipeline
  if (lowered.includes("suivre les candidat") || lowered.includes("candidatures") || lowered.includes("pipeline")) {
    if (!candidates.length) return "Aucune candidature enregistrée pour le moment.";
    const counts = {};
    candidates.forEach((c) => { counts[c[5]] = (counts[c[5]] || 0) + 1; });
    const parts = Object.entries(counts).map(([status, n]) => `${n} ${statusLabels[status] || status}`).join(", ");
    return `${candidates.length} candidature(s) au total : ${parts}.`;
  }

  // Entretiens
  if (lowered.includes("entretien")) {
    if (!interviews.length) return "Aucun entretien planifié pour le moment.";
    const upcoming = interviews.filter((i) => i[6] === "planned").slice(0, 3);
    if (!upcoming.length) return "Aucun entretien en attente de confirmation actuellement.";
    return `Entretiens à venir : ${upcoming.map((i) => `${i[1]} (${i[2]}) le ${i[3]} à ${i[4]}`).join("; ")}.`;
  }

  // Statut / recherche d'un candidat par nom
  const found = findCandidateByName(rawMessage);
  if (found) {
    const c = found.candidate;
    return `${c[0]} — offre "${c[1]}", score ${c[2]}/100, statut actuel "${statusLabels[c[5]]}", reçu le ${c[6]}.`;
  }

  // Rien de reconnu localement — verifie si un nom de candidat est cite mais introuvable
  const looksLikeName = /^[a-zà-ÿ]+(\s+[a-zà-ÿ]+){0,2}$/i.test(rawMessage.trim());
  if (looksLikeName) return `Je ne trouve aucun candidat correspondant à "${rawMessage.trim()}" dans les candidatures actuelles.`;

  return null;
}

async function answerChatBackend(rawMessage) {
  if (!session.token) return null;
  try {
    const response = await fetch("/api/v1/chatbot/message", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message: rawMessage, context: appState.chatContext || {} }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.context) appState.chatContext = data.context;
    if (data.requires_confirmation && data.action_preview) {
      appState.chatPending = { type: "backend", action: data.action_preview };
    }
    return data.answer;
  } catch {
    return null;
  }
}

async function submitChat(message) {
  const clean = message.trim();
  if (!clean) return;
  appState.chat.push(["user", clean]);
  rerenderKeepView();
  setView("chatbot");

  const lowered = normalizeForMatch(clean);
  const isConfirm = /^(oui|confirme|confirmer|ok|valide)$/.test(lowered);
  const isCancel = /^(non|annule|annuler|stop)$/.test(lowered);

  if (appState.chatPending) {
    if (isConfirm) {
      const pending = appState.chatPending;
      appState.chatPending = null;
      let reply;
      if (pending.type === "backend") {
        try {
          const response = await fetch("/api/v1/chatbot/confirm", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ action_preview: pending.action, context: appState.chatContext || {} }),
          });
          const data = await response.json();
          if (data.context) appState.chatContext = data.context;
          reply = response.ok ? data.answer : (data.detail || "Confirmation impossible côté serveur.");
        } catch {
          reply = "Confirmation impossible: le backend RH n'a pas répondu.";
        }
      } else {
        reply = applyLocalModification(pending);
      }
      appState.chat.push(["bot", reply]);
      pushActivity(`Chatbot RH: action confirmée par ${session.user}`);
      rerenderKeepView();
      setView("chatbot");
      return;
    }
    if (isCancel) {
      appState.chatPending = null;
      appState.chat.push(["bot", "Action annulée, aucune modification effectuée."]);
      rerenderKeepView();
      setView("chatbot");
      return;
    }
    appState.chat.push(["bot", "Une action est en attente de confirmation : répondez \"oui\" pour valider ou \"non\" pour annuler."]);
    rerenderKeepView();
    setView("chatbot");
    return;
  }

  // Toute demande de modification doit être confirmée explicitement avant d'être appliquée.
  const localModification = detectLocalModification(lowered, clean);
  if (localModification) {
    appState.chatPending = localModification;
    appState.chat.push(["bot", `Vous voulez : ${localModification.label}. Confirmez-vous (oui/non) ?`]);
    rerenderKeepView();
    setView("chatbot");
    return;
  }

  const localAnswer = answerChatLocal(clean);
  const reply = localAnswer || (await answerChatBackend(clean)) || "Je peux répondre sur le turnover, l'effectif, le recrutement, les départs, un candidat par son nom, une offre (ex: JOB-024), les entretiens ou les candidatures.";
  appState.chat.push(["bot", reply]);
  pushActivity(`Question chatbot RH: ${clean}`);
  rerenderKeepView();
  setView("chatbot");
}


function parseSkillsInput(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function tagPillHtml(skill) {
  return `<span class="tag-pill">${skill}<button type="button" class="tag-remove" data-skill="${skill}">×</button></span>`;
}

// Suggestions de competences par intitule de poste (aleatoires/indicatives)
// pour aider le RH a remplir vite - restent entierement modifiables/ajoutables.
const SKILL_SUGGESTIONS = {
  "data analyst": ["Python", "SQL", "Power BI", "Excel avancé", "Statistiques"],
  "data": ["Python", "SQL", "Power BI", "Pandas", "Machine Learning"],
  "ia": ["Python", "Machine Learning", "REST API", "Data Engineering", "SQL"],
  "ai": ["Python", "Machine Learning", "REST API", "Data Engineering", "SQL"],
  "maintenance": ["Maintenance préventive", "Sécurité industrielle", "Électromécanique", "GMAO", "Lecture de plans"],
  "technicien": ["Maintenance préventive", "Sécurité industrielle", "Électromécanique", "Habilitation électrique"],
  "formation": ["Ingénierie pédagogique", "Gestion budget formation", "Animation de groupe", "LMS"],
  "qualité": ["ISO 9001", "Audit interne", "Amélioration continue", "Contrôle qualité"],
  "qualite": ["ISO 9001", "Audit interne", "Amélioration continue", "Contrôle qualité"],
  "rh": ["Gestion administrative RH", "SIRH", "Droit du travail", "Recrutement"],
  "recrut": ["Sourcing", "Entretien candidat", "SIRH", "Marque employeur"],
  "commercial": ["Négociation", "CRM", "Prospection", "Relation client"],
  "logistique": ["Gestion de stock", "SAP", "Supply Chain", "Excel avancé"],
  "production": ["Lean manufacturing", "5S", "Sécurité industrielle", "Amélioration continue"],
  "finance": ["Comptabilité générale", "Excel avancé", "Contrôle de gestion", "SAP"],
  "comptab": ["Comptabilité générale", "Fiscalité", "Excel avancé", "SAP"],
};
const DEFAULT_SKILL_SUGGESTIONS = ["Communication", "Travail d'équipe", "Excel avancé", "Rigueur", "Gestion de projet"];

function suggestSkillsForTitle(title, exclude = []) {
  const lowered = normalizeForMatch(title);
  const excludeLower = exclude.map((s) => normalizeForMatch(s));
  let pool = DEFAULT_SKILL_SUGGESTIONS;
  for (const [keyword, skills] of Object.entries(SKILL_SUGGESTIONS)) {
    if (lowered.includes(keyword)) { pool = skills; break; }
  }
  return pool.filter((s) => !excludeLower.includes(normalizeForMatch(s))).slice(0, 5);
}

function renderSkillSuggestions(title, exclude = []) {
  const suggestions = suggestSkillsForTitle(title, exclude);
  if (!suggestions.length) return "";
  return `<div class="skill-suggestions"><span>Suggestions</span>${suggestions.map((s) => `<button type="button" class="suggestion-chip" data-action="add-suggested-skill" data-skill="${s}">+ ${s}</button>`).join("")}</div>`;
}

function findColumnValue(row, keywords) {
  const key = Object.keys(row).find((k) => keywords.some((kw) => normalizeForMatch(k).includes(kw)));
  return key ? row[key] : null;
}

// Exporte la liste des offres actuellement affichee (recherche + filtre de
// statut appliques) vers un fichier Excel .xlsx, avec les memes colonnes que
// le tableau a l'ecran.
function exportJobsToExcel() {
  if (typeof XLSX === "undefined") { toast("La librairie Excel n'est pas chargée."); return; }
  const rows = jobs.filter((j) => {
    const statusOk = appState.jobFilter === "all" || j[7] === appState.jobFilter;
    const searchOk = !currentSearch || j.join(" ").toLowerCase().includes(currentSearch.toLowerCase());
    return statusOk && searchOk;
  });
  if (!rows.length) { toast("Aucune offre à exporter avec ces filtres."); return; }
  const header = ["Référence", "Intitulé", "Département", "Nombre de CV", "Pré-sélectionnés", "Responsable", "Date d'ouverture", "Statut", "Compétences requises"];
  const data = rows.map((j) => [j[0], j[1], j[2], j[3], j[4], j[5], j[6], statusLabels[j[7]] || j[7], (j[8] || []).join(", ")]);
  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  sheet["!cols"] = [{ wch: 12 }, { wch: 28 }, { wch: 16 }, { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 36 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Offres");
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `offres_sonasid_${stamp}.xlsx`);
  pushActivity(`${rows.length} offre(s) exportée(s) vers Excel par ${session.user}`);
  toast(`${rows.length} offre(s) exportée(s).`, "success");
}

function renderTagInput(initialSkills, hiddenName = "skills") {
  const skills = initialSkills || [];
  return `<div class="tag-input">
    <div class="tag-list">${skills.map(tagPillHtml).join("")}</div>
    <input type="text" class="tag-text" placeholder="Ajouter une compétence puis Entrée" autocomplete="off" />
    <input type="hidden" name="${hiddenName}" value="${skills.join(",")}" />
    <span class="tag-hint">Appuyez sur Entrée (ou virgule) après chaque compétence pour l'ajouter — elle apparaîtra ici sous forme de pastille.</span>
  </div>`;
}

function tagBoxSkills(box) {
  const hidden = box.querySelector('input[type="hidden"]');
  return hidden.value ? hidden.value.split(",").filter(Boolean) : [];
}

function addSkillToBox(box, rawSkill) {
  const clean = String(rawSkill || "").trim();
  if (!clean) return;
  const current = tagBoxSkills(box);
  if (current.some((s) => s.toLowerCase() === clean.toLowerCase())) return;
  const next = [...current, clean];
  box.querySelector('input[type="hidden"]').value = next.join(",");
  box.querySelector(".tag-list").insertAdjacentHTML("beforeend", tagPillHtml(clean));
}

function removeSkillFromBox(box, skill) {
  const next = tagBoxSkills(box).filter((s) => s !== skill);
  box.querySelector('input[type="hidden"]').value = next.join(",");
  const list = box.querySelector(".tag-list");
  [...list.children].find((el) => el.querySelector(".tag-remove")?.dataset.skill === skill)?.remove();
}

// Si l'utilisateur a tape une competence mais a clique sur "Enregistrer"
// sans appuyer sur Entree, le texte restait dans le champ et etait perdu
// (le bouton semblait ne rien faire). On valide ce texte en attente avant
// toute lecture/sauvegarde des competences.
function flushPendingTagInput(scope) {
  if (!scope) return;
  scope.querySelectorAll(".tag-input").forEach((box) => {
    const textInput = box.querySelector(".tag-text");
    if (textInput && textInput.value.trim()) {
      addSkillToBox(box, textInput.value.replace(/,/g, ""));
      textInput.value = "";
    }
  });
}

function addJob(form) {
  flushPendingTagInput(form);
  const data = new FormData(form);
  const id = `JOB-${String(40 + jobs.length).padStart(3, "0")}`;
  jobs.unshift([id, data.get("title"), data.get("department"), 0, 0, data.get("owner"), new Date().toLocaleDateString("fr-FR"), data.get("status"), parseSkillsInput(data.get("skills"))]);
  pushActivity(`${id} ajoutee par ${session.user}`);
  toast(`${id} ajoutee dans Offres avec ses compétences requises.`, "success");
  rerenderKeepView();
  setView("jobs");
}

function openEditSkillsModal(index) {
  const job = jobs[index];
  if (!job) return;
  byId("modalHost").innerHTML = `
    <div class="modal-backdrop" data-action="close-edit-skills"></div>
    <div class="modal-card">
      <h2>Compétences requises</h2>
      <p class="muted">${job[1]} — ${job[0]}</p>
      <label class="tag-field">${renderTagInput(job[8] || [], "editSkills")}${renderSkillSuggestions(job[1], job[8] || [])}</label>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-action="close-edit-skills">Annuler</button>
        <button class="btn primary" type="button" data-action="save-edit-skills" data-index="${index}">Enregistrer</button>
      </div>
    </div>`;
  byId("modalHost").classList.remove("is-hidden");
  byId("modalHost").querySelector(".tag-text")?.focus();
}

function closeEditSkillsModal() {
  const host = byId("modalHost");
  host.classList.add("is-hidden");
  host.innerHTML = "";
}

function saveEditSkillsModal(index) {
  flushPendingTagInput(byId("modalHost"));
  const hidden = byId("modalHost").querySelector('input[name="editSkills"]');
  const job = jobs[index];
  if (!job) { closeEditSkillsModal(); return; }
  job[8] = parseSkillsInput(hidden?.value || "");
  pushActivity(`Compétences requises mises à jour pour ${job[0]}`);
  toast(`Compétences requises mises à jour pour ${job[1]}.`, "success");
  closeEditSkillsModal();
  rerenderKeepView();
  setView("jobs");
}

async function performLogin(username, password) {
  const errorEl = byId("loginError");
  const submitBtn = byId("loginSubmitBtn");
  errorEl.classList.add("is-hidden");
  submitBtn.disabled = true;
  submitBtn.textContent = "Connexion...";
  try {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Identifiant ou mot de passe incorrect.");
    session.user = data.username;
    session.role = data.role;
    session.token = data.access_token;
    session.displayName = data.display_name || roleLabels[data.role] || data.username;
    localStorage.setItem("sonasid_rh_token", JSON.stringify({ token: data.access_token, user: data.username, role: data.role, displayName: session.displayName }));
    document.body.classList.add("is-authenticated");
    applyRolePermissions();
    toast(`Connecté comme ${session.displayName}`, "success");
  } catch (error) {
    errorEl.textContent = error.message || "Connexion impossible. Vérifiez le service RH backend.";
    errorEl.classList.remove("is-hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Se connecter";
  }
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem("sonasid_rh_token") || "null");
    if (saved?.token) {
      session.token = saved.token;
      session.user = saved.user;
      session.role = saved.role;
      session.displayName = saved.displayName;
      document.body.classList.add("is-authenticated");
      applyRolePermissions();
    }
  } catch { /* pas de session sauvegardee valide */ }
}

byId("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  performLogin(byId("loginUser").value.trim(), byId("loginPassword").value);
});
byId("logoutBtn").addEventListener("click", () => {
  document.body.classList.remove("is-authenticated");
  session.token = null;
  localStorage.removeItem("sonasid_rh_token");
});
document.querySelectorAll(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));

byId("globalSearch")?.addEventListener("input", (e) => {
  currentSearch = e.target.value.trim();
  const active = document.querySelector(".view.active")?.id;
  if (active === "jobs" || active === "candidates") rerenderKeepView();
});
byId("globalSearch")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const q = currentSearch.toLowerCase();
    const hasCandidate = candidates.some((c) => c.join(" ").toLowerCase().includes(q));
    setView(hasCandidate ? "candidates" : "jobs");
    rerenderKeepView();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.matches('[data-action="job-submit"]')) { e.preventDefault(); addJob(e.target); }
  if (e.target.matches('[data-action="chat-submit"]')) {
    e.preventDefault();
    submitChat(new FormData(e.target).get("message") || "");
  }
});

document.addEventListener("input", (e) => {
  if (e.target.matches('[data-action="local-search"]')) {
    currentSearch = e.target.value.trim();
    const global = byId("globalSearch");
    if (global) global.value = currentSearch;
    rerenderKeepView();
  }
  if (e.target.matches('[data-action="filter-matricule"]')) {
    appState.dashboardFilters.matricule = e.target.value;
    withFocusPreserved("filter-matricule", applyDashboardFilters);
  }
  if (e.target.matches('[data-action="filter-activite"]')) {
    appState.dashboardFilters.activite = e.target.value;
    withFocusPreserved("filter-activite", applyDashboardFilters);
  }
  if (e.target.matches('[data-action="filter-date-from"]')) {
    appState.dashboardFilters.dateFrom = e.target.value;
    applyDashboardFilters();
  }
  if (e.target.matches('[data-action="filter-date-to"]')) {
    appState.dashboardFilters.dateTo = e.target.value;
    applyDashboardFilters();
  }
  if (e.target.matches('[data-action="deadline-threshold"]')) {
    appState.deadlineThresholdDays = Math.max(0, Number(e.target.value) || 0);
    withFocusPreserved("deadline-threshold", renderDashboard);
  }
});


document.addEventListener("change", (e) => {
  if (e.target.matches("#cvFileInput")) { importSelectedCv(e.target.files); e.target.value = ""; }
  if (e.target.matches("#importExcelInput")) { importAnnualExcel(e.target.files?.[0]); e.target.value = ""; }
  if (e.target.matches('[data-action="job-status-filter"]')) { appState.jobFilter = e.target.value; rerenderKeepView(); setView("jobs"); }
  if (e.target.matches('[data-action="candidate-status-filter"]')) { appState.candidateStatusFilter = e.target.value; rerenderKeepView(); setView("candidates"); }
  if (e.target.matches('[data-action="candidate-offer-filter"]')) { appState.candidateOfferFilter = e.target.value; rerenderKeepView(); setView("candidates"); }
  if (e.target.matches('[data-action="candidate-score-filter"]')) { appState.minScore = Number(e.target.value); rerenderKeepView(); setView("candidates"); }
  if (e.target.matches('[data-action="interview-filter"]')) { appState.interviewFilter = e.target.value; rerenderKeepView(); setView("interviews"); }
  if (e.target.matches('[data-action="ai-candidate-select"]')) { selectedCandidateIndex = Number(e.target.value); renderAI(); }
});

document.addEventListener("keydown", (e) => {
  if (!e.target.matches(".tag-text")) return;
  const box = e.target.closest(".tag-input");
  if (!box) return;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addSkillToBox(box, e.target.value.replace(/,/g, ""));
    e.target.value = "";
  } else if (e.key === "Backspace" && !e.target.value) {
    const current = tagBoxSkills(box);
    if (current.length) removeSkillFromBox(box, current[current.length - 1]);
  }
});

document.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".tag-remove");
  if (removeBtn) {
    const box = removeBtn.closest(".tag-input");
    if (box) removeSkillFromBox(box, removeBtn.dataset.skill);
    return;
  }
  const actionEl = e.target.closest("[data-action], [data-open-detail]");
  if (!actionEl) return;
  if (actionEl.matches("[data-open-detail]")) {
    selectedCandidateIndex = Number(actionEl.dataset.index || 0);
    setView("candidate-detail");
    return;
  }
  const action = actionEl.dataset.action;
  if (action === "go-upload") setView("upload");
  if (action === "go-import") setView("import-data");
  if (action === "filter-reset") { appState.dashboardFilters = { matricule: "", activite: "", dateFrom: "", dateTo: "" }; applyDashboardFilters(); }
  if (action === "view-cv") openCandidateCv(Number(actionEl.dataset.index));
  if (action === "edit-skills") openEditSkillsModal(Number(actionEl.dataset.index));
  if (action === "close-edit-skills") closeEditSkillsModal();
  if (action === "save-edit-skills") saveEditSkillsModal(Number(actionEl.dataset.index));
  if (action === "add-suggested-skill") {
    const box = actionEl.closest(".tag-field, .modal-card")?.querySelector(".tag-input");
    if (box) addSkillToBox(box, actionEl.dataset.skill);
    actionEl.remove();
  }
  if (action === "import-excel-trigger") byId("importExcelInput")?.click();
  if (action === "export-jobs-excel") exportJobsToExcel();
  if (action === "save-interview-feedback") saveInterviewFeedback(actionEl.dataset.id);
  if (action === "select-cv-files") byId("cvFileInput")?.click();
  if (action === "analyze-cv-files") analyzeUploadedCvs();
  if (action === "clear-errors") {
    appState.uploadFiles = appState.uploadFiles.filter(([, status]) => status !== "failed");
    pushActivity("Fichiers en erreur retires de la file");
    toast("Fichiers en erreur retires.", "success");
    rerenderKeepView();
  }
  if (action === "task-toggle") {
    const index = Number(actionEl.dataset.index);
    appState.completedTasks[actionEl.checked ? "add" : "delete"](index);
    pushActivity(`Tache ${index + 1} ${actionEl.checked ? "terminee" : "rouverte"}`);
    rerenderKeepView();
  }
  if (action === "candidate-status") {
    const c = candidates[selectedCandidateIndex];
    c[5] = actionEl.dataset.status;
    if (c[5] === "interview") interviews.unshift([`INT-${Date.now()}`, c[0], c[1], new Date().toLocaleDateString("fr-FR"), "10:00", session.user, "planned"]);
    pushActivity(`${c[0]} -> ${statusLabels[c[5]]}`);
    toast(`Statut mis a jour: ${statusLabels[c[5]]}.`, "success");
    rerenderKeepView();
    setView("candidate-detail");
  }
  if (action === "interview-status") { const item = interviews.find((i) => i[0] === actionEl.dataset.id); if (item) item[6] = actionEl.dataset.status; rerenderKeepView(); setView("interviews"); }
  if (action === "download-report") downloadReport(actionEl.dataset.type);
  if (action === "mark-notifications") { notificationsData.forEach((_, index) => appState.notificationsRead.add(index)); rerenderKeepView(); setView("notifications"); }
  if (action === "chat-prompt") submitChat(actionEl.dataset.prompt || "");
});


renderAll();
loadRealDataset().then(() => { renderAll(); applyRolePermissions(); });
applyRolePermissions();
restoreSession();










