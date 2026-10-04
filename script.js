"use strict";

/* =========================================================
   CADASTRO DE FUNÇÕES
   ========================================================= */
const ROLES = ["Duelista", "Iniciador", "Controlador", "Sentinela"];

/* =========================================================
   CADASTRO DE AGENTES
   Para adicionar um agente: "Nome": "Função" (uma das ROLES).
   ========================================================= */
const AGENTS = {
  // Duelistas
  Jett: "Duelista",
  Raze: "Duelista",
  Reyna: "Duelista",
  Phoenix: "Duelista",
  Neon: "Duelista",
  Yoru: "Duelista",
  Iso: "Duelista",
  Waylay: "Duelista",
  // Iniciadores
  Sova: "Iniciador",
  Skye: "Iniciador",
  Breach: "Iniciador",
  "KAY/O": "Iniciador",
  Fade: "Iniciador",
  Gekko: "Iniciador",
  Tejo: "Iniciador",
  // Controladores
  Omen: "Controlador",
  Brimstone: "Controlador",
  Viper: "Controlador",
  Astra: "Controlador",
  Harbor: "Controlador",
  Clove: "Controlador",
  // Sentinelas
  Killjoy: "Sentinela",
  Cypher: "Sentinela",
  Sage: "Sentinela",
  Chamber: "Sentinela",
  Deadlock: "Sentinela",
  Vyse: "Sentinela",
};

/* =========================================================
   GOOGLE SHEETS (fonte de verdade de mapas, jogadoras e picks)
   Colunas: MAPA | JOGADORA | PRINCIPAL | RESERVA
   ========================================================= */
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRYRN9DkYYxTbobwLwYwxFrwxTT430kpxlpLJOSeFRiOlDpBRtpCuDFxqkS3l0DTOBTrmrLLqnfKM63/pub?gid=0&single=true&output=csv";

const FETCH_TIMEOUT_MS = 15000;

// Nomes aceitos para cada coluna (comparados sem acento e sem caixa)
const COLUMNS = {
  map: ["MAPA"],
  player: ["JOGADORA", "JOGADOR"],
  main: ["PRINCIPAL"],
  reserve: ["RESERVA", "SECUNDARIA", "SECUNDARIO"],
  tertiary: ["TERCIARIA", "TERCIARIO"],
};
// Colunas que podem não existir na planilha
const OPTIONAL_COLUMNS = ["tertiary"];

// Preenchidos a partir da planilha (nunca alterados por TROCAR)
let PLAYERS = []; // [{ id, name }]
let MAPS = []; // [{ id, name, picks: { [playerId]: { main, reserve, tertiary } } }]

/* =========================================================
   CSV
   ========================================================= */

/*
 * Parser CSV (RFC 4180): aspas, vírgulas e quebras de linha dentro de
 * campos, aspas escapadas ("") e finais de linha CRLF/LF/CR.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Remove linhas totalmente vazias
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(value) {
  return slugify(value).toUpperCase();
}

// Converte as linhas do CSV em { players, maps }
function buildData(rows) {
  if (!rows.length) throw new Error("Planilha vazia.");

  const header = rows[0].map(normalizeHeader);
  const index = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    index[key] = header.findIndex((h) => names.map(normalizeHeader).includes(h));
    if (index[key] === -1 && !OPTIONAL_COLUMNS.includes(key)) {
      throw new Error(`Coluna ${names[0]} não encontrada no cabeçalho.`);
    }
  }

  const players = [];
  const maps = [];
  const playerBySlug = new Map();
  const mapBySlug = new Map();
  const cell = (row, key) =>
    index[key] === -1 ? "" : String(row[index[key]] ?? "").replace(/\s+/g, " ").trim();

  // Gera ids únicos mesmo se dois nomes resultarem no mesmo slug vazio
  const uniqueId = (base, used) => {
    let id = base || "item";
    for (let n = 2; used.has(id); n++) id = `${base || "item"}-${n}`;
    return id;
  };

  rows.slice(1).forEach((row) => {
    const mapName = cell(row, "map");
    const playerName = cell(row, "player");
    if (!mapName || !playerName) return;

    const mapKey = mapName.toLowerCase();
    let map = mapBySlug.get(mapKey);
    if (!map) {
      map = { id: uniqueId(slugify(mapName), new Set(maps.map((m) => m.id))), name: mapName, picks: {} };
      mapBySlug.set(mapKey, map);
      maps.push(map);
    }

    const playerKey = playerName.toLowerCase();
    let player = playerBySlug.get(playerKey);
    if (!player) {
      player = { id: uniqueId(slugify(playerName), new Set(players.map((p) => p.id))), name: playerName };
      playerBySlug.set(playerKey, player);
      players.push(player);
    }

    map.picks[player.id] = {
      main: canonicalAgentName(cell(row, "main")),
      reserve: canonicalAgentName(cell(row, "reserve")),
      tertiary: canonicalAgentName(cell(row, "tertiary")),
    };
  });

  if (!maps.length || !players.length) {
    throw new Error("Nenhum pick válido encontrado na planilha.");
  }
  return { players, maps };
}

// Busca um CSV publicado e devolve as linhas já interpretadas
async function fetchCSV(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Parâmetro extra evita receber uma cópia antiga do cache
    const sep = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${sep}_=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseCSV(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSheet() {
  return buildData(await fetchCSV(SHEET_CSV_URL));
}

/* =========================================================
   META POR MAPA (segunda aba, opcional)
   Colunas: MAPA | AGENTE | FUNÇÃO | TIER | PLAYED_% | WIN_RATE_% |
            NON_MIRROR_WR_% | KILLS_% | K_D | DD_DELTA_ROUND
   Se não carregar, o site funciona igual, só sem bônus de META.
   ========================================================= */
const META_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRYRN9DkYYxTbobwLwYwxFrwxTT430kpxlpLJOSeFRiOlDpBRtpCuDFxqkS3l0DTOBTrmrLLqnfKM63/pub?gid=442044478&single=true&output=csv";

const META_COLUMNS = {
  map: "MAPA",
  agent: "AGENTE",
  role: "FUNCAO",
  tier: "TIER",
  played: "PLAYED",
  winRate: "WINRATE",
  nonMirror: "NONMIRRORWR",
  kills: "KILLS",
  kd: "KD",
  ddDelta: "DDDELTAROUND",
};
const META_REQUIRED = ["map", "agent"];

// Grafias diferentes do mesmo mapa (comparação interna; a tela mostra o original)
const MAP_ALIASES = {
  abbys: "abyss",
};

