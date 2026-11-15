/* Skill Tree — an RPG-style skill tree built from your notes (plain JS, no bundler) */
const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, TFolder, debounce, normalizePath, moment } = require("obsidian");

const VIEW_TYPE = "skill-tree-view";
const MAP = "__map__";
const DEFAULT_SETTINGS = { folder: "Skills", mapFile: "Map.md" };

const NODE_W = 170;
const NODE_H = 44;
const GAP_X = 24;
const LEVEL_H = 110;

const TASK_STATUS = { "x": "known", "X": "known", "/": "learning", ">": "want", " ": "locked", "*": "mastered" };
const REQ_RE = /^(требует|requires)::\s*(.+)$/i;

/* ---------- i18n ---------- */

const STRINGS = {
  en: {
    mastered: "⭐ mastered", known: "✅ known", learning: "🔥 learning", want: "✨ want", locked: "🔒 locked", branch: "branch",
    available: "🔓 available", wantAvailable: "✨ want · available",
    map: "🗺 Map", view: "View", up: "▲ up", radial: "◎ star", vertical: "↓ top-down", horizontal: "→ left-right",
    all: "All", grouped: "By group", fit: "⤢ fit",
    noFolder: (f) => `No branch folders in “${f}” yet.`, noNodes: "No notes with type: branch in this folder.",
    createExample: "Create example tree", exampleCreated: (f) => `Example tree created in ${f}`,
    exampleExists: (f) => `${f} already exists`,
    requires: "Requires:", requiresAny: "Requires one of:", and: "  and  ", or: "  or  ",
    unnamed: "(unnamed)", me: "Me",
    cmdOpen: "Open", cmdExample: "Create example tree",
    setFolder: "Skills folder", setFolderDesc: "Each subfolder is a branch; each note inside it with type: branch is a constellation.",
    setMap: "Map file", setMapDesc: "Note inside the skills folder with the map center and legendary skills.",
  },
  ru: {
    mastered: "⭐ мастер", known: "✅ умею", learning: "🔥 качаю", want: "✨ хочу", locked: "🔒 закрыт", branch: "ветка",
    available: "🔓 доступно", wantAvailable: "✨ хочу · доступно",
    map: "🗺 Карта", view: "Вид", up: "▲ вверх", radial: "◎ звезда", vertical: "↓ сверху", horizontal: "→ слева",
    all: "Все", grouped: "По группам", fit: "⤢ вписать",
    noFolder: (f) => `В «${f}» пока нет папок-веток.`, noNodes: "В этой папке нет заметок с type: branch.",
    createExample: "Создать пример дерева", exampleCreated: (f) => `Пример создан в ${f}`,
    exampleExists: (f) => `${f} уже существует`,
    requires: "Требует:", requiresAny: "Требует одно из:", and: "  и  ", or: "  или  ",
    unnamed: "(без имени)", me: "Я",
    cmdOpen: "Открыть", cmdExample: "Создать пример дерева",
    setFolder: "Папка навыков", setFolderDesc: "Каждая подпапка — ветка, каждая заметка в ней с type: branch — созвездие.",
    setMap: "Файл карты", setMapDesc: "Заметка в папке навыков с центром карты и легендарными навыками.",
  },
};
const lang = () => {
  const l = (moment && moment.locale && moment.locale()) || "en";
  return STRINGS[l.slice(0, 2)] ? l.slice(0, 2) : "en";
};
const t = (key, ...args) => {
  const v = STRINGS[lang()][key] ?? STRINGS.en[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
};

/* ---------- graph building ---------- */

async function buildGraph(app, folderPath) {
  const nodes = new Map(); // id -> node
  const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folderPath + "/"));

  const addNode = (n) => { n.parents = n.parents || []; nodes.set(n.id, n); return n; };

  // 1) notes with type: skill | branch
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache && cache.frontmatter;
    if (!fm || (fm.type !== "skill" && fm.type !== "branch")) continue;
    addNode({
      id: file.path,
      name: file.basename,
      desc: fm.description || "",
      status: fm.status || (fm.type === "branch" ? "branch" : "locked"),
      kind: fm.type,
      file, line: null,
    });
  }

  // 2) parent links from frontmatter (requires / parent)
  for (const file of files) {
    const node = nodes.get(file.path);
    if (!node) continue;
    const cache = app.metadataCache.getFileCache(file);
    const links = (cache.frontmatterLinks || [])
      .filter(l => l.key.startsWith("requires") || l.key.startsWith("parent"));
    for (const l of links) {
      const dest = app.metadataCache.getFirstLinkpathDest(l.link, file.path);
      if (dest && nodes.has(dest.path) && !node.parents.includes(dest.path)) node.parents.push(dest.path);
    }
  }

  // 3) hybrid: task list items inside branch notes
  for (const file of files) {
    const branch = nodes.get(file.path);
    if (!branch || branch.kind !== "branch") continue;
    const cache = app.metadataCache.getFileCache(file);
    const entries = [
      ...(cache.headings || []).map(h => ({ h, line: h.position.start.line })),
      ...(cache.listItems || []).map(item => ({ item, line: item.position.start.line })),
    ].sort((a, b) => a.line - b.line);
    if (!entries.length) continue;
    const lines = (await app.vault.cachedRead(file)).split("\n");
    const byLine = new Map(); // list line -> owning node id
    const sections = [];      // heading stack: {level, id}
    const currentSection = () => (sections.length ? sections[sections.length - 1].id : branch.id);

    for (const entry of entries) {
      const line = entry.line;

      // heading = section (sub-branch); a heading equal to the file name is the file itself
      if (entry.h) {
        const { heading, level } = entry.h;
        while (sections.length && sections[sections.length - 1].level >= level) sections.pop();
        if (heading.trim() === file.basename) continue;
        const id = `${file.path}#H${line}`;
        addNode({ id, name: heading.trim(), desc: "", status: "branch", kind: "section", file, line, parents: [currentSection()] });
        sections.push({ level, id });
        continue;
      }

      const item = entry.item;
      const parentId = item.parent >= 0 && byLine.has(item.parent) ? byLine.get(item.parent) : currentSection();

      // plain bullet (no checkbox) = description / notes of the skill above it
      if (item.task === undefined) {
        const text = (lines[line] || "").replace(/^\s*[-*+]\s+/, "").trim();
        const owner = nodes.get(parentId);
        const req = text.match(REQ_RE);
        if (req && owner) owner.reqText = req[2];
        else if (text && owner) {
          if (!owner.desc) owner.desc = text;
          else (owner.extra = owner.extra || []).push(text);
        }
        byLine.set(line, parentId);
        continue;
      }

      const raw = (lines[line] || "").replace(/^\s*[-*+]\s+\[.\]\s*/, "").trim();

      // item that is just a link to its own skill note -> reuse that note
      const linkOnly = raw.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
      if (linkOnly) {
        const dest = app.metadataCache.getFirstLinkpathDest(linkOnly[1], file.path);
        if (dest && nodes.has(dest.path)) {
          const target = nodes.get(dest.path);
          if (!target.parents.includes(parentId)) target.parents.push(parentId);
          byLine.set(line, target.id);
          continue;
        }
      }

      const [name, ...rest] = raw.split(/\s+[—–-]\s+/);
      const id = `${file.path}#L${line}`;
      addNode({
        id,
        name: name.replace(/\[\[|\]\]/g, "").trim() || t("unnamed"),
        desc: rest.join(" — ").trim(),
        status: TASK_STATUS[item.task] || "locked",
        kind: "item",
        file, line,
        section: currentSection(),
        parents: [parentId],
      });
      byLine.set(line, id);
    }
  }

  // 4) requirements: "требует:: A & B" (all) or "A | B" (any), by node name
  const byName = new Map();
  for (const n of nodes.values()) byName.set(n.name.toLowerCase(), n.id);
  for (const n of nodes.values()) {
    if (!n.reqText) continue;
    const op = n.reqText.includes("|") ? "or" : "and";
    const names = n.reqText.split(op === "or" ? /\s*\|\s*/ : /\s*[&,]\s*/)
      .map(s => s.replace(/\[\[|\]\]/g, "").trim()).filter(Boolean);
    const ids = names.map(s => byName.get(s.toLowerCase())).filter(id => id && id !== n.id);
    n.reqs = { op, ids, missing: names.filter(s => !byName.has(s.toLowerCase())) };
    // a flat item hangs under its first requirement from the same section;
    // cross-section requirements are only shown on hover
    const parent = nodes.get(n.parents[0]);
    const local = ids.find(id => nodes.get(id).section === n.section);
    if (local && (!parent || parent.kind === "branch" || parent.kind === "section")) n.parents = [local];
  }

  return nodes;
}

