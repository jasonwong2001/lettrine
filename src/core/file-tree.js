const fileNames = new Intl.Collator(undefined, { numeric: true });
// `compare` orders siblings; folders always precede files and sort by name.
export function fileTreeRows(files, folder, expanded = new Set(), compare = null) {
  const root = folder.replace(/\/+$/, ""), prefix = root + "/", entries = new Map();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    entries.set(file.path, file);
    let parent = file.path.slice(0, file.path.lastIndexOf("/"));
    while (parent !== root && parent.startsWith(prefix)) {
      if (!entries.has(parent)) entries.set(parent, { path: parent, name: parent.split("/").pop(), isDirectory: true });
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  const children = new Map();
  for (const file of entries.values()) {
    const parent = file.path.slice(0, file.path.lastIndexOf("/"));
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(file);
  }
  const rows = [];
  const walk = (parent, depth) => {
    const byName = (a, b) => fileNames.compare(a.name, b.name);
    const list = (children.get(parent) || []).sort((a, b) => Number(!!b.isDirectory) - Number(!!a.isDirectory) || (compare && !a.isDirectory && !b.isDirectory ? compare(a, b) : byName(a, b)));
    for (const file of list) { rows.push({ ...file, depth, expanded: !!file.isDirectory && expanded.has(file.path) }); if (file.isDirectory && expanded.has(file.path)) walk(file.path, depth + 1); }
  };
  walk(root, 0);
  return rows;
}