// Função na META (inglês ou português) -> função usada no site
const META_ROLE_NAMES = {
  controller: "Controlador",
  controlador: "Controlador",
  initiator: "Iniciador",
  iniciador: "Iniciador",
  sentinel: "Sentinela",
  sentinela: "Sentinela",
  duelist: "Duelista",
  duelista: "Duelista",
};

const META = {
  status: "loading", // "loading" | "ready" | "error"
  byMap: new Map(), // mapa normalizado -> Map(agente normalizado -> registro)
  rows: 0,
  issues: [], // inconsistências encontradas (linha, mapa, agente, motivo)
};

// "52.9", "52,9", "52.9%", " 52,9 % " -> 52.9 ; inválido/vazio -> null
function parseMetaNumber(value) {
  const str = String(value ?? "").replace(/%/g, "").replace(/\s+/g, "");
  if (!str) return null;
  // Com "." e ",", o último separador é o decimal ("1.234,5" / "1,234.5")
  const decimal = str.lastIndexOf(",") > str.lastIndexOf(".") ? "," : ".";
  const thousands = decimal === "," ? "." : ",";
  const normalized = str.split(thousands).join("").replace(decimal, ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

// Header "NON_MIRROR_WR_%" -> "NONMIRRORWR"
function normalizeMetaHeader(value) {
  return slugify(value).toUpperCase();
}

// Converte as linhas do CSV META em { byMap, rows, issues }
function buildMeta(rows) {
  if (!rows.length) throw new Error("META vazia.");
  const header = rows[0].map(normalizeMetaHeader);
  const index = {};
  for (const [key, name] of Object.entries(META_COLUMNS)) index[key] = header.indexOf(name);
  META_REQUIRED.forEach((key) => {
    if (index[key] === -1) throw new Error(`Coluna ${META_COLUMNS[key]} não encontrada na META.`);
  });

  const byMap = new Map();
  const issues = [];
  let count = 0;
  const cell = (row, key) => (index[key] === -1 ? "" : String(row[index[key]] ?? "").trim());

  rows.slice(1).forEach((row, i) => {
    const line = i + 2; // linha na planilha (1 = cabeçalho)
    const mapName = cell(row, "map");
    const agentName = cell(row, "agent");
    if (!mapName || !agentName) {
      issues.push({ line, map: mapName, agent: agentName, problem: "sem MAPA ou AGENTE (linha ignorada)" });
      return;
    }

    const record = { line, map: mapName, agent: agentName, roleRaw: cell(row, "role") };
    record.role = META_ROLE_NAMES[normalizeName(record.roleRaw)] || null;
    if (record.roleRaw && !record.role) {
      issues.push({ line, map: mapName, agent: agentName, problem: `FUNÇÃO desconhecida: "${record.roleRaw}"` });
    }
    record.tier = cell(row, "tier").toUpperCase();
    ["played", "winRate", "nonMirror", "kills", "kd", "ddDelta"].forEach((key) => {
      const raw = cell(row, key);
      record[key] = parseMetaNumber(raw);
      if (raw && record[key] === null) {
        issues.push({ line, map: mapName, agent: agentName, problem: `${META_COLUMNS[key]} inválido: "${raw}"` });
      }
    });

    const mapKey = normalizeMapName(mapName);
    if (!byMap.has(mapKey)) byMap.set(mapKey, new Map());
    const agents = byMap.get(mapKey);
    const agentKey = normalizeName(agentName);
    if (agents.has(agentKey)) {
      issues.push({ line, map: mapName, agent: agentName, problem: `repetido (vale a linha ${agents.get(agentKey).line})` });
      return;
    }
    agents.set(agentKey, record);
    count++;
  });

  return { byMap, rows: count, issues };
}

async function fetchMeta() {
  return buildMeta(await fetchCSV(META_CSV_URL));
}

/* =========================================================
   UTILITÁRIOS
   ========================================================= */

// Nome -> nome de arquivo ("KAY/O" -> "kayo")
function slugify(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Chave de comparação: sem caixa, acentos, espaços ou símbolos ("KAY/O" -> "kayo")
function normalizeName(name) {
  return slugify(name);
}

// "Abbys", " abyss ", "ABYSS" -> "abyss"
function normalizeMapName(name) {
  const key = normalizeName(name);
  return MAP_ALIASES[key] || key;
}

// Todos os nomes de agentes conhecidos: AGENTS + os que só existem na META
function knownAgentNames() {
  const names = Object.keys(AGENTS);
  const seen = new Set(names.map(normalizeName));
  META.byMap.forEach((agents) => {
    agents.forEach((record, key) => {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(record.agent);
      }
    });
  });
  return names;
}

// "kayo", "Kay/O", " sova " -> nome como está no cadastro; desconhecido fica como veio
function canonicalAgentName(name) {
  const slug = normalizeName(name);
  if (!slug) return "";
  return knownAgentNames().find((agent) => normalizeName(agent) === slug) || String(name).trim();
}

// Registro da META do agente NAQUELE mapa (ou null)
function getMetaForAgent(agentName, mapName) {
  const agents = META.byMap.get(normalizeMapName(mapName));
  return (agents && agents.get(normalizeName(agentName))) || null;
}

function hasMetaForMap(mapName) {
  return META.byMap.has(normalizeMapName(mapName));
}

// Função do agente: META do mapa -> AGENTS -> null
function resolveAgentRole(agentName, mapName) {
  const meta = mapName ? getMetaForAgent(agentName, mapName) : null;
  if (meta && meta.role) return meta.role;
  const local = AGENTS[canonicalAgentName(agentName)];
  if (local) return local;
  // Agente fora de AGENTS: usa a função dele em qualquer mapa da META
  for (const agents of META.byMap.values()) {
    const record = agents.get(normalizeName(agentName));
    if (record && record.role) return record.role;
  }
  return null;
}

function getAgentRole(agentName, mapName) {
  return resolveAgentRole(agentName, mapName) || "Função desconhecida";
}

// Retrato quadrado do agente (assets/agents/<slug>.webp)
function getAgentImage(agentName) {
  return `assets/agents/${slugify(agentName)}.webp`;
}

// Retrato completo (arte decorativa do header)
function getAgentFullImage(agentName) {
  return `assets/agents/full/${slugify(agentName)}.webp`;
}

// Imagem do mapa; "Abbys" usa o arquivo de "abyss" (o texto exibido não muda)
function getMapImage(mapName) {
  return `assets/maps/${normalizeMapName(mapName)}.webp`;
}

// Faixa horizontal do mapa (botões de navegação)
function getMapStripImage(mapName) {
  return `assets/maps/${normalizeMapName(mapName)}-strip.webp`;
}

function safeText(value, fallback = "—") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number" && Number.isNaN(value)) return fallback;
  const str = String(value).trim();
  return str === "" ? fallback : str;
}

// Imagens que já falharam não são pedidas de novo a cada renderização
const missingImages = new Set();

/*
 * Cria um <img> que, se o arquivo não existir, é substituído por um
 * placeholder com as iniciais. A página nunca depende da imagem.
 */
function createImage(src, label, className, role) {
  const wrapper = document.createElement("div");
  wrapper.className = `img-box ${className}`;
  if (role) wrapper.dataset.role = role;

  const placeholder = document.createElement("span");
  placeholder.className = "img-placeholder";
  placeholder.textContent = safeText(label, "?").slice(0, 2).toUpperCase();
  wrapper.appendChild(placeholder);

  if (!label || missingImages.has(src)) return wrapper;

  const img = document.createElement("img");
  img.alt = safeText(label, "");
  img.loading = "lazy";
  img.addEventListener("load", () => wrapper.classList.add("has-img"));
  img.addEventListener("error", () => {
    missingImages.add(src);
    img.remove();
  });
  img.src = src;
  wrapper.appendChild(img);

  return wrapper;
}

/* =========================================================
   ASSISTENTE DE DRAFT — ALGORITMO (V2: composição + META)
   Funções puras: recebem mapa/jogadoras/agentes externos e não
   tocam no DOM nem no estado da página. TROCAR não interfere,
   pois aqui só são lidos os picks originais da planilha.

   Prioridade: validade > cobertura das funções críticas > estrutura >
   excesso de função > META > conforto (PRINCIPAL > SECUNDÁRIA > TERCIÁRIA).
   A META só desempata entre as opções do pool de cada jogadora
   (PRINCIPAL/SECUNDÁRIA/TERCIÁRIA do mapa); nunca adiciona agentes.
   ========================================================= */
const STRUCTURAL_SCORES = {
  presence: { Controlador: 40, Iniciador: 25, Sentinela: 20, Duelista: 15 },
  absence: { Controlador: -60, Iniciador: -25, Sentinela: -15, Duelista: -8 },
  diversity: { 4: 25, 3: 12, 2: 0, 1: -30, 0: -30 },
  // Penalidade ADICIONAL ao chegar em N agentes da mesma função (acumula):
  // 2 = -5 · 3 = -5-40 = -45 · 4 = -115 · 5 = -215
  repetition: { 2: -5, 3: -40, 4: -70, 5: -100 },
};

const TIER_SCORES = { S: 8, A: 5, B: 2, C: 0, D: -3 }; // tier inesperado = 0

const META_CONFIG = {
  neutralWinRate: 50,
  nonMirror: { factor: 2, min: -10, max: 10 },
  winRate: { factor: 0.75, min: -4, max: 4 },
  // PLAYED_% mínimo -> confiança aplicada aos componentes de win rate
  confidence: [
    { minPlayed: 5, value: 1 },
    { minPlayed: 2, value: 0.85 },
    { minPlayed: 1, value: 0.7 },
    { minPlayed: -Infinity, value: 0.55 },
  ],
  agent: { min: -10, max: 15 }, // limite por agente
  trio: { min: -20, max: 30 }, // limite da soma do trio
  goodAgentScore: 3, // a partir daqui a explicação diz "bom desempenho"
  meaningfulDiff: 1, // diferença mínima para dizer "desempenho superior"
};

// Conforto de cada posição do pool (reserve = SECUNDÁRIA)
const PREFERENCE_SCORES = { main: 8, reserve: 3, tertiary: 0 };
const SLOT_LABELS = { main: "principal", reserve: "secundária", tertiary: "terciária" };

// Funções que o time não pode deixar de ter se houver como cobri-las.
// Vêm ANTES de qualquer score: só competem as combinações com a maior cobertura possível.
const CRITICAL_ROLES = ["Controlador", "Iniciador", "Sentinela"];

// Ordem usada na explicação (prioridade das funções)
const DRAFT_ROLE_PRIORITY = ["Controlador", "Iniciador", "Sentinela", "Duelista"];
const ROLE_PLURALS = { Controlador: "Controladores", Iniciador: "Iniciadores", Sentinela: "Sentinelas", Duelista: "Duelistas" };
const COUNT_WORDS = { 2: "dois", 3: "três", 4: "quatro", 5: "cinco" };

const sameAgent = (a, b) => normalizeName(a) === normalizeName(b);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Math.round(value * 100) / 100;

// Opções de cada jogadora no mapa: PRINCIPAL, SECUNDÁRIA e TERCIÁRIA, sem vazios/repetidos
function getDraftOptions(map, players) {
  return players.map((player) => {
    const pick = (map && map.picks[player.id]) || {};
    const options = [];
    ["main", "reserve", "tertiary"].forEach((slot) => {
      const opt = { agent: safeText(pick[slot], ""), slot, isMain: slot === "main" };
      if (opt.agent && !options.some((o) => sameAgent(o.agent, opt.agent))) options.push(opt);
    });
    return { player, options };
  });
}

/*
 * Produto cartesiano das opções (até 3 × 3 × 3 = 27).
 * Ordem determinística: primeira jogadora varia mais devagar,
 * PRINCIPAL antes de SECUNDÁRIA antes de TERCIÁRIA.
 */
function generateDraftCombinations(playerOptions) {
  let combos = [[]];
  playerOptions.forEach(({ player, options }) => {
    const next = [];
    combos.forEach((combo) => {
      options.forEach((opt) => {
        next.push([...combo, { playerId: player.id, playerName: player.name, ...opt }]);
      });
    });
    combos = next;
  });
  return playerOptions.length ? combos : [];
}

function hasDuplicateAgents(agents) {
  const seen = new Set();
  return agents.some((agent) => {
    const key = normalizeName(agent);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

// Penalidade acumulada por ter `count` agentes da mesma função
function repetitionPenalty(count) {
  let total = 0;
  for (let n = 2; n <= count; n++) {
    total += STRUCTURAL_SCORES.repetition[n] ?? STRUCTURAL_SCORES.repetition[5];
  }
  return total;
}

// Estrutura da composição a partir das funções (null = função desconhecida)
function calculateStructuralScore(roles) {
  const roleCount = Object.fromEntries(ROLES.map((r) => [r, 0]));
  roles.forEach((role) => {
    if (role && role in roleCount) roleCount[role]++;
  });

  let roleScore = 0;
  let repetition = 0;
  ROLES.forEach((role) => {
    roleScore += roleCount[role] > 0 ? STRUCTURAL_SCORES.presence[role] : STRUCTURAL_SCORES.absence[role];
    repetition += repetitionPenalty(roleCount[role]);
  });
  const distinct = ROLES.filter((r) => roleCount[r] > 0).length;
  const diversity = STRUCTURAL_SCORES.diversity[distinct];

  return { score: roleScore + diversity + repetition, roleScore, diversity, repetition, roleCount, distinct };
}

// Pontuação META de um agente (registro do mapa atual); sem registro = 0
function calculateAgentMetaScore(record) {
  if (!record) return { score: 0, available: false };
  const { neutralWinRate: neutral, nonMirror, winRate } = META_CONFIG;

  const nonMirrorScore = record.nonMirror === null || record.nonMirror === undefined
    ? 0
    : clamp((record.nonMirror - neutral) * nonMirror.factor, nonMirror.min, nonMirror.max);
  const winScore = record.winRate === null || record.winRate === undefined
    ? 0
    : clamp((record.winRate - neutral) * winRate.factor, winRate.min, winRate.max);
  const played = record.played ?? -Infinity;
  const confidence = META_CONFIG.confidence.find((c) => played >= c.minPlayed).value;
  const tierScore = TIER_SCORES[record.tier] ?? 0;

  const score = clamp((nonMirrorScore + winScore) * confidence + tierScore, META_CONFIG.agent.min, META_CONFIG.agent.max);
  return { score: round2(score), available: true, nonMirrorScore, winScore, confidence, tierScore };
}

// META do trio (só as jogadoras; externos não recebem bônus)
function calculateMetaScore(picks, mapName) {
  const perPick = picks.map((pick) => {
    const record = getMetaForAgent(pick.agent, mapName);
    return { record, ...calculateAgentMetaScore(record) };
  });
  const raw = perPick.reduce((sum, p) => sum + p.score, 0);
  return { score: round2(clamp(raw, META_CONFIG.trio.min, META_CONFIG.trio.max)), raw: round2(raw), perPick };
}

function calculatePreferenceScore(picks) {
  return picks.reduce((sum, p) => sum + (PREFERENCE_SCORES[p.slot] ?? 0), 0);
}

// Avalia uma combinação do trio junto com os externos; null se repetir agente
function evaluateDraftCombination(picks, externals, mapName) {
  const agents = [...externals, ...picks.map((p) => p.agent)];
  if (hasDuplicateAgents(agents)) return null; // VALORANT não permite agente repetido

  const roles = agents.map((agent) => resolveAgentRole(agent, mapName));
  const structural = calculateStructuralScore(roles);
  const meta = calculateMetaScore(picks, mapName);
  const preference = calculatePreferenceScore(picks);
  const criticalRoles = CRITICAL_ROLES.filter((r) => structural.roleCount[r] > 0);

  // Regra de conforto: Duelista que só existe por causa de uma TERCIÁRIA não
  // ganha, no ranking, o bônus de presença/diversidade de Duelista. Assim a
  // terciária só vence por outro motivo real (função crítica, conflito,
  // evitar excesso de função, META...). O score exibido continua o real.
  const isTertiaryDuelist = (i) =>
    i >= externals.length && picks[i - externals.length].slot === "tertiary" && roles[i] === "Duelista";
  const duelistViaTertiary =
    roles.some((role, i) => isTertiaryDuelist(i)) &&
    !roles.some((role, i) => role === "Duelista" && !isTertiaryDuelist(i));
  const rankingStructural = duelistViaTertiary
    ? calculateStructuralScore(roles.map((role, i) => (isTertiaryDuelist(i) ? null : role))).score
    : structural.score;

  return {
    picks: picks.map((p, i) => ({ ...p, role: roles[externals.length + i], meta: meta.perPick[i] })),
    agents,
    roles,
    unknown: agents.filter((_, i) => !roles[i]),
    mainCount: picks.filter((p) => p.isMain).length,
    roleCount: structural.roleCount,
    criticalRoles,
    criticalCovered: criticalRoles.length,
    structural,
    meta,
    preference,
    score: round2(structural.score + meta.score + preference),
    duelistViaTertiary,
    rankingStructural,
    rankingScore: round2(rankingStructural + meta.score + preference),
  };
}

// Entre combinações com a mesma cobertura crítica:
// score de ranking (regra de conforto) > total > estrutura > META > preferência >
// nº de PRINCIPAIS > ordem da planilha
function compareOptions(a, b) {
  return (
    b.rankingScore - a.rankingScore ||
    b.score - a.score ||
    b.structural.score - a.structural.score ||
    b.meta.score - a.meta.score ||
    b.preference - a.preference ||
    b.mainCount - a.mainCount ||
    a.index - b.index
  );
}

/*
 * Ranking em duas etapas:
 * 1) maior cobertura de funções críticas (Controlador/Iniciador/Sentinela)
 *    entre as combinações realmente possíveis — nenhum score passa por cima disso;
 * 2) dentro da mesma cobertura, compareOptions (score atual, com a regra de
 *    conforto: Duelista vindo só de TERCIÁRIA não pesa no ranking).
 */
function rankCombinations(combos, externals, mapName) {
  const ranked = [];
  combos.forEach((combo, index) => {
    const option = evaluateDraftCombination(combo, externals, mapName);
    if (option) ranked.push({ ...option, index });
  });
  return ranked.sort((a, b) => b.criticalCovered - a.criticalCovered || compareOptions(a, b));
}

// Quais funções críticas alguma combinação válida consegue cobrir
function getCriticalCoverage(ranking) {
  const possible = CRITICAL_ROLES.filter((r) => ranking.some((o) => o.roleCount[r] > 0));
  return {
    max: ranking.reduce((max, o) => Math.max(max, o.criticalCovered), 0),
    possible,
    impossible: CRITICAL_ROLES.filter((r) => !possible.includes(r)),
  };
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

// "Astra (terciária)"; a principal fica sem rótulo
function pickLabel(pick) {
  return pick.isMain ? pick.agent : `${pick.agent} (${SLOT_LABELS[pick.slot]})`;
}

// Por que a jogadora ficou com aquele agente (compara com as outras opções dela)
function explainPick(option, i, playerOptions, externals, mapName) {
  const pick = option.picks[i];
  const who = pick.playerName;
  const agent = pick.agent;
  const label = pickLabel(pick);
  const others = playerOptions[i].options.filter((o) => !sameAgent(o.agent, agent));

  if (!others.length) return `${agent} é a única opção cadastrada de ${who} neste mapa.`;

  const swaps = others.map((other) => ({
    other,
    alt: evaluateDraftCombination(
      option.picks.map((p, j) => (j === i ? { playerId: p.playerId, playerName: p.playerName, ...other } : p)),
      externals, mapName),
  }));
  const valid = swaps.filter((s) => s.alt);
  if (!valid.length) {
    const names = others.map((o) => o.agent);
    return `${who} fica com ${label} porque ${joinList(names)} já ${names.length > 1 ? "estão" : "está"} na composição.`;
  }

  // Função crítica que se perderia trocando esta escolha
  if (pick.role && CRITICAL_ROLES.includes(pick.role) && valid.some((s) => s.alt.roleCount[pick.role] === 0)) {
    return `${who} fica com ${label} para garantir ${pick.role} (função crítica).`;
  }

  // Terciária que só traria Duelista: regra de conforto
  const duelistOnly = valid.find((s) => s.other.slot === "tertiary" && s.alt.duelistViaTertiary &&
    !option.duelistViaTertiary && s.alt.score > option.score);
  if (duelistOnly) {
    return `${who} fica com ${label}: ${duelistOnly.other.agent} (terciária) só acrescentaria Duelista, o que não justifica trocar por ela.`;
  }

  // Compara com a alternativa mais forte dela (pelos valores usados no ranking)
  const { other, alt } = valid.reduce((best, s) => (s.alt.rankingScore > best.alt.rankingScore ? s : best));
  const structDiff = option.rankingStructural - alt.rankingStructural;
  const metaDiff = pick.meta.score - alt.picks[i].meta.score;
  const metaBetter = pick.meta.available && metaDiff >= META_CONFIG.meaningfulDiff;
  const good = pick.meta.available && pick.meta.score >= META_CONFIG.goodAgentScore;

  if (structDiff > 0) {
    const duelistNotCounted = pick.slot === "tertiary" && pick.role === "Duelista" && option.duelistViaTertiary;
    if (pick.role && alt.roleCount[pick.role] === 0 && !duelistNotCounted) {
      return `${who} fica com ${label} para garantir ${pick.role} na composição.`;
    }
    const altRole = alt.picks[i].role;
    if (altRole && alt.roleCount[altRole] >= 3) {
      const n = alt.roleCount[altRole];
      return `${who} fica com ${label} para evitar ${COUNT_WORDS[n] || n} ${ROLE_PLURALS[altRole]}.`;
    }
    return `${who} fica com ${label} porque deixa as funções mais equilibradas do que ${other.agent}.`;
  }

  if (structDiff === 0 && metaBetter && !pick.isMain) {
    return pick.role && pick.role === alt.picks[i].role
      ? `${who} fica com ${label} em vez de ${other.agent}: ambos cumprem a função de ${pick.role}, mas ${agent} tem desempenho superior no META de ${mapName}.`
      : `${who} fica com ${label} em vez de ${other.agent} porque ${agent} tem desempenho superior no META de ${mapName}.`;
  }

  if (structDiff < 0) {
    const why = metaBetter
      ? `${agent} tem desempenho superior no META de ${mapName}`
      : pick.slot === "tertiary"
        ? "o conjunto das escolhas pontua melhor"
        : `${agent} é a ${SLOT_LABELS[pick.slot]} dela`;
    return `${who} fica com ${label}: a composição fica um pouco menos equilibrada, mas ${why}.`;
  }

  if (pick.isMain) {
    return good
      ? `${who} fica com ${agent} por ser a principal dela e ter bom desempenho no META de ${mapName}.`
      : `${who} fica com ${agent} por ser a principal dela.`;
  }
  if (pick.slot === "reserve" && other.slot === "tertiary") {
    return `${who} fica com ${label}, preferida à terciária (${other.agent}) por conforto.`;
  }
  return `${who} fica com ${label}.`;
}

// Explicação determinística, montada a partir dos componentes do score
function explainDraftOption(option, playerOptions, externals, mapName, coverage) {
  const sentences = [];
  const present = DRAFT_ROLE_PRIORITY.filter((r) => option.roleCount[r] > 0);
  const missing = DRAFT_ROLE_PRIORITY.filter((r) => option.roleCount[r] === 0);
  const missingCritical = CRITICAL_ROLES.filter((r) => option.roleCount[r] === 0);

  if (!missingCritical.length) {
    sentences.push(`A composição cobre todas as funções críticas: ${joinList(CRITICAL_ROLES)}` +
      (option.roleCount.Duelista > 0 ? " e também tem Duelista." : "; fica sem Duelista."));
  } else if (present.length) {
    sentences.push(`Esta opção cobre ${joinList(present)}; fica sem ${joinList(missing)}.`);
  } else {
    sentences.push("Esta opção não tem nenhuma função reconhecida.");
  }

  // Função crítica ausente: impossível com os pools, ou impossível junto com as outras
  missingCritical.filter((r) => coverage.impossible.includes(r)).forEach((role) => {
    sentences.push(`${role} não pôde ser incluído com os picks disponíveis do trio.`);
  });
  const conflicting = missingCritical.filter((r) => !coverage.impossible.includes(r));
  if (conflicting.length) {
    sentences.push(`Com os picks disponíveis não dá para ter ${joinList(coverage.possible)} ao mesmo tempo; ` +
      `esta opção mantém ${joinList(option.criticalRoles)}.`);
  }

  option.picks.forEach((_, i) => sentences.push(explainPick(option, i, playerOptions, externals, mapName)));

  DRAFT_ROLE_PRIORITY.forEach((role) => {
    const n = option.roleCount[role];
    if (n >= 3) sentences.push(`A composição foi penalizada por possuir ${COUNT_WORDS[n] || n} ${ROLE_PLURALS[role]}.`);
  });
  if (option.unknown.length) {
    sentences.push(`Sem função cadastrada (não conta para as funções): ${joinList(option.unknown)}.`);
  }
  return sentences.join(" ");
}

/*
 * Ponto de entrada do assistente.
 * Retorna { status: "ok" | "duplicate-external" | "no-valid" | "no-map", ... }
 */
function suggestDraft(map, players, externalAgents) {
  if (!map || !players.length) return { status: "no-map" };

  const externals = externalAgents.map((a) => safeText(a, "")).filter(Boolean);
  if (hasDuplicateAgents(externals)) return { status: "duplicate-external", externals };

  const playerOptions = getDraftOptions(map, players);
  const withoutAgents = playerOptions.filter((p) => !p.options.length).map((p) => p.player.name);
  const ranking = rankCombinations(generateDraftCombinations(playerOptions), externals, map.name);

  if (!ranking.length) return { status: "no-valid", externals, withoutAgents };

  const criticalCoverage = getCriticalCoverage(ranking);
  ranking.forEach((opt) => {
    opt.explanation = explainDraftOption(opt, playerOptions, externals, map.name, criticalCoverage);
  });
  return {
    status: "ok",
    externals,
    metaAvailable: hasMetaForMap(map.name),
    criticalCoverage,
    ranking, // todas as combinações válidas, da melhor para a pior
    best: ranking[0],
    alternatives: ranking.length >= 3 ? ranking.slice(1, 3) : [],
  };
}

/* =========================================================
   ESTADO
   ========================================================= */
const state = {
  status: "loading", // "loading" | "ready" | "error"
  mapId: null,
  swapped: {}, // { amorim: true } => principal e reserva trocados (temporário)
  draft: { externals: ["", ""], result: null },
};

function getCurrentMap() {
  return MAPS.find((m) => m.id === state.mapId) || null;
}

// Picks atualmente exibidos para uma jogadora (considerando trocas)
function getCurrentPick(playerId) {
  const map = getCurrentMap();
  const original = (map && map.picks[playerId]) || {};
  const main = safeText(original.main, "");
  const reserve = safeText(original.reserve, "");
  return state.swapped[playerId]
    ? { main: reserve, reserve: main }
    : { main, reserve };
}

/* =========================================================
   AÇÕES
   ========================================================= */
function selectMap(mapId) {
  if (!MAPS.some((m) => m.id === mapId)) return;
  state.mapId = mapId;
  state.swapped = {}; // trocas são temporárias e valem só para o mapa atual
  resetDraft();
  render();
}

function resetDraft() {
  state.draft = { externals: ["", ""], result: null };
}

function setExternalAgent(slot, agent) {
  state.draft.externals[slot] = agent;
  state.draft.result = null; // sugestão anterior deixa de valer
  renderDraft();
}

function runDraftSuggestion() {
  state.draft.result = suggestDraft(getCurrentMap(), PLAYERS, state.draft.externals);
  renderDraft();
}

function swapPlayer(playerId) {
  state.swapped[playerId] = !state.swapped[playerId];
  render();
}

function restorePicks() {
  state.swapped = {};
  render();
}

/* =========================================================
   RENDERIZAÇÃO
   ========================================================= */
function renderMapSelect() {
  const nav = document.getElementById("map-select");
  nav.innerHTML = "";
  MAPS.forEach((map) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-btn" + (map.id === state.mapId ? " active" : "");
    btn.textContent = safeText(map.name).toUpperCase();
    // Miniatura como fundo: se o arquivo não existir, fica só o fundo escuro
    btn.style.setProperty("--thumb", `url("${getMapStripImage(map.name)}")`);
    btn.setAttribute("aria-pressed", map.id === state.mapId ? "true" : "false");
    btn.addEventListener("click", () => selectMap(map.id));
    nav.appendChild(btn);
  });
}

function renderMapBanner() {
  const banner = document.getElementById("map-banner");
  banner.innerHTML = "";
  const map = getCurrentMap();
  if (!map) {
    banner.textContent = "Nenhum mapa disponível.";
    return;
  }
  banner.appendChild(createImage(getMapImage(map.name), map.name, "map-img"));
  const text = el("div", "map-banner-text");
  text.appendChild(el("p", "label", "Mapa selecionado"));
  const title = el("h2", "map-name", safeText(map.name).toUpperCase());
  text.appendChild(title);
  banner.appendChild(text);
}

// Arte do header: retratos das principais exibidas no mapa atual (decorativo)
function renderHeaderArt() {
  const art = document.getElementById("header-art");
  art.innerHTML = "";
  PLAYERS.slice(0, 3).forEach((player) => {
    const agent = getCurrentPick(player.id).main;
    if (!agent) return;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("error", () => img.remove()); // nunca mostra imagem quebrada
    img.src = getAgentFullImage(agent);
    art.appendChild(img);
  });
}

// Uma linha do card: rótulo, retrato, nome e badge da função
function renderPickRow(slotClass, label, agent, mapName, imgClass) {
  const row = el("div", `pick ${slotClass}${agent ? "" : " is-empty"}`);
  const role = agent ? resolveAgentRole(agent, mapName) : null;
  const portrait = createImage(getAgentImage(agent), agent, `agent-img ${imgClass}`, role || undefined);
  if (!agent) portrait.querySelector(".img-placeholder").textContent = "—"; // posição vazia
  row.appendChild(portrait);
  row.appendChild(el("p", "label", label));
  row.appendChild(el("p", "agent-name", safeText(agent)));
  const badge = el("p", "agent-role role-badge", agent ? getAgentRole(agent, mapName) : "—");
  if (role) badge.dataset.role = role;
  if (!agent) badge.hidden = true;
  row.appendChild(badge);
  return row;
}

function renderPlayers() {
  const container = document.getElementById("players");
  container.innerHTML = "";

  const map = getCurrentMap();
  const mapName = (map || {}).name;
  PLAYERS.forEach((player) => {
    const pick = getCurrentPick(player.id);
    const tertiary = safeText(((map || { picks: {} }).picks[player.id] || {}).tertiary, "");
    const card = el("article", "card");
    card.dataset.player = player.id;

    const head = el("header", "card-head");
    head.appendChild(el("h3", "player-name", safeText(player.name).toUpperCase()));
    // TROCAR: só alterna principal/secundária (temporário)
    const swapBtn = el("button", "btn swap-btn");
    swapBtn.type = "button";
    swapBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">⇄</span> Trocar';
    swapBtn.setAttribute("aria-label", `Trocar principal e secundária de ${safeText(player.name)}`);
    swapBtn.disabled = !pick.main || !pick.reserve;
    swapBtn.addEventListener("click", () => swapPlayer(player.id));
    head.appendChild(swapBtn);
    card.appendChild(head);

    card.appendChild(renderPickRow("pick-main", "Principal", pick.main, mapName, ""));
    card.appendChild(renderPickRow("pick-reserve", "Secundária", pick.reserve, mapName, "small"));
    // Terciária: só informativa (TROCAR não mexe nela)
    card.appendChild(renderPickRow("pick-tertiary", "Terciária", tertiary, mapName, "tiny"));

    if (state.swapped[player.id]) {
      card.classList.add("is-swapped");
      card.appendChild(el("p", "swap-note", "Trocado temporariamente"));
    }

    container.appendChild(card);
  });
}

function getComposition() {
  const mapName = (getCurrentMap() || {}).name;
  const present = new Set(
    PLAYERS.map((p) => getCurrentPick(p.id).main)
      .filter(Boolean)
      .map((agent) => getAgentRole(agent, mapName))
  );
  return ROLES.map((role) => ({ role, present: present.has(role) }));
}

// Item de função: ícone + letra + nome + estado (✓ presente, ! crítica ausente, — ausente)
function renderRoleItem(role, present) {
  const critical = CRITICAL_ROLES.includes(role);
  const li = el("li", `${present ? "present" : "absent"}${critical ? " is-critical" : ""}`);
  li.dataset.role = role;
  const icon = el("span", "role-icon");
  icon.setAttribute("aria-hidden", "true");
  li.appendChild(icon);
  const label = el("span", "role-label");
  const letter = el("span", "letter", role[0]);
  letter.setAttribute("aria-hidden", "true");
  label.appendChild(letter);
  label.appendChild(el("span", "role", role));
  li.appendChild(label);
  const mark = el("span", "mark", present ? "✓" : critical ? "!" : "—");
  mark.setAttribute("aria-label", present ? "presente" : critical ? "função crítica ausente" : "ausente");
  li.appendChild(mark);
  return li;
}

function renderComposition() {
  const list = document.getElementById("composition");
  list.innerHTML = "";
  getComposition().forEach(({ role, present }) => list.appendChild(renderRoleItem(role, present)));
}

/* ---------- Assistente de Draft ---------- */

// Preenche os seletores com AGENTS + agentes da META, agrupados pela função no mapa
let draftSelectsKey = null;
function fillDraftSelects(mapName) {
  const key = `${normalizeMapName(mapName)}|${META.status}`;
  if (key === draftSelectsKey) return;
  draftSelectsKey = key;

  const agents = knownAgentNames().sort((a, b) => a.localeCompare(b, "pt-BR"));
  const groups = [...ROLES, null].map((role) => ({
    label: role || "Outros",
    agents: agents.filter((agent) => resolveAgentRole(agent, mapName) === role),
  }));
  document.querySelectorAll(".draft-select").forEach((select) => {
    select.innerHTML = "";
    select.appendChild(new Option("Nenhum agente", ""));
    groups.forEach(({ label, agents: list }) => {
      if (!list.length) return;
      const group = document.createElement("optgroup");
      group.label = label;
      list.forEach((agent) => group.appendChild(new Option(agent, agent)));
      select.appendChild(group);
    });
  });
}

// 87.35 -> "87.4" ; 94 -> "94"
function formatScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSigned(value) {
  return `${value > 0 ? "+" : ""}${formatScore(value)}`;
}

// "Tier S · NM WR 55.2%" (só o que existir de verdade na META)
function formatPickMeta(meta) {
  const record = meta && meta.record;
  if (!record) return "";
  const parts = [];
  if (record.tier) parts.push(`Tier ${record.tier}`);
  if (record.nonMirror !== null) parts.push(`NM WR ${record.nonMirror.toFixed(1)}%`);
  return parts.join(" · ");
}

function describeRoleCount(roleCount) {
  return DRAFT_ROLE_PRIORITY.filter((r) => roleCount[r] > 0)
    .map((r) => `${roleCount[r]} ${roleCount[r] > 1 ? ROLE_PLURALS[r] : r}`)
    .join(", ") || "nenhuma função reconhecida";
}

function getMetaStatusText(mapName) {
  if (META.status === "loading") return "Carregando dados META...";
  if (META.status === "error") return "DADOS META INDISPONÍVEIS — sugestão baseada na composição.";
  if (!hasMetaForMap(mapName)) return "SEM DADOS META PARA ESTE MAPA — sugestão baseada na composição.";
  return "";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderDraftRoles(roleCount) {
  const list = el("ul", "draft-roles");
  ROLES.forEach((role) => list.appendChild(renderRoleItem(role, roleCount[role] > 0)));
  return list;
}

// Bloco com título pequeno (COMP FINAL, FUNÇÕES, ...)
function draftBlock(className, title, content) {
  const block = el("div", className);
  block.appendChild(el("h3", "draft-heading", title));
  block.appendChild(content);
  return block;
}

function renderDraftSuggestion(result) {
  const box = el("div", "draft-result");

  if (result.status === "duplicate-external") {
    box.classList.add("draft-error");
    box.appendChild(el("p", "draft-error-title", "COMPOSIÇÃO INVÁLIDA"));
    box.appendChild(el("p", "draft-explanation",
      `JOGADOR 4 e JOGADOR 5 escolheram o mesmo agente (${result.externals[0]}). No VALORANT cada agente só pode ser usado uma vez por time.`));
    return box;
  }
  if (result.status !== "ok") {
    box.classList.add("draft-error");
    box.appendChild(el("p", "draft-error-title",
      "NÃO FOI POSSÍVEL FORMAR UMA COMPOSIÇÃO VÁLIDA COM OS PICKS CADASTRADOS."));
    if (result.withoutAgents && result.withoutAgents.length) {
      box.appendChild(el("p", "draft-explanation",
        `Sem agente cadastrado neste mapa: ${joinList(result.withoutAgents)}.`));
    } else if (result.status === "no-valid") {
      box.appendChild(el("p", "draft-explanation",
        "Todas as combinações repetem algum agente já escolhido."));
    }
    return box;
  }

  const best = result.best;
  const mapName = (getCurrentMap() || {}).name;

  // Topo
  const top = el("div", "draft-top");
  if (result.alternatives.length) top.appendChild(el("p", "draft-badge", "MELHOR COMPOSIÇÃO"));
  top.appendChild(el("h3", "draft-heading", "Sugestão para o trio"));
  box.appendChild(top);

  // Picks sugeridos
  const picks = el("ul", "draft-picks");
  best.picks.forEach((pick) => {
    const li = el("li");
    li.dataset.player = pick.playerId;
    li.appendChild(createImage(getAgentImage(pick.agent), pick.agent, "agent-img", pick.role || undefined));
    li.appendChild(el("span", "draft-player", safeText(pick.playerName).toUpperCase()));
    li.appendChild(el("span", "draft-agent", pick.agent));
    const meta = el("span", "draft-meta");
    const slot = el("span", "slot", SLOT_LABELS[pick.slot].toUpperCase());
    slot.dataset.slot = pick.slot;
    meta.appendChild(slot);
    meta.appendChild(document.createTextNode(" · "));
    const badge = el("span", "role-badge", pick.role || "Função desconhecida");
    if (pick.role) badge.dataset.role = pick.role;
    meta.appendChild(badge);
    li.appendChild(meta);
    const metaText = formatPickMeta(pick.meta);
    if (metaText) li.appendChild(el("span", "draft-meta draft-meta-stats", metaText));
    picks.appendChild(li);
  });
  box.appendChild(picks);

  // Score (comparativo, não é chance de vitória)
  const scorePanel = el("div", "draft-score-panel");
  const score = el("p", "draft-score");
  score.appendChild(el("span", "", "SCORE DE COMPARAÇÃO"));
  score.appendChild(el("span", "draft-score-value", formatScore(best.score)));
  scorePanel.appendChild(score);
  const breakdown = el("ul", "draft-breakdown");
  [["Composição", best.structural.score], ["META", best.meta.score], ["Conforto", best.preference]].forEach(([label, value]) => {
    const li = el("li");
    li.appendChild(el("span", "", label.toUpperCase()));
    li.appendChild(el("b", "", formatSigned(value)));
    breakdown.appendChild(li);
  });
  scorePanel.appendChild(breakdown);
  scorePanel.appendChild(el("p", "draft-note",
    "Score comparativo entre as opções disponíveis. Não representa chance de vitória."));
  box.appendChild(scorePanel);

  // Composição final (externos + trio)
  const comp = el("ul", "draft-comp");
  const compItem = (agent, cls) => {
    const li = el("li", cls);
    li.appendChild(createImage(getAgentImage(agent), agent, "agent-img", resolveAgentRole(agent, mapName) || undefined));
    li.appendChild(document.createTextNode(agent));
    comp.appendChild(li);
  };
  result.externals.forEach((agent) => compItem(agent, "is-external"));
  best.picks.forEach((pick) => compItem(pick.agent, "is-trio"));
  box.appendChild(draftBlock("draft-comp-wrap", "Comp final", comp));
  box.appendChild(draftBlock("draft-roles-wrap", "Funções", renderDraftRoles(best.roleCount)));

  // Explicação (texto do algoritmo, sem mudanças)
  box.appendChild(draftBlock("draft-why", "Por que essa composição?", el("p", "draft-explanation", best.explanation)));

  if (result.alternatives.length) {
    const alts = el("ol", "draft-alts");
    alts.start = 2;
    result.alternatives.forEach((alt, i) => {
      const li = el("li");
      li.appendChild(el("span", "draft-alt-rank", `${i + 2}ª OPÇÃO`));
      li.appendChild(el("span", "draft-alt-score",
        `Score: ${formatScore(alt.score)}${result.metaAvailable ? ` · META ${formatSigned(alt.meta.score)}` : ""}`));
      alt.picks.forEach((pick) => {
        const metaText = formatPickMeta(pick.meta);
        li.appendChild(el("span", "draft-alt-pick",
          `${safeText(pick.playerName)} — ${pickLabel(pick)}${metaText ? ` (${metaText})` : ""}`));
      });
      const lessCritical = alt.criticalCovered < best.criticalCovered
        ? ` · cobre menos funções críticas (${alt.criticalRoles.join(", ") || "nenhuma"})`
        : alt.duelistViaTertiary && alt.score > best.score
          ? " · Duelista só via terciária (não conta no ranking)"
          : "";
      li.appendChild(el("span", "draft-alt-info",
        `Comp: ${alt.agents.join(", ")} · Funções: ${describeRoleCount(alt.roleCount)}${lessCritical}`));
      alts.appendChild(li);
    });
    box.appendChild(draftBlock("draft-alts-wrap", "Outras opções", alts));
  }
  return box;
}

function renderDraft() {
  const mapName = (getCurrentMap() || {}).name;
  fillDraftSelects(mapName);
  const metaStatus = document.getElementById("draft-meta-status");
  metaStatus.textContent = getMetaStatusText(mapName);
  metaStatus.hidden = !metaStatus.textContent;

  document.querySelectorAll(".draft-select").forEach((select, slot) => {
    select.value = state.draft.externals[slot] || "";
  });
  const out = document.getElementById("draft-output");
  out.innerHTML = "";
  if (state.draft.result) out.appendChild(renderDraftSuggestion(state.draft.result));
}

// Partes da página que só aparecem depois que os dados chegam
const DATA_SECTIONS = ["map-select", "board", "map-banner", "players", "actions", "composition-section", "draft-section"];

function renderStatus() {
  const box = document.getElementById("status");
  box.innerHTML = "";
  box.hidden = state.status === "ready";
  DATA_SECTIONS.forEach((id) => {
    document.getElementById(id).hidden = state.status !== "ready";
  });
  if (state.status === "ready") return;

  const message = document.createElement("p");
  message.className = "status-message";
  box.appendChild(message);

  if (state.status === "loading") {
    message.textContent = "CARREGANDO PICKS...";
    return;
  }

  message.textContent = "NÃO FOI POSSÍVEL CARREGAR OS PICKS.";

  // Aberto com duplo clique: o Google bloqueia a leitura (CORS) para file://
  if (location.protocol === "file:") {
    const hint = document.createElement("p");
    hint.className = "status-hint";
    hint.textContent =
      "Abra a página por um servidor local (ex.: python -m http.server) ou pelo site publicado, não direto do arquivo.";
    box.appendChild(hint);
  }

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-primary";
  retry.id = "retry-btn";
  retry.textContent = "TENTAR NOVAMENTE";
  retry.addEventListener("click", loadData);
  box.appendChild(retry);
}

function render() {
  renderStatus();
  if (state.status !== "ready") return;
  renderHeaderArt();
  renderMapSelect();
  renderMapBanner();
  renderPlayers();
  renderComposition();
  renderDraft();
}

/* =========================================================
   INICIALIZAÇÃO
   ========================================================= */
let loading = false;
let metaLoading = false;

// META é independente: se falhar, o site segue sem bônus de META
async function loadMeta() {
  if (metaLoading || META.status === "ready") return;
  metaLoading = true;
  META.status = "loading";
  if (state.status === "ready") renderDraft();
  try {
    const meta = await fetchMeta();
    META.byMap = meta.byMap;
    META.rows = meta.rows;
    META.issues = meta.issues;
    META.status = "ready";
    if (meta.issues.length) console.warn("Inconsistências na planilha META:", meta.issues);
  } catch (err) {
    console.warn("Falha ao carregar a META:", err);
    META.status = "error";
  } finally {
    metaLoading = false;
  }
  if (state.status !== "ready") return;
  // Sugestão feita antes da META chegar é recalculada com os novos dados
  if (state.draft.result) runDraftSuggestion();
  render();
}

async function loadData() {
  if (loading) return;
  loading = true;
  state.status = "loading";
  if (META.status === "error") loadMeta(); // TENTAR NOVAMENTE também tenta a META
  render();
  try {
    const data = await fetchSheet();
    PLAYERS = data.players;
    MAPS = data.maps;
    // Mantém o mapa selecionado se ele ainda existir na planilha
    if (!MAPS.some((m) => m.id === state.mapId)) state.mapId = MAPS[0].id;
    state.swapped = {};
    resetDraft();
    state.status = "ready";
  } catch (err) {
    console.warn("Falha ao carregar a planilha:", err);
    state.status = "error";
  } finally {
    loading = false;
  }
  render();
}

document.getElementById("restore-btn").addEventListener("click", restorePicks);
document.querySelectorAll(".draft-select").forEach((select, slot) => {
  select.addEventListener("change", () => setExternalAgent(slot, select.value));
});
document.getElementById("draft-btn").addEventListener("click", runDraftSuggestion);
loadMeta();
loadData();