const isDone = (s) => s === "known" || s === "mastered";
const isGroup = (n) => !n || n.kind === "branch" || n.kind === "section" || n.kind === "virtual";

function reqsMet(n, all) {
  if (n.reqs && n.reqs.ids.length) {
    const ok = n.reqs.ids.map(id => isDone(all.get(id).status));
    return n.reqs.op === "or" ? ok.some(Boolean) : ok.every(Boolean);
  }
  const p = all.get(n.parents[0]);
  return isGroup(p) || isDone(p.status);
}

/* ---------- main map: all branches + legendary skills ---------- */

async function buildMap(app, rootFolder, mapPath, branchNames) {
  const branches = [];
  const global = new Map(); // lower name -> [{branch, conId, node}]

  for (const b of branchNames) {
    const nodes = await buildGraph(app, `${rootFolder}/${b}`);
    const roots = [...nodes.values()].filter(n => !n.parents.length);
    const root = roots.length === 1 ? roots[0] : null;
    const cons = root ? [...nodes.values()].filter(n => n.parents[0] === root.id && isGroup(n)) : roots;

    const conOf = (n) => {
      const seen = new Set();
      let cur = n;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        const p = nodes.get(cur.parents[0]);
        if (!p) return root ? null : cur.id;
        if (p === root) return cur.id;
        cur = p;
      }
      return null;
    };

    const stat = () => ({ total: 0, done: 0, learning: 0 });
    const branchStat = stat();
    const conStats = new Map(cons.map(c => [c.id, stat()]));
    for (const n of nodes.values()) {
      if (isGroup(n)) continue;
      const cid = conOf(n);
      for (const s of [branchStat, conStats.get(cid)]) {
        if (!s) continue;
        s.total++;
        if (isDone(n.status)) s.done++;
        else if (n.status === "learning") s.learning++;
      }
      const key = n.name.toLowerCase();
      if (!global.has(key)) global.set(key, []);
      global.get(key).push({ branch: b, conId: cid, node: n });
    }
    branches.push({ name: b, root, stats: branchStat, cons: cons.map(c => ({ node: c, stats: conStats.get(c.id) })) });
  }

  // map file: center label + legendary skills
  const mapFile = app.vault.getAbstractFileByPath(mapPath);
  let center = t("me");
  const legendary = [];
  if (mapFile instanceof TFile) {
    const cache = app.metadataCache.getFileCache(mapFile) || {};
    if (cache.frontmatter && cache.frontmatter.center) center = String(cache.frontmatter.center);
    const lines = (await app.vault.cachedRead(mapFile)).split("\n");
    const items = (cache.listItems || []).slice().sort((a, b) => a.position.start.line - b.position.start.line);
    let cur = null;
    for (const item of items) {
      const line = item.position.start.line;
      if (item.task !== undefined && item.parent < 0) {
        const raw = (lines[line] || "").replace(/^\s*[-*+]\s+\[.\]\s*/, "").trim();
        cur = { name: raw, status: TASK_STATUS[item.task] || "locked", desc: "", extra: [], reqText: "", line };
        legendary.push(cur);
      } else if (item.task === undefined && cur) {
        const text = (lines[line] || "").replace(/^\s*[-*+]\s+/, "").trim();
        const req = text.match(REQ_RE);
        if (req) cur.reqText = req[2];
        else if (!cur.desc) cur.desc = text;
        else cur.extra.push(text);
      }
    }
  }

  const resolve = (raw) => {
    const name = raw.replace(/\[\[|\]\]/g, "").trim();
    const q = name.match(/^([^:]+):(.+)$/);
    if (q && branchNames.includes(q[1].trim())) {
      const hit = (global.get(q[2].trim().toLowerCase()) || []).find(h => h.branch === q[1].trim());
      return { name: q[2].trim(), hit };
    }
    return { name, hit: (global.get(name.toLowerCase()) || [])[0] };
  };

  for (const L of legendary) {
    L.op = L.reqText.includes("|") ? "or" : "and";
    L.reqList = L.reqText ? L.reqText.split(L.op === "or" ? /\s*\|\s*/ : /\s*&\s*/).filter(Boolean).map(s => {
      const { name, hit } = resolve(s);
      return hit
        ? { name: hit.node.name, branch: hit.branch, conId: hit.conId, done: isDone(hit.node.status) }
        : { name, missing: true, done: false };
    }) : [];
    const ok = L.reqList.map(r => r.done);
    const met = L.reqList.length > 0 && (L.op === "or" ? ok.some(Boolean) : ok.every(Boolean));
    L.available = met && (L.status === "locked" || L.status === "want");
  }

  return { branches, legendary, center, mapFile: mapFile instanceof TFile ? mapFile : null };
}

