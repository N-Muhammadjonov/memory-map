const MAX_FILE = 64 * 1024 ** 2;
const MAX_FOLDER = 2 * 1024 ** 3;

export function folderPacket(files) {
  const source = files[0]?.webkitRelativePath.split("/")[0];
  if (!source || files.some(file => !file.webkitRelativePath.startsWith(source + "/"))) {
    throw new Error("Choose the whole vault folder.");
  }
  const entries = [];
  const skipped = [];
  let total = 4;
  for (const file of files) {
    const path = file.webkitRelativePath.slice(source.length + 1);
    if (path.split("/").some(part => part.startsWith("."))) continue;
    if (file.size > MAX_FILE) {
      skipped.push(path);
      continue;
    }
    entries.push({path, file});
    total += file.size;
  }
  if (!entries.length) throw new Error("No importable files found. Each file must be 64 MiB or smaller.");
  if (entries.length > 20_000) throw new Error("A folder may contain up to 20,000 files.");
  const manifest = new TextEncoder().encode(JSON.stringify({
    source, files: entries.map(({path, file}) => [path, file.size]),
  }));
  if (manifest.length > 4 * 1024 ** 2 || total + manifest.length > MAX_FOLDER) {
    throw new Error("Bir import hajmi 2 GiB gacha. Papkani alohida qismlarga ajrating.");
  }
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, manifest.byteLength);
  return {
    source, count: entries.length, skipped,
    body: new Blob([length, manifest, ...entries.map(({file}) => file)]),
  };
}

export function folderTree(container, items, row, active, openFolders, expanded = false) {
  const tree = {folders: new Map(), entries: []};
  for (const item of items) {
    const location = item.path ? [item.source, ...item.path.split("/").slice(0, -1)] : [];
    let branch = tree;
    for (const title of location) {
      if (!branch.folders.has(title)) branch.folders.set(title, {folders: new Map(), entries: []});
      branch = branch.folders.get(title);
    }
    branch.entries.push(item);
  }

  function decorate(branch, path) {
    const result = [];
    for (const [title, child] of [...branch.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const key = path ? path + "/" + title : title;
      const item = document.createElement("li");
      const disclosure = document.createElement("details");
      disclosure.className = "folder-branch";
      disclosure.open = expanded || openFolders.has(key) || Boolean(active?.startsWith(key + "/"));
      disclosure.addEventListener("toggle", () => {
        if (!disclosure.isConnected || expanded) return;
        if (disclosure.open) openFolders.add(key);
        else openFolders.delete(key);
      });
      const header = document.createElement("summary");
      header.textContent = !path && /^(?:obsidian|notion) vault$/i.test(title) ? "Imported vault" : title;
      const nested = document.createElement("ul");
      nested.className = "folder-children";
      nested.append(...decorate(child, key));
      disclosure.append(header, nested);
      item.append(disclosure);
      result.push(item);
    }
    result.push(...branch.entries.map(row));
    return result;
  }

  container.replaceChildren(...decorate(tree, ""));
}
