(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const ic = (name) => {
    const s = el("span", "nav-ic");
    s.innerHTML = NxIcons.get(name);
    return s;
  };

  /* ---------------- state ---------------- */
  const state = {
    token: localStorage.getItem("nexus_token") || "",
    cwd: "/",
    entries: [],
    filtered: null,
    selection: new Set(),
    clipboard: null,
    sort: { key: "name", dir: 1 },
    showHidden: localStorage.getItem("nexus_hidden") === "1",
    mode: localStorage.getItem("nexus_mode") || "grid",
    searchTerm: null,
  };

  const EDITABLE = new Set(["txt", "md", "json", "js", "ts", "jsx", "tsx", "css", "scss", "html", "xml", "yml", "yaml", "py", "sh", "bash", "env", "ini", "conf", "cfg", "toml", "csv", "log", "sql", "go", "rs", "java", "c", "h", "cpp", "hpp", "rb", "php", "lua", "vue", "svelte", "gitignore", "dockerfile", "makefile", "service", "plist"]);
  const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
  const VIDEO = new Set(["mp4", "webm", "mkv", "mov", "avi"]);
  const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a"]);
  const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz"]);

  const ext = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : n.toLowerCase());
  const isDir = (e) => e.type === "dir";
  const baseName = (p) => p.replace(/\/+$/, "").split("/").pop() || "/";

  function fileKind(e) {
    if (isDir(e)) return { cls: "dir", icon: "folder" };
    const x = ext(e.name);
    if (IMAGES.has(x)) return { cls: "img", icon: "image" };
    if (VIDEO.has(x)) return { cls: "vid", icon: "video" };
    if (AUDIO.has(x)) return { cls: "aud", icon: "audio" };
    if (ARCHIVE.has(x)) return { cls: "arc", icon: "archive" };
    if (EDITABLE.has(x)) return { cls: "code", icon: "code" };
    if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf"].includes(x)) return { cls: "doc", icon: "doc" };
    return { cls: "bin", icon: "file" };
  }

  function fmtSize(b) {
    if (b === 0) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
    return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
  }
  function fmtDate(s) {
    if (!s) return "--";
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, isErr) {
    const t = el("div", "toast" + (isErr ? " err" : ""));
    t.append(el("i", "t-dot"), document.createTextNode(msg));
    $("toasts").append(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, 3200);
  }

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, { "X-Access-Token": state.token });
    if (opts.json !== undefined) {
      opts.method = opts.method || "POST";
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const res = await fetch(path, opts);
    if (res.status === 401) { showLogin(); throw new Error("Unauthorized"); }
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) {}
      throw new Error(detail);
    }
    return res;
  }
  const apiJson = async (path, opts) => (await api(path, opts)).json();

  async function blobUrl(path) {
    const res = await api("/api/fs/raw?path=" + encodeURIComponent(path));
    return URL.createObjectURL(await res.blob());
  }

  async function downloadPath(path, name) {
    try {
      toast("Preparing download…");
      const res = await api("/api/fs/download?path=" + encodeURIComponent(path));
      const blob = await res.blob();
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = name || baseName(path);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast("Download failed: " + e.message, true); }
  }

  /* ---------------- auth ---------------- */
  function showLogin() {
    $("app-shell").classList.add("hidden");
    $("login-overlay").classList.remove("hidden");
    setTimeout(() => $("login-token").focus(), 60);
  }

  async function boot() {
    try {
      const r = await apiJson("/api/fs/auth/check");
      if (r.valid) {
        $("login-overlay").classList.add("hidden");
        $("app-shell").classList.remove("hidden");
        NxIcons.render();
        enterApp();
        return;
      }
    } catch (_) {}
    showLogin();
  }

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    state.token = $("login-token").value.trim();
    try {
      const r = await apiJson("/api/fs/auth/check");
      if (!r.valid) throw new Error();
      localStorage.setItem("nexus_token", state.token);
      $("login-error").classList.add("hidden");
      $("login-overlay").classList.add("hidden");
      $("app-shell").classList.remove("hidden");
      NxIcons.render();
      enterApp();
    } catch (_) {
      $("login-error").classList.remove("hidden");
    }
  });

  function enterApp() {
    setView("files");
    load(state.cwd);
    startHealthPing();
  }

  /* ---------------- health ping ---------------- */
  let healthTimer = null;
  function startHealthPing() {
    if (healthTimer) clearInterval(healthTimer);
    const ping = async () => {
      try { await api("/health"); $("conn-dot").classList.remove("off"); }
      catch (_) { $("conn-dot").classList.add("off"); }
    };
    ping();
    healthTimer = setInterval(ping, 6000);
  }

  /* ---------------- view switching ---------------- */
  const TITLES = { files: "Files", terminal: "Terminal", system: "System" };
  function setView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    document.querySelectorAll(".nav-btn, .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $("view-title").textContent = TITLES[name] || name;
    $("sidebar").classList.remove("open");
    if (name === "system" && window.NxSystem) NxSystem.refresh();
    if (name === "terminal" && window.NxTerm) NxTerm.activate();
  }
  document.querySelectorAll(".nav-btn, .tab-btn").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("burger").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("btn-reload-view").addEventListener("click", () => {
    const active = document.querySelector(".view.active").id;
    if (active === "view-files") load(state.cwd, { silent: true });
    if (active === "view-system" && window.NxSystem) NxSystem.refresh(true);
    if (active === "view-terminal" && window.NxTerm) NxTerm.activate();
  });

  /* ---------------- files: load & render ---------------- */
  async function load(path, opts = {}) {
    try {
      if (!opts.silent) toast("Loading…");
      const data = await apiJson("/api/fs/list?path=" + encodeURIComponent(path) + "&show_hidden=" + state.showHidden);
      state.cwd = data.path;
      state.entries = data.entries;
      state.searchTerm = null;
      $("search-input").value = "";
      $("search-clear").classList.add("hidden");
      clearSelection();
      renderCrumbs(data.path, data.parent);
      renderEntries();
      updateDiskMini(data.disk);
      if (window.NxTerm) NxTerm.setCwdOption(data.path);
    } catch (e) {
      if (e.message !== "Unauthorized") toast("Failed to load: " + e.message, true);
    }
  }

  function updateDiskMini(disk) {
    if (!disk) return;
    const pct = disk.total ? Math.round((disk.used / disk.total) * 100) : 0;
    $("disk-pct-mini").textContent = pct + "%";
    $("disk-bar-mini").style.width = pct + "%";
    $("disk-detail-mini").textContent = fmtSize(disk.used) + " of " + fmtSize(disk.total) + " used";
  }

  function renderCrumbs(path, parent) {
    const c = $("breadcrumbs");
    c.innerHTML = "";
    const parts = path === "/" ? [] : path.split("/").filter(Boolean);
    const mk = (label, target, current) => {
      const b = el("button", "crumb" + (current ? " current" : ""));
      b.textContent = label;
      if (!current) b.addEventListener("click", () => load(target));
      c.append(b);
    };
    mk("/", "/", path === "/");
    let acc = "";
    parts.forEach((p, i) => {
      const sep = el("span", "crumb-sep");
      sep.textContent = "›";
      c.append(sep);
      acc += "/" + p;
      mk(p, acc, i === parts.length - 1);
    });
  }

  function sortedEntries(list) {
    const s = state.sort;
    const cmp = (a, b) => {
      if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
      let r = 0;
      if (s.key === "size") r = a.size - b.size;
      else if (s.key === "mtime") r = new Date(a.mtime) - new Date(b.mtime);
      else r = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return r * s.dir;
    };
    return [...list].sort(cmp);
  }

  function renderEntries() {
    const grid = $("file-grid");
    grid.classList.toggle("mode-list", state.mode === "list");
    grid.innerHTML = "";
    const list = sortedEntries(state.filtered !== null ? state.filtered : state.entries);
    $("empty-state").classList.toggle("hidden", list.length > 0);
    $("empty-state").querySelector("p").textContent =
      state.searchTerm !== null ? `No results for “${state.searchTerm}”` : "This folder is empty";
    $("list-head").style.display = state.mode === "list" && list.length ? "flex" : "none";

    list.forEach((e) => {
      const kind = fileKind(e);
      const card = el("div", "file-card" + (state.selection.has(e.path) ? " selected" : ""));
      card.dataset.path = e.path;

      const chk = el("label", "f-check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = state.selection.has(e.path);
      cb.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSelect(e.path, cb.checked, card); });
      cb.addEventListener("dblclick", (ev) => ev.stopPropagation());
      chk.append(cb);
      card.append(chk);

      const icon = el("div", "f-icon " + kind.cls);
      icon.innerHTML = NxIcons.get(kind.icon);
      card.append(icon);

      const name = el("div", "f-name");
      name.textContent = e.name;
      name.title = e.name;
      card.append(name);

      const size = el("span", "f-size");
      size.textContent = isDir(e) ? "—" : fmtSize(e.size);
      const date = el("span", "f-date");
      date.textContent = fmtDate(e.mtime);
      if (state.mode === "list") { card.append(size, date); }

      card.addEventListener("click", (ev) => {
        if (ev.ctrlKey || ev.metaKey) toggleSelect(e.path, !state.selection.has(e.path), card);
        else if (state.selection.size && !state.selection.has(e.path)) { clearSelection(); }
        else if (state.selection.has(e.path) && state.selection.size === 1) { openEntry(e); }
      });
      card.addEventListener("dblclick", () => openEntry(e));
      card.addEventListener("contextmenu", (ev) => { ev.preventDefault(); if (!state.selection.has(e.path)) { clearSelection(); toggleSelect(e.path, true, card); } openCtxMenu(ev.clientX, ev.clientY, e); });
      grid.append(card);
    });
  }

  /* ---------------- selection ---------------- */
  function toggleSelect(path, on, card) {
    if (on) state.selection.add(path); else state.selection.delete(path);
    if (card) card.classList.toggle("selected", on);
    const cb = card && card.querySelector(".f-check input");
    if (cb) cb.checked = on;
    updateBulkBar();
  }
  function clearSelection() {
    state.selection.clear();
    document.querySelectorAll(".file-card.selected").forEach((c) => {
      c.classList.remove("selected");
      const cb = c.querySelector(".f-check input");
      if (cb) cb.checked = false;
    });
    updateBulkBar();
  }
  function updateBulkBar() {
    const n = state.selection.size;
    $("bulk-bar").classList.toggle("hidden", n === 0);
    $("bulk-count").textContent = n + " selected";
  }
  $("check-all").addEventListener("change", (ev) => {
    const on = ev.target.checked;
    (state.filtered !== null ? state.filtered : state.entries).forEach((e) => {
      if (on) state.selection.add(e.path);
      else state.selection.delete(e.path);
    });
    document.querySelectorAll(".file-card").forEach((c) => {
      const p = c.dataset.path;
      c.classList.toggle("selected", on);
      const cb = c.querySelector(".f-check input");
      if (cb) cb.checked = on;
    });
    updateBulkBar();
  });
  $("bulk-cancel").addEventListener("click", clearSelection);

  /* ---------------- open ---------------- */
  async function openEntry(e) {
    if (isDir(e)) return load(e.path);
    const x = ext(e.name);
    if (IMAGES.has(x) || VIDEO.has(x) || AUDIO.has(x)) return previewModal(e);
    if ((EDITABLE.has(x) || e.size <= 2 * 1024 * 1024) && e.size <= 2 * 1024 * 1024) {
      try {
        const data = await apiJson("/api/fs/read?path=" + encodeURIComponent(e.path));
        if (x === "pdf") return downloadPath(e.path);
        return editorModal(data);
      } catch (err) {
        if (/Binary/i.test(err.message)) return downloadPath(e.path);
        toast("Cannot open: " + err.message, true);
        return;
      }
    }
    downloadPath(e.path);
  }

  /* ---------------- preview ---------------- */
  async function previewModal(e) {
    const kind = fileKind(e);
    const card = openModal("", true);
    card.classList.add("wide");
    const head = el("div", "editor-meta");
    const title = el("strong"); title.textContent = e.name;
    const grow = el("span", "grow");
    const closeBtn = el("button", "btn btn-ghost"); closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => $("modal").close());
    head.append(title, grow, closeBtn);
    const body = el("div", "editor-wrap");
    body.style.display = "flex"; body.style.alignItems = "center"; body.style.justifyContent = "center";
    try {
      const url = await blobUrl(e.path);
      if (kind.cls === "img") { const img = el("img"); img.src = url; img.style.maxWidth = "100%"; img.style.maxHeight = "100%"; body.append(img); }
      else { const m = el(kind.cls === "vid" ? "video" : "audio"); m.src = url; m.controls = true; m.style.width = "90%"; body.append(m); }
    } catch (err) { body.textContent = "Failed to load preview"; }
    card.append(head, body);
    $("modal").showModal();
  }

  /* ---------------- editor ---------------- */
  function cmMode(name) {
    const x = ext(name);
    const map = { js: "javascript", ts: "javascript", json: { name: "javascript", json: true }, html: "htmlmixed", xml: "xml", svg: "xml", css: "css", py: "python", md: "markdown", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml" };
    return map[x] || "text/plain";
  }

  async function editorModal(data) {
    const card = openModal("", true);
    card.classList.add("wide");
    const head = el("div", "editor-meta");
    const title = el("strong"); title.textContent = data.name;
    const meta = el("span"); meta.textContent = data.path;
    const grow = el("span", "grow");
    const writable = el("span"); writable.textContent = data.writable ? "writable" : "read-only";
    const save = el("button", "btn btn-primary btn-sm");
    save.append(ic("save"), document.createTextNode("Save"));
    const closeBtn = el("button", "btn btn-ghost btn-sm"); closeBtn.textContent = "Close";
    head.append(title, meta, grow, writable, save, closeBtn);

    const wrap = el("div", "editor-wrap");
    card.append(head, wrap);
    $("modal").showModal();

    const cm = CodeMirror(wrap, {
      value: data.content,
      mode: cmMode(data.name),
      lineNumbers: true,
      lineWrapping: true,
      theme: "default",
      readOnly: !data.writable,
      autoCloseBrackets: true,
      styleActiveLine: true,
    });
    cm.setSize("100%", "100%");

    closeBtn.addEventListener("click", () => $("modal").close());
    save.addEventListener("click", async () => {
      if (!data.writable) return toast("File is read-only", true);
      try {
        await api("/api/fs/write", { method: "PUT", json: { path: data.path, content: cm.getValue() } });
        toast("Saved " + data.name);
        load(state.cwd, { silent: true });
      } catch (e) { toast("Save failed: " + e.message, true); }
    });
  }

  /* ---------------- modal helper ---------------- */
  function openModal(html, noAutoClose) {
    const card = $("modal-card");
    card.innerHTML = "";
    card.className = "modal-card glass";
    if (html) card.innerHTML = html;
    const dlg = $("modal");
    if (!noAutoClose) {
      dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
    }
    return card;
  }
  function formModal(title, fields, onSubmit) {
    const card = openModal("");
    const h = el("h2"); h.textContent = title;
    card.append(h);
    const inputs = {};
    fields.forEach((f) => {
      const col = el("div", "form-col");
      const lab = el("label"); lab.textContent = f.label;
      const inp = el("input"); inp.type = f.type || "text"; inp.value = f.value || "";
      inp.placeholder = f.placeholder || "";
      col.append(lab, inp);
      card.append(col);
      inputs[f.key] = inp;
    });
    const actions = el("div", "modal-actions");
    const cancel = el("button", "btn btn-ghost"); cancel.textContent = "Cancel";
    const ok = el("button", "btn btn-primary"); ok.textContent = fields.length ? "OK" : title;
    actions.append(cancel, ok);
    card.append(actions);
    $("modal").showModal();
    const first = Object.values(inputs)[0];
    if (first) { first.focus(); first.select(); }
    cancel.addEventListener("click", () => $("modal").close());
    const submit = async () => { try { await onSubmit(inputs); $("modal").close(); } catch (e) { toast(e.message, true); } };
    ok.addEventListener("click", submit);
    card.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && fields.length) submit(); });
  }
  function confirmModal(title, text, action, danger) {
    const card = openModal("");
    const h = el("h2"); h.textContent = title;
    const p = el("p"); p.textContent = text; p.style.color = "var(--text-dim)";
    const actions = el("div", "modal-actions");
    const cancel = el("button", "btn btn-ghost"); cancel.textContent = "Cancel";
    const ok = el("button", "btn " + (danger ? "btn-danger" : "btn-primary")); ok.textContent = title;
    actions.append(cancel, ok);
    card.append(h, p, actions);
    $("modal").showModal();
    cancel.addEventListener("click", () => $("modal").close());
    ok.addEventListener("click", async () => { try { await action(); $("modal").close(); } catch (e) { toast(e.message, true); } });
  }

  /* ---------------- toolbar actions ---------------- */
  $("btn-new").addEventListener("click", () => {
    const card = openModal("");
    const h = el("h2"); h.textContent = "Create new";
    const row = el("div", "choice-row");
    const mkBtn = el("button", "btn btn-ghost"); mkBtn.append(ic("folder"), document.createTextNode("Folder"));
    const fBtn = el("button", "btn btn-ghost"); fBtn.append(ic("file"), document.createTextNode("File"));
    row.append(mkBtn, fBtn);
    card.append(h, row);
    $("modal").showModal();
    const ask = (kind) => formModal("New " + kind, [{ key: "name", label: "Name", placeholder: kind === "folder" ? "my-folder" : "notes.txt" }],
      async (inp) => {
        const name = inp.name.value.trim();
        if (!name) throw new Error("Name is required");
        const p = joinPath(state.cwd, name);
        await api("/api/fs/" + (kind === "folder" ? "mkdir" : "touch"), { json: { path: p } });
        toast("Created " + name);
        load(state.cwd, { silent: true });
      });
    mkBtn.addEventListener("click", () => ask("folder"));
    fBtn.addEventListener("click", () => ask("file"));
  });

  $("btn-upload").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async (ev) => {
    await uploadFiles([...ev.target.files]);
    ev.target.value = "";
  });

  async function uploadFiles(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    try {
      toast("Uploading " + files.length + " file(s)…");
      await api("/api/fs/upload?dir=" + encodeURIComponent(state.cwd), { method: "POST", body: fd });
      toast("Upload complete");
      load(state.cwd, { silent: true });
    } catch (e) { toast("Upload failed: " + e.message, true); }
  }

  const main = document.querySelector(".main");
  let dragDepth = 0;
  main.addEventListener("dragenter", (ev) => { ev.preventDefault(); if (++dragDepth === 1) $("dropzone-hint").classList.remove("hidden"); });
  main.addEventListener("dragleave", () => { if (--dragDepth === 0) $("dropzone-hint").classList.add("hidden"); });
  main.addEventListener("dragover", (ev) => ev.preventDefault());
  main.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    $("dropzone-hint").classList.add("hidden");
    uploadFiles([...ev.dataTransfer.files]);
  });

  $("btn-hidden").addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    localStorage.setItem("nexus_hidden", state.showHidden ? "1" : "0");
    toast(state.showHidden ? "Hidden files shown" : "Hidden files hidden");
    load(state.cwd, { silent: true });
  });

  $("btn-sort").addEventListener("click", (ev) => {
    const opts = [
      ["name", 1, "Name A→Z"], ["name", -1, "Name Z→A"],
      ["size", -1, "Size largest"], ["mtime", -1, "Newest first"], ["mtime", 1, "Oldest first"],
    ];
    showMenu(ev.clientX, ev.clientY, opts.map(([key, dir, label]) => ({
      icon: "sort", label,
      fn: () => { state.sort = { key, dir }; renderEntries(); },
    })));
  });

  document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    localStorage.setItem("nexus_mode", state.mode);
    document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    renderEntries();
  }));

  /* ---------------- search ---------------- */
  let searchTimer = null;
  $("search-input").addEventListener("input", (ev) => {
    const q = ev.target.value.trim();
    $("search-clear").classList.toggle("hidden", !q);
    clearTimeout(searchTimer);
    if (!q) { state.filtered = null; state.searchTerm = null; renderEntries(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await apiJson("/api/fs/search?path=" + encodeURIComponent(state.cwd) + "&q=" + encodeURIComponent(q));
        state.filtered = r.results;
        state.searchTerm = q;
        renderEntries();
      } catch (e) { toast("Search failed: " + e.message, true); }
    }, 300);
  });
  $("search-clear").addEventListener("click", () => {
    $("search-input").value = "";
    state.filtered = null;
    state.searchTerm = null;
    $("search-clear").classList.add("hidden");
    renderEntries();
  });

  /* ---------------- bulk actions ---------------- */
  $("bulk-delete").addEventListener("click", () => {
    const n = state.selection.size;
    confirmModal("Delete " + n + " item(s)?", "This cannot be undone.", async () => {
      await api("/api/fs/delete", { json: { items: [...state.selection] } });
      toast("Deleted " + n + " item(s)");
      clearSelection();
      load(state.cwd, { silent: true });
    }, true);
  });
  $("bulk-copy").addEventListener("click", () => askDest("Copy", async (dest) => {
    await api("/api/fs/copy", { json: { items: [...state.selection], dest } });
    toast("Copied to " + dest);
    load(state.cwd, { silent: true });
  }));
  $("bulk-cut").addEventListener("click", () => {
    state.clipboard = { mode: "move", items: [...state.selection] };
    clearSelection();
    showClipBar();
  });
  $("bulk-download").addEventListener("click", async () => {
    const items = [...state.selection];
    if (items.length === 1) return downloadPath(items[0]);
    try {
      toast("Creating archive…");
      const r = await apiJson("/api/fs/compress?name=selection.zip", { json: { items } });
      await downloadPath(r.archive);
      await api("/api/fs/delete", { json: { items: [r.archive] } }).catch(() => {});
    } catch (e) { toast("Failed: " + e.message, true); }
  });

  function askDest(title, action) {
    formModal(title, [{ key: "dest", label: "Destination directory", value: state.cwd }], async (inp) => {
      const d = inp.dest.value.trim();
      if (!d) throw new Error("Destination is required");
      await action(d);
    });
  }

  function showClipBar() {
    if (!state.clipboard) return $("clip-bar").classList.add("hidden");
    $("clip-bar").classList.remove("hidden");
    $("clip-text").textContent = state.clipboard.items.length + " item(s) ready to " + (state.clipboard.mode === "move" ? "move" : "copy");
  }
  $("clip-cancel").addEventListener("click", () => { state.clipboard = null; showClipBar(); });
  $("clip-paste").addEventListener("click", async () => {
    if (!state.clipboard) return;
    try {
      await api("/api/fs/" + (state.clipboard.mode === "move" ? "move" : "copy"), { json: { items: state.clipboard.items, dest: state.cwd } });
      toast("Pasted " + state.clipboard.items.length + " item(s)");
      state.clipboard = null;
      showClipBar();
      load(state.cwd, { silent: true });
    } catch (e) { toast("Paste failed: " + e.message, true); }
  });

  /* ---------------- context menu ---------------- */
  function showMenu(x, y, items) {
    const m = $("ctx-menu");
    m.innerHTML = "";
    items.forEach((it, i) => {
      if (it === "-") { m.append(el("div", "ctx-sep")); return; }
      const b = el("button", "ctx-item" + (it.danger ? " danger" : ""));
      b.append(ic(it.icon), document.createTextNode(it.label));
      b.addEventListener("click", () => { m.classList.add("hidden"); it.fn(); });
      m.append(b);
    });
    m.classList.remove("hidden");
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  }
  function openCtxMenu(x, y, e) {
    const target = state.selection.size > 1 ? [...state.selection] : [e.path];
    const multi = target.length > 1;
    const items = [];
    if (!multi) {
      if (isDir(e)) items.push({ icon: "open", label: "Open", fn: () => load(e.path) });
      else items.push({ icon: "open", label: "Open", fn: () => openEntry(e) });
      items.push({ icon: "download", label: "Download", fn: () => (isDir(e) ? downloadPath(e.path) : downloadPath(e.path)) });
    }
    items.push({ icon: "rename", label: "Rename", fn: () => formModal("Rename", [{ key: "name", label: "New name", value: e.name }], async (inp) => {
      const nn = inp.name.value.trim();
      if (!nn || nn === e.name) return;
      await api("/api/fs/rename", { json: { src: e.path, dst: joinPath(dirname(e.path), nn) } });
      toast("Renamed");
      load(state.cwd, { silent: true });
    })});
    items.push({ icon: "copy", label: "Copy to…", fn: () => askDest("Copy to", async (dest) => {
      await api("/api/fs/copy", { json: { items: target, dest } });
      toast("Copied");
      load(state.cwd, { silent: true });
    })});
    items.push({ icon: "cut", label: "Cut", fn: () => { state.clipboard = { mode: "move", items: target }; clearSelection(); showClipBar(); } });
    items.push("-");
    if (!multi && !isDir(e) && ARCHIVE.has(ext(e.name))) {
      items.push({ icon: "extract", label: "Extract here", fn: async () => {
        try {
          const r = await apiJson("/api/fs/extract", { json: { path: e.path } });
          toast("Extracted to " + baseName(r.dest));
          load(state.cwd, { silent: true });
        } catch (err) { toast("Extract failed: " + err.message, true); }
      }});
    }
    items.push({ icon: "zip", label: "Compress to zip…", fn: () => formModal("Compress", [{ key: "name", label: "Archive name", value: (multi ? "archive" : e.name.replace(/\.[^.]+$/, "")) + ".zip" }], async (inp) => {
      await apiJson("/api/fs/compress?name=" + encodeURIComponent(inp.name.value.trim()), { json: { items: target } });
      toast("Archive created");
      load(state.cwd, { silent: true });
    })});
    items.push("-");
    items.push({ icon: "trash", label: "Delete", danger: true, fn: () => confirmModal("Delete " + (multi ? target.length + " items" : "“" + e.name + "”") + "?", "This cannot be undone.", async () => {
      await api("/api/fs/delete", { json: { items: target } });
      toast("Deleted");
      clearSelection();
      load(state.cwd, { silent: true });
    }, true) });
    showMenu(x, y, items);
  }
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#ctx-menu")) $("ctx-menu").classList.add("hidden");
  });
  document.addEventListener("contextmenu", (ev) => {
    if (!ev.target.closest(".file-card") && !ev.target.closest("#ctx-menu")) $("ctx-menu").classList.add("hidden");
  });

  function joinPath(dir, name) {
    return dir.endsWith("/") ? dir + name : dir + "/" + name;
  }
  function dirname(p) {
    const i = p.replace(/\/+$/, "").lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", (ev) => {
    if ($("app-shell").classList.contains("hidden")) return;
    if (ev.target.matches("input, textarea, select, .CodeMirror")) return;
    if (ev.key === "Escape") { clearSelection(); }
    if (ev.key === "Delete" && state.selection.size) $("bulk-delete").click();
    if (ev.key === "F2" && state.selection.size === 1) {
      const e = state.entries.find((x) => x.path === [...state.selection][0]);
      if (e) openCtxMenu(innerWidth / 2, innerHeight / 2, e);
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "a") {
      ev.preventDefault();
      (state.filtered !== null ? state.filtered : state.entries).forEach((e) => state.selection.add(e.path));
      document.querySelectorAll(".file-card").forEach((c) => { c.classList.add("selected"); const cb = c.querySelector("input"); if (cb) cb.checked = true; });
      updateBulkBar();
    }
  });

  /* ---------------- system view ---------------- */
  window.NxSystem = {
    timer: null,
    cpuHist: [],
    async refresh(keep) {
      try {
        const s = await apiJson("/api/sys/info");
        $("cpu-pct").textContent = s.cpu.percent.toFixed(1) + "%";
        $("cpu-meta").textContent = s.cpu.cores_physical + " cores · load " + s.cpu.loadavg.map((x) => x.toFixed(2)).join(" / ");
        $("mem-pct").textContent = s.memory.percent.toFixed(1) + "%";
        $("mem-bar").style.width = s.memory.percent + "%";
        $("mem-meta").textContent = fmtSize(s.memory.used) + " / " + fmtSize(s.memory.total);
        $("swap-bar").style.width = (s.memory.swap_percent || 0) + "%";
        $("swap-meta").textContent = "Swap: " + fmtSize(s.memory.swap_used || 0) + " / " + fmtSize(s.memory.swap_total || 0);
        $("disk-pct").textContent = s.disk.percent.toFixed(1) + "%";
        $("disk-bar").style.width = s.disk.percent + "%";
        $("disk-meta").textContent = fmtSize(s.disk.used) + " / " + fmtSize(s.disk.total);
        $("disk-root-bar").style.width = (s.disk.system_percent || 0) + "%";
        $("disk-root-meta").textContent = "System disk: " + fmtSize(s.disk.system_used || 0) + " used";
        const rows = [
          ["Hostname", s.hostname], ["Platform", s.platform + " " + (s.arch || "")],
          ["Kernel", s.release], ["Python", s.python],
          ["Uptime", s.uptime], ["Processes", String(s.processes)],
          ["Net sent", fmtSize(s.network ? s.network.sent : 0)], ["Net recv", fmtSize(s.network ? s.network.recv : 0)],
        ];
        const dl = $("host-info");
        dl.innerHTML = "";
        rows.forEach(([k, v]) => {
          const dt = el("dt"); dt.textContent = k;
          const dd = el("dd"); dd.textContent = v;
          dl.append(dt, dd);
        });
        this.drawCpu(s.cpu.percent);
      } catch (e) { if (!keep) toast("Failed to load system info", true); }
    },
    drawCpu(pct) {
      this.cpuHist.push(pct);
      if (this.cpuHist.length > 60) this.cpuHist.shift();
      const c = $("cpu-chart");
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.height;
      c.width = w * dpr; c.style.height = h + "px";
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let gy = 0; gy <= 4; gy++) {
        ctx.beginPath();
        ctx.moveTo(0, (h / 4) * gy);
        ctx.lineTo(w, (h / 4) * gy);
        ctx.stroke();
      }
      const pts = this.cpuHist;
      if (pts.length < 2) return;
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(79,140,255,0.45)");
      grad.addColorStop(1, "rgba(79,140,255,0)");
      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = (i / (pts.length - 1)) * w;
        const py = h - (p / 100) * (h - 6) - 3;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.strokeStyle = "#4f8cff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    },
    activate() {
      this.refresh(true);
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (document.querySelector("#view-system.active")) this.refresh(true);
      }, 3000);
    },
  };

  /* ---------------- go ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    NxIcons.render();
    document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x.dataset.mode === state.mode));
    boot();
  });
})();