function mapLayout(data, mode = "radial") {
  const B = Math.max(1, data.branches.length);
  const R1 = 280, R2 = 600;
  const nodes = [], edges = [];
  const center = { id: "map:center", name: data.center, kind: "center", status: "branch", x: 0, y: 0, r: 30, file: data.mapFile, line: null };
  nodes.push(center);
  const branchPos = new Map();

  // tree modes: every constellation gets a slot, branch sits over its slots, center over everything
  const totalSlots = data.branches.reduce((a, b) => a + Math.max(1, b.cons.length), 0);
  const place = (slot, depth) => {
    const s = slot - (totalSlots - 1) / 2;
    if (mode === "up") return { x: s * 130, y: -depth * 220 };
    if (mode === "vertical") return { x: s * 130, y: depth * 220 };
    if (mode === "horizontal") return { x: depth * 320, y: s * 52 };
    return null;
  };
  let slot = 0;

  data.branches.forEach((b, i) => {
    const k = b.cons.length;
    const first = slot;
    slot += Math.max(1, k);
    const a = (i / B) * 2 * Math.PI - Math.PI / 2;
    // up / down: each branch is a column, its constellations stacked above (below) it
    const column = mode === "up" || mode === "vertical";
    const sgn = mode === "up" ? -1 : 1;
    const colX = (i - (B - 1) / 2) * 190;
    const bp = column ? { x: colX, y: sgn * 220 }
      : place((first + slot - 1) / 2, 1) || { x: Math.cos(a) * R1, y: Math.sin(a) * R1 };
    const bn = {
      id: `map:b:${b.name}`, name: b.name, desc: b.root ? b.root.desc : "", kind: "map-branch", status: "branch",
      x: bp.x, y: bp.y, r: 24, stats: b.stats, go: { branch: b.name },
    };
    nodes.push(bn); edges.push([center, bn]); branchPos.set(b.name, bn);
    const spread = (2 * Math.PI / B) * 0.55;
    b.cons.forEach((c, j) => {
      const ca = a + (k > 1 ? (j - (k - 1) / 2) * (spread / (k - 1)) : 0);
      const r = R2 + (j % 2) * 70;
      const cp = column ? { x: colX + (j % 2 ? 40 : -40), y: sgn * (340 + j * 85) }
        : place(first + j, 2) || { x: Math.cos(ca) * r, y: Math.sin(ca) * r };
      const cn = {
        id: `map:c:${b.name}:${c.node.id}`, name: c.node.name, desc: c.node.desc, kind: "map-con", status: "branch",
        x: cp.x, y: cp.y, r: 14, stats: c.stats, go: { branch: b.name, constellation: c.node.id },
      };
      nodes.push(cn); edges.push([bn, cn]);
    });
  });

  // legendary: in between the branches they draw from
  data.legendary.forEach((L, idx) => {
    const from = [...new Set(L.reqList.filter(r => r.branch).map(r => r.branch))].map(n => branchPos.get(n)).filter(Boolean);
    let x = 0, y = 0;
    from.forEach(p => { x += p.x; y += p.y; });
    if (from.length) { x /= from.length; y /= from.length; }
    const c0 = { x, y };
    // far out, beyond the leaves, on the side of the branches it draws from
    const near = (gap) => nodes.some(o => o.kind === "legendary" && Math.hypot(o.x - x, o.y - y) < gap);
    if (mode === "up" || mode === "vertical") {
      const maxK = Math.max(1, ...data.branches.map(b => b.cons.length));
      y = (mode === "up" ? -1 : 1) * (340 + (maxK - 1) * 85 + 170);
      for (let t = 0; t < 12 && near(170); t++) x += 175;
    } else if (mode === "horizontal") {
      x = 3 * 320;
      for (let t = 0; t < 12 && near(70); t++) y += 70;
    } else {
      let ang = Math.hypot(x, y) > 1 ? Math.atan2(y, x) : (idx / Math.max(1, data.legendary.length)) * 2 * Math.PI;
      const RL = R2 + 70 + 230;
      x = Math.cos(ang) * RL; y = Math.sin(ang) * RL;
      for (let t = 0; t < 12 && near(170); t++) {
        ang += 0.2;
        x = Math.cos(ang) * RL; y = Math.sin(ang) * RL;
      }
    }
    const hl = new Map();
    for (const r of L.reqList) {
      if (!r.branch) continue;
      const id = r.conId ? `map:c:${r.branch}:${r.conId}` : `map:b:${r.branch}`;
      hl.set(id, (hl.has(id) ? hl.get(id) : true) && r.done);
    }
    nodes.push({
      id: `map:l:${L.line}`, name: L.name, desc: L.desc, extra: L.extra, kind: "legendary", status: L.status,
      available: L.available, x, y, c0, r: 17, reqList: L.reqList, op: L.op, highlight: [...hl], file: data.mapFile, line: L.line,
    });
  });
  // tree modes: spread the legendary row evenly across the crown, keeping their order
  if (mode !== "radial") {
    const leg = nodes.filter(n => n.kind === "legendary");
    const axis = mode === "horizontal" ? "y" : "x";
    const others = nodes.filter(n => n.kind === "map-con").map(n => n[axis]);
    if (leg.length > 1 && others.length) {
      const lo = Math.min(...others), hi = Math.max(...others);
      leg.sort((a, b) => a.c0[axis] - b.c0[axis]).forEach((n, i) => { n[axis] = lo + ((i + 0.5) / leg.length) * (hi - lo); });
    }
  }
  return { nodes, edges };
}

