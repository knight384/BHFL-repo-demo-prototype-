const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// 1. VALIDATION
// ─────────────────────────────────────────────
function isValidEdge(entry) {
  if (typeof entry !== "string") return false;
  const trimmed = entry.trim();
  // Must match exactly: single uppercase -> single uppercase
  return /^[A-Z]->[A-Z]$/.test(trimmed);
}

function parseEdge(entry) {
  const [from, to] = entry.trim().split("->");
  return { from, to };
}

// ─────────────────────────────────────────────
// 2. DUPLICATE HANDLING + GRAPH BUILDING
// ─────────────────────────────────────────────
function processEdges(data) {
  const invalid_entries = [];
  const duplicate_edges = [];
  const seenEdges = new Set();
  const duplicateSeen = new Set(); // track which dupes we've already recorded
  const validEdges = [];

  for (const entry of data) {
    const trimmed = typeof entry === "string" ? entry.trim() : String(entry);

    if (!isValidEdge(trimmed)) {
      invalid_entries.push(entry);
      continue;
    }

    const { from, to } = parseEdge(trimmed);

    // Self-loop check (already caught by regex, but explicit)
    if (from === to) {
      invalid_entries.push(entry);
      continue;
    }

    const key = `${from}->${to}`;

    if (seenEdges.has(key)) {
      // Record duplicate only once
      if (!duplicateSeen.has(key)) {
        duplicate_edges.push(trimmed);
        duplicateSeen.add(key);
      }
    } else {
      seenEdges.add(key);
      validEdges.push({ from, to });
    }
  }

  return { validEdges, invalid_entries, duplicate_edges };
}

// ─────────────────────────────────────────────
// 3. GRAPH BUILDING
// ─────────────────────────────────────────────
function buildGraph(validEdges) {
  // adjacency list: node -> [children]
  // childParentMap: node -> first parent (multi-parent: keep first)
  const children = {}; // node -> [child, ...]
  const parentOf = {};  // child -> parent (first parent wins)
  const allNodes = new Set();

  for (const { from, to } of validEdges) {
    allNodes.add(from);
    allNodes.add(to);

    // Multi-parent rule: if `to` already has a parent, ignore this edge
    if (parentOf[to] !== undefined) {
      continue; // silently ignore
    }

    parentOf[to] = from;

    if (!children[from]) children[from] = [];
    children[from].push(to);
  }

  return { children, parentOf, allNodes };
}

// ─────────────────────────────────────────────
// 4. ROOT DETECTION
// ─────────────────────────────────────────────
function findRoots(allNodes, parentOf) {
  const roots = [];
  for (const node of allNodes) {
    if (parentOf[node] === undefined) {
      roots.push(node);
    }
  }
  return roots.sort(); // lexicographic for determinism
}

// ─────────────────────────────────────────────
// 5. CYCLE DETECTION (DFS)
// ─────────────────────────────────────────────
function hasCycleFromRoot(root, children) {
  const visited = new Set();
  const stack = new Set();

  function dfs(node) {
    visited.add(node);
    stack.add(node);
    for (const child of (children[node] || [])) {
      if (!visited.has(child)) {
        if (dfs(child)) return true;
      } else if (stack.has(child)) {
        return true; // back edge = cycle
      }
    }
    stack.delete(node);
    return false;
  }

  return dfs(root);
}

// ─────────────────────────────────────────────
// 6. TREE CONSTRUCTION (recursive)
// ─────────────────────────────────────────────
function buildTree(node, children) {
  const subtree = {};
  for (const child of (children[node] || [])) {
    subtree[child] = buildTree(child, children);
  }
  return subtree;
}

// ─────────────────────────────────────────────
// 7. DEPTH CALCULATION
// ─────────────────────────────────────────────
function calcDepth(node, children) {
  const kids = children[node] || [];
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map((c) => calcDepth(c, children)));
}

// ─────────────────────────────────────────────
// 8. FIND CONNECTED COMPONENT NODES
// ─────────────────────────────────────────────
function getComponentNodes(root, children) {
  const visited = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    for (const child of (children[node] || [])) {
      stack.push(child);
    }
  }
  return visited;
}

// ─────────────────────────────────────────────
// POST /bfhl
// ─────────────────────────────────────────────
app.post("/bfhl", (req, res) => {
  const { data } = req.body;

  if (!Array.isArray(data)) {
    return res.status(400).json({ error: "data must be an array" });
  }

  // Step 1 & 2: Validate + deduplicate
  const { validEdges, invalid_entries, duplicate_edges } = processEdges(data);

  // Step 3: Build graph
  const { children, parentOf, allNodes } = buildGraph(validEdges);

  // Step 4: Find roots
  // For pure cycles (X->Y->Z->X), no node is root-less, so we pick the
  // lex-smallest node in each strongly-connected component as representative.
  let roots = findRoots(allNodes, parentOf);

  // If some nodes have no root (pure cycle), find them via BFS from known roots
  const reachableFromRoots = new Set();
  for (const r of roots) {
    const stack = [r];
    while (stack.length) {
      const n = stack.pop();
      if (reachableFromRoots.has(n)) continue;
      reachableFromRoots.add(n);
      for (const c of (children[n] || [])) stack.push(c);
    }
  }

  // Nodes not reachable from any root must be part of pure cycles
  const unreachedNodes = [...allNodes].filter((n) => !reachableFromRoots.has(n)).sort();

  // Group them into connected components (undirected BFS) to find one rep per cycle
  const assignedToCycle = new Set();
  for (const startNode of unreachedNodes) {
    if (assignedToCycle.has(startNode)) continue;
    // BFS using directed edges in both directions to find the component
    const component = new Set();
    const q = [startNode];
    while (q.length) {
      const n = q.shift();
      if (component.has(n)) continue;
      component.add(n);
      assignedToCycle.add(n);
      for (const c of (children[n] || [])) { if (!component.has(c)) q.push(c); }
    }
    // pick lex-smallest as the artificial root of this cycle group
    const cycleRoot = [...component].sort()[0];
    roots.push(cycleRoot);
  }

  // Step 5–8: Build hierarchies per root
  const hierarchies = [];
  let total_cycles = 0;
  const nonCyclicTrees = []; // { root, depth }

  for (const root of roots) {
    const cycleFound = hasCycleFromRoot(root, children);

    if (cycleFound) {
      total_cycles++;
      hierarchies.push({
        root,
        tree: {},
        has_cycle: true,
      });
    } else {
      const tree = buildTree(root, children);
      const depth = calcDepth(root, children);
      hierarchies.push({ root, tree, depth });
      nonCyclicTrees.push({ root, depth });
    }
  }

  // Step 9: Summary
  const total_trees = nonCyclicTrees.length;

  let largest_tree_root = null;
  if (nonCyclicTrees.length > 0) {
    // Find max depth; on tie, pick lexicographically smaller root
    nonCyclicTrees.sort((a, b) => {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return a.root < b.root ? -1 : 1;
    });
    largest_tree_root = nonCyclicTrees[0].root;
  }

  const summary = {
    total_trees,
    total_cycles,
    largest_tree_root,
  };

  return res.json({
    user_id: "yourname_ddmmyyyy",
    email_id: "your@email.com",
    college_roll_number: "YOUR_ROLL_NUMBER",
    hierarchies,
    invalid_entries,
    duplicate_edges,
    summary,
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BFHL API running on http://localhost:${PORT}`);
});