/* ---------- layout: BFS spanning tree + tidy x ---------- */

function layout(nodes, rootName, mode = "radial") {
  const children = new Map();
  for (const id of nodes.keys()) children.set(id, []);
  for (const n of nodes.values()) for (const p of n.parents) children.get(p).push(n.id);

  let roots = [...nodes.values()].filter(n => n.parents.length === 0).map(n => n.id);
  const VROOT = "__root__";
  const placed = new Map(); // id -> {treeParent, depth}
  const treeKids = new Map();

  const bfs = (starts, depth0) => {
    const q = starts.map(id => [id, depth0]);
    for (const [id] of q) if (!placed.has(id)) placed.set(id, { depth: depth0 });
    while (q.length) {
      const [id, d] = q.shift();
      treeKids.set(id, treeKids.get(id) || []);
      for (const c of children.get(id) || []) {
        if (placed.has(c)) continue;
        placed.set(c, { depth: d + 1, treeParent: id });
        treeKids.get(id).push(c);
        q.push([c, d + 1]);
      }
    }
  };

  let virtual = null;
  if (roots.length !== 1) {
    virtual = { id: VROOT, name: rootName, desc: "", status: "branch", kind: "virtual", parents: [] };
    bfs(roots, 1);
    // anything unreachable (cycles) hangs off the virtual root
    const orphans = [...nodes.keys()].filter(id => !placed.has(id));
    if (orphans.length) bfs(orphans, 1);
    placed.set(VROOT, { depth: 0 });
    treeKids.set(VROOT, [...roots, ...orphans]);
    roots = [VROOT];
  } else {
    bfs(roots, 0);
    const orphans = [...nodes.keys()].filter(id => !placed.has(id));
    if (orphans.length) {
      bfs(orphans, 1);
      for (const o of orphans) treeKids.get(roots[0]).push(o);
    }
  }

  // leaves get consecutive slots, parents sit in the middle of their kids
  const slot = new Map();
  let leaves = 0, maxDepth = 0;
  const assign = (id) => {
    const kids = treeKids.get(id) || [];
    maxDepth = Math.max(maxDepth, placed.get(id).depth);
    if (!kids.length) { slot.set(id, leaves++); return; }
    kids.forEach(assign);
    slot.set(id, (slot.get(kids[0]) + slot.get(kids[kids.length - 1])) / 2);
  };
  roots.forEach(assign);

  // positions are node centers
  const pos = new Map();
  const ring = Math.max(170, (90 * leaves) / (2 * Math.PI * Math.max(1, maxDepth)));
  for (const [id, s] of slot) {
    const d = placed.get(id).depth;
    if (mode === "up") pos.set(id, { x: s * 175, y: -d * 120 });
    else if (mode === "vertical") pos.set(id, { x: s * (NODE_W + GAP_X), y: d * LEVEL_H });
    else if (mode === "horizontal") pos.set(id, { x: d * (NODE_W + 80), y: s * (NODE_H + 14) });
    else {
      const a = (s / Math.max(1, leaves)) * 2 * Math.PI - Math.PI / 2;
      pos.set(id, { x: Math.cos(a) * d * ring, y: Math.sin(a) * d * ring });
    }
  }

  const all = new Map(nodes);
  if (virtual) all.set(VROOT, virtual);

  const edges = [];
  for (const n of all.values()) {
    for (const p of n.parents) {
      const primary = placed.get(n.id) && placed.get(n.id).treeParent === p;
      edges.push({ from: p, to: n.id, primary });
    }
  }
  if (virtual) for (const r of treeKids.get(VROOT)) {
    if (!nodes.get(r).parents.length) edges.push({ from: VROOT, to: r, primary: true });
  }
  return { all, pos, edges };
}

/* ---------- view ---------- */

const setVars = (el, vars) => {
  if (el.setCssProps) el.setCssProps(vars);
  else for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
};

class SkillTreeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const saved = plugin.state || {};
    this.branch = saved.branch || null;
    this.mode = saved.mode || "up";
    this.constellation = saved.constellation || null;
    this.grouped = saved.grouped !== undefined ? saved.grouped : true;
    this.view = { x: 0, y: 0, k: 1 };
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Skill Tree"; }
  getIcon() { return "git-fork"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("st-root");
    this.toolbar = root.createDiv("st-toolbar");
    this.viewbar = root.createDiv("st-toolbar st-viewbar");
    this.subbar = root.createDiv("st-toolbar st-subbar");
    this.canvas = root.createDiv("st-canvas");
    this.tooltip = root.createDiv("st-tooltip");
    this.tooltip.hide();

    this.registerEvent(this.app.metadataCache.on("changed", debounce(() => this.render(false), 400, true)));
    this.registerEvent(this.app.vault.on("rename", debounce(() => this.render(true), 400, true)));
    this.app.workspace.onLayoutReady(() => this.render(true));
  }

  get root() { return this.plugin.rootFolder(); }

  branches() {
    const f = this.app.vault.getAbstractFileByPath(this.root);
    if (!(f instanceof TFolder)) return [];
    return f.children.filter(c => c instanceof TFolder).map(c => c.name).sort();
  }

  renderEmpty() {
    for (const el of [this.toolbar, this.viewbar, this.subbar, this.canvas]) el.empty();
    this.viewbar.hide(); this.subbar.hide();
    const box = this.canvas.createDiv("st-empty");
    box.createEl("p", { text: t("noFolder", this.root) });
    const btn = box.createEl("button", { text: t("createExample"), cls: "mod-cta" });
    btn.onclick = () => this.plugin.createExample();
  }

  renderToolbar() {
    this.toolbar.empty();
    const list = this.branches();
    if (!list.length) { this.branch = null; return false; }
    this.viewbar.show();
    if (!list.includes(this.branch) && this.branch !== MAP) this.branch = MAP;
    const mapBtn = this.toolbar.createEl("button", { text: t("map"), cls: this.branch === MAP ? "mod-cta" : "" });
    mapBtn.onclick = () => { this.branch = MAP; this.render(true); };
    for (const b of list) {
      const btn = this.toolbar.createEl("button", { text: b, cls: b === this.branch ? "mod-cta" : "" });
      btn.onclick = () => { this.branch = b; this.render(true); };
    }
    // view row: layout modes + fit
    this.viewbar.empty();
    this.viewbar.createSpan({ cls: "st-bar-label", text: t("view") });
    for (const m of ["up", "radial", "vertical", "horizontal"]) {
      const btn = this.viewbar.createEl("button", { text: t(m), cls: m === this.mode ? "mod-cta" : "" });
      btn.onclick = () => { this.mode = m; this.render(true); };
    }
    if (this.branch !== MAP) {
      this.viewbar.createSpan({ cls: "st-bar-sep" });
      for (const [g, label] of [[false, t("all")], [true, t("grouped")]]) {
        const btn = this.viewbar.createEl("button", { text: label, cls: g === this.grouped ? "mod-cta" : "" });
        btn.onclick = () => { this.grouped = g; this.render(true); };
      }
    }
    const fit = this.viewbar.createEl("button", { text: t("fit"), cls: "st-fit" });
    fit.onclick = () => this.fit();
    return true;
  }

  async render(refit) {
    this.viewbar.empty();
    if (!this.renderToolbar()) return this.renderEmpty();
    if (this.branch === MAP) return this.renderMap(refit);
    const nodes = await buildGraph(this.app, `${this.root}/${this.branch}`);
    this.canvas.empty();
    if (!nodes.size) { this.subbar.hide(); this.canvas.createDiv({ cls: "st-empty", text: t("noNodes") }); return; }

    // "by groups": one constellation (child group of the root) at a time, like Skyrim
    let shown = nodes;
    this.subbar.empty();
    this.subbar.toggle(this.grouped);
    if (this.grouped) {
      const roots = [...nodes.values()].filter(n => !n.parents.length);
      const cons = roots.length === 1
        ? [...nodes.values()].filter(n => n.parents[0] === roots[0].id && isGroup(n))
        : roots;
      if (cons.length) {
        if (!cons.some(c => c.id === this.constellation)) this.constellation = cons[0].id;
        for (const c of cons) {
          const btn = this.subbar.createEl("button", { text: c.name, cls: c.id === this.constellation ? "mod-cta" : "" });
          btn.onclick = () => { this.constellation = c.id; this.render(true); };
        }
        const keep = new Set([this.constellation]);
        for (let grew = true; grew;) {
          grew = false;
          for (const n of nodes.values()) {
            if (!keep.has(n.id) && keep.has(n.parents[0])) { keep.add(n.id); grew = true; }
          }
        }
        shown = new Map([...keep].map(id => {
          const n = nodes.get(id);
          return [id, { ...n, parents: n.parents.filter(p => keep.has(p)) }];
        }));
      }
    }

    this.persist();
    const { all, pos, edges } = layout(shown, this.branch, this.mode);
    const lookup = new Map(all);
    for (const [k, v] of nodes) if (!lookup.has(k)) lookup.set(k, v);
    const radial = this.mode === "radial" || this.mode === "up";
    const R = (n) => (n.kind === "virtual" || (n.kind === "branch" && !n.parents.length) ? 26 : isGroup(n) ? 20 : 13);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.addClass("st-svg");
    const g = document.createElementNS(NS, "g");
    svg.appendChild(g);
    this.svg = svg; this.g = g;

    // edges
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      let d;
      if (radial) d = `M${a.x},${a.y} L${b.x},${b.y}`;
      else if (this.mode === "horizontal") {
        const x1 = a.x + NODE_W / 2, x2 = b.x - NODE_W / 2, mx = (x1 + x2) / 2;
        d = `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
      } else {
        const y1 = a.y + NODE_H / 2, y2 = b.y - NODE_H / 2, my = (y1 + y2) / 2;
        d = `M${a.x},${y1} C${a.x},${my} ${b.x},${my} ${b.x},${y2}`;
      }
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "st-edge" + (e.primary ? "" : " st-edge-extra") + ` st-edge-${all.get(e.to).status}`);
      g.appendChild(path);
    }

    // nodes
    this.all = lookup;
    this.els = new Map();
    for (const n of all.values()) {
      const p = pos.get(n.id);
      if (!p) continue;
      n.available = !isGroup(n) && (n.status === "locked" || n.status === "want") && reqsMet(n, lookup);
      const ng = document.createElementNS(NS, "g");
      this.els.set(n.id, ng);
      ng.setAttribute("class", `st-node st-${n.status} st-kind-${n.kind}` + (n.available ? " st-available" : ""));
      ng.setAttribute("transform", `translate(${p.x},${p.y})`);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "central");
      if (radial) {
        // star: circle + label underneath
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", R(n));
        ng.appendChild(c);
        text.setAttribute("y", R(n) + 12);
        text.setAttribute("class", "st-label");
        text.textContent = n.name;
      } else {
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", -NODE_W / 2); rect.setAttribute("y", -NODE_H / 2);
        rect.setAttribute("width", NODE_W); rect.setAttribute("height", NODE_H);
        rect.setAttribute("rx", n.kind === "item" ? 22 : 8);
        ng.appendChild(rect);
        text.textContent = n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name;
      }
      ng.appendChild(text);

      ng.addEventListener("mouseenter", (ev) => { this.showTip(n, ev); this.highlight(n, true); });
      ng.addEventListener("mousemove", (ev) => this.moveTip(ev));
      ng.addEventListener("mouseleave", () => { this.tooltip.hide(); this.highlight(n, false); });
      ng.addEventListener("click", (ev) => { ev.stopPropagation(); this.openNode(n); });
      g.appendChild(ng);
    }

    this.canvas.appendChild(svg);
    this.bounds = this.computeBounds(pos);
    this.bindPanZoom();
    if (refit || !this.fitted) this.fit(); else this.apply();
  }

  async renderMap(refit) {
    this.subbar.empty();
    this.subbar.hide();
    this.persist();
    const data = await buildMap(this.app, this.root, this.plugin.mapPath(), this.branches());
    const mode = this.mode;
    const { nodes, edges } = mapLayout(data, mode);
    this.canvas.empty();

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.addClass("st-svg");
    const g = document.createElementNS(NS, "g");
    svg.appendChild(g);
    this.svg = svg; this.g = g;
    this.els = new Map();
    this.all = new Map(nodes.map(n => [n.id, n]));

    for (const [a, b] of edges) {
      const line = document.createElementNS(NS, "path");
      let d = `M${a.x},${a.y} L${b.x},${b.y}`;
      if (mode === "horizontal") {
        const mx = (a.x + b.x) / 2;
        d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      } else if (mode === "up" || mode === "vertical") {
        const my = (a.y + b.y) / 2;
        d = `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
      }
      line.setAttribute("d", d);
      line.setAttribute("class", "st-edge");
      g.appendChild(line);
    }

    for (const n of nodes) {
      const ng = document.createElementNS(NS, "g");
      this.els.set(n.id, ng);
      const cls = n.kind === "legendary" ? `st-${n.status}` : "st-branch";
      ng.setAttribute("class", `st-node st-map-${n.kind} ${cls}` + (n.available ? " st-available" : ""));
      ng.setAttribute("transform", `translate(${n.x},${n.y})`);
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", n.r);
      if (n.stats && n.stats.total) {
        // brighter = more skills you already have (st-p-0 … st-p-10)
        const p = (n.stats.done + 0.5 * n.stats.learning) / n.stats.total;
        ng.addClass(`st-p-${Math.round(p * 10)}`);
      }
      ng.appendChild(c);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("dominant-baseline", "central");
      if (mode === "horizontal" && n.kind === "map-con") {
        text.setAttribute("text-anchor", "start");
        text.setAttribute("x", n.r + 8);
      } else {
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("y", n.r + 12);
      }
      text.setAttribute("class", "st-label");
      text.textContent = n.name;
      ng.appendChild(text);

      ng.addEventListener("mouseenter", (ev) => { this.showTip(n, ev); this.highlight(n, true); });
      ng.addEventListener("mousemove", (ev) => this.moveTip(ev));
      ng.addEventListener("mouseleave", () => { this.tooltip.hide(); this.highlight(n, false); });
      ng.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.tooltip.hide();
        if (n.go) {
          this.branch = n.go.branch;
          if (n.go.constellation) { this.constellation = n.go.constellation; this.grouped = true; }
          this.render(true);
        } else this.openNode(n);
      });
      g.appendChild(ng);
    }

    this.canvas.appendChild(svg);
    this.bounds = this.computeBounds(new Map(nodes.map(n => [n.id, n])));
    this.bindPanZoom();
    if (refit || !this.fitted) this.fit(); else this.apply();
  }

  // remember last opened branch / layout / constellation
  persist() {
    const next = { branch: this.branch, mode: this.mode, constellation: this.constellation, grouped: this.grouped };
    const prev = this.plugin.state || {};
    if (Object.keys(next).every(k => prev[k] === next[k])) return;
    this.plugin.state = next;
    this.plugin.save();
  }

  computeBounds(pos) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x - NODE_W / 2); minY = Math.min(minY, p.y - NODE_H / 2);
      maxX = Math.max(maxX, p.x + NODE_W / 2); maxY = Math.max(maxY, p.y + NODE_H / 2);
    }
    return { minX, minY, maxX, maxY };
  }

  fit() {
    if (!this.bounds) return;
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
    const b = this.bounds, pad = 40;
    const k = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY), 1.5);
    this.view.k = k;
    this.view.x = (w - (b.maxX - b.minX) * k) / 2 - b.minX * k;
    this.view.y = pad - b.minY * k;
    this.fitted = true;
    this.apply();
  }

  apply() {
    if (this.g) this.g.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  bindPanZoom() {
    const svg = this.svg;
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".st-node")) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      svg.setPointerCapture(e.pointerId);
      svg.addClass("is-dragging");
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.view.x = drag.vx + (e.clientX - drag.x);
      this.view.y = drag.vy + (e.clientY - drag.y);
      this.apply();
    });
    const end = () => { drag = null; svg.removeClass("is-dragging"); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.min(3, Math.max(0.15, this.view.k * Math.exp(-e.deltaY * 0.0015)));
      this.view.x = mx - (mx - this.view.x) * (k2 / this.view.k);
      this.view.y = my - (my - this.view.y) * (k2 / this.view.k);
      this.view.k = k2;
      this.apply();
    }, { passive: false });
  }

  highlight(n, on) {
    if (!this.svg) return;
    this.svg.toggleClass("st-hovering", on);
    const self = this.els.get(n.id);
    if (self) self.toggleClass("st-hover", on);
    const targets = n.highlight || (n.reqs ? n.reqs.ids.map(id => [id, isDone(this.all.get(id).status)]) : []);
    for (const [id, met] of targets) {
      const el = this.els.get(id);
      if (!el) continue;
      el.toggleClass("st-req", on);
      el.toggleClass("st-req-met", on && met);
    }
  }

  showTip(n, ev) {
    this.tooltip.empty();
    this.tooltip.createDiv({ cls: "st-tip-name", text: n.name });
    const status = n.available
      ? (n.status === "want" ? t("wantAvailable") : t("available"))
      : t(n.status);
    this.tooltip.createDiv({ cls: `st-tip-status st-tip-${n.status}`, text: status });
    if (n.desc) this.tooltip.createDiv({ cls: "st-tip-desc", text: n.desc });
    if (n.stats) {
      const s = n.stats;
      this.tooltip.createDiv({ cls: "st-tip-req", text: `✅ ${s.done} · 🔥 ${s.learning} · 🔒 ${s.total - s.done - s.learning}` });
    }
    if (n.reqList && n.reqList.length) {
      const box = this.tooltip.createDiv({ cls: "st-tip-req", text: n.op === "or" ? t("requiresAny") : t("requires") });
      const ul = box.createEl("ul", { cls: "st-tip-extra" });
      for (const r of n.reqList) {
        ul.createEl("li", { text: (r.missing ? "❓ " : r.done ? "✅ " : "⬜ ") + r.name + (r.branch ? ` · ${r.branch}` : "") });
      }
    }
    if (n.reqs && (n.reqs.ids.length || n.reqs.missing.length)) {
      const parts = n.reqs.ids.map(id => (isDone(this.all.get(id).status) ? "✅ " : "⬜ ") + this.all.get(id).name)
        .concat(n.reqs.missing.map(s => "❓ " + s));
      this.tooltip.createDiv({ cls: "st-tip-req", text: t("requires") + " " + parts.join(n.reqs.op === "or" ? t("or") : t("and")) });
    }
    if (n.extra && n.extra.length) {
      const ul = this.tooltip.createEl("ul", { cls: "st-tip-extra" });
      for (const t of n.extra) ul.createEl("li", { text: t });
    }
    this.tooltip.show();
    this.moveTip(ev);
  }

  moveTip(ev) {
    const r = this.contentEl.getBoundingClientRect();
    setVars(this.tooltip, { "--st-tip-x": `${ev.clientX - r.left + 14}px`, "--st-tip-y": `${ev.clientY - r.top + 14}px` });
  }

  async openNode(n) {
    if (!n.file) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(n.file, n.line != null ? { eState: { line: n.line } } : undefined);
  }
}

/* ---------- plugin ---------- */

const exampleFiles = (root) => ({
  "Example/Example.md": `---
type: branch
description: An example branch. Every subfolder of the skills folder is a branch.
---
`,
  "Example/Basics.md": `---
type: branch
parent: "[[${root}/Example/Example|Example]]"
description: A constellation. Checkboxes are skills, plain bullets under them are notes.
---

- [x] First steps — what you can already do
- [/] Practice — what you are learning now
\t- requires:: First steps
- [>] Next goal — what you want next
\t- requires:: Practice
\t- Plain bullets become the description and notes
- [ ] Advanced — locked until its requirements are known
\t- requires:: Practice & Side skill
- [ ] Side skill
- [*] Mastered skill

## Sub-group
- [ ] Headings create sub-groups
\t- requires:: First steps | Side skill
`,
});
const exampleMap = (center) => `---
type: map
center: "${center}"
---

Legendary skills combine skills from different branches.

- [ ] Legend
\t- A legendary skill that needs several branches
\t- requires:: Advanced & Mastered skill
`;

module.exports = class SkillTreePlugin extends Plugin {
  async onload() {
    const data = Object.assign({}, await this.loadData());
    if (data.settings || data.state) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.state = Object.assign({}, data.state);
    } else {
      // data from the first test build: plain view state, skills under Personal/Skills
      this.settings = data.branch !== undefined ? { folder: "Personal/Skills", mapFile: "Карта.md" } : Object.assign({}, DEFAULT_SETTINGS);
      this.state = data;
    }

    this.registerView(VIEW_TYPE, (leaf) => new SkillTreeView(leaf, this));
    this.addRibbonIcon("git-fork", "Skill Tree", () => this.activate());
    this.addCommand({ id: "open", name: t("cmdOpen"), callback: () => this.activate() });
    this.addCommand({ id: "create-example", name: t("cmdExample"), callback: () => this.createExample() });
    this.addSettingTab(new SkillTreeSettingTab(this.app, this));
  }

  rootFolder() { return normalizePath(this.settings.folder || DEFAULT_SETTINGS.folder); }
  mapPath() { return normalizePath(`${this.rootFolder()}/${this.settings.mapFile || DEFAULT_SETTINGS.mapFile}`); }

  async save() { await this.saveData({ settings: this.settings, state: this.state }); }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof SkillTreeView) leaf.view.render(true);
    }
  }

  async createExample() {
    const { vault } = this.app;
    const root = this.rootFolder();
    const target = `${root}/Example`;
    if (vault.getAbstractFileByPath(target)) { new Notice(t("exampleExists", target)); return; }
    for (const dir of [...root.split("/").map((_, i, a) => a.slice(0, i + 1).join("/")), target]) {
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
    }
    for (const [rel, text] of Object.entries(exampleFiles(root))) await vault.create(`${root}/${rel}`, text);
    if (!vault.getAbstractFileByPath(this.mapPath())) await vault.create(this.mapPath(), exampleMap(t("me")));
    new Notice(t("exampleCreated", target));
    setTimeout(() => this.refreshViews(), 500); // let the metadata cache index the new notes
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
};

/* ---------- settings ---------- */

class SkillTreeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const apply = debounce(async () => { await this.plugin.save(); this.plugin.refreshViews(); }, 600, true);
    new Setting(containerEl).setName(t("setFolder")).setDesc(t("setFolderDesc"))
      .addText(x => x.setPlaceholder(DEFAULT_SETTINGS.folder).setValue(this.plugin.settings.folder)
        .onChange(v => { this.plugin.settings.folder = v.trim() || DEFAULT_SETTINGS.folder; apply(); }));
    new Setting(containerEl).setName(t("setMap")).setDesc(t("setMapDesc"))
      .addText(x => x.setPlaceholder(DEFAULT_SETTINGS.mapFile).setValue(this.plugin.settings.mapFile)
        .onChange(v => {
          v = v.trim() || DEFAULT_SETTINGS.mapFile;
          this.plugin.settings.mapFile = v.endsWith(".md") ? v : v + ".md";
          apply();
        }));
  }
}
