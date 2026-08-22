(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let term = null;
  let fitAddon = null;
  let ws = null;
  let opened = false;
  let usingFallback = false;

  function setStatus(on, text) {
    $("term-led").classList.toggle("on", !!on);
    $("term-status-text").textContent = text;
  }

  /* ---------- real xterm mode ---------- */
  function ensureTerm() {
    if (usingFallback || term) return true;
    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) return false;
    try {
      term = new window.Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        theme: { background: "rgba(0,0,0,0)", foreground: "#d8e0ee", cursor: "#4f8cff", selectionBackground: "rgba(79,140,255,0.35)" },
      });
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open($("term-wrap"));
      term.onData((d) => { if (ws && ws.readyState === 1) ws.send(d); });
      new ResizeObserver(() => fitTerm()).observe($("term-wrap"));
      return true;
    } catch (e) {
      console.error("xterm init failed:", e);
      term = null;
      return false;
    }
  }

  function fitTerm() {
    if (!term || usingFallback) return;
    try {
      fitAddon.fit();
      if (ws && ws.readyState === 1) {
        const r = fitAddon.proposeDimensions();
        if (r) ws.send(JSON.stringify({ type: "resize", rows: r.rows, cols: r.cols }));
      }
    } catch (_) {}
  }

  function writeOut(data) {
    if (usingFallback && window.NxFbTerm) NxFbTerm.write(data);
  }

  /* ---------- fallback simple terminal ---------- */
  function ensureFallback() {
    if ($("fb-term")) return;
    usingFallback = true;
    const wrap = $("term-wrap");
    wrap.innerHTML = "";
    const out = document.createElement("pre");
    out.id = "fb-out";
    out.style.cssText = "flex:1;overflow-y:auto;margin:0;padding:10px;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#d8e0ee;white-space:pre-wrap;word-break:break-all;";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;padding:8px;border-top:1px solid rgba(255,255,255,.09);";
    const prompt = document.createElement("span");
    prompt.textContent = "$";
    prompt.style.cssText = "color:#4f8cff;font-family:'JetBrains Mono',monospace;font-weight:700;";
    const inp = document.createElement("input");
    inp.id = "fb-in";
    inp.type = "text";
    inp.placeholder = "Type a command and press Enter…";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.style.cssText = "flex:1;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);color:#e7ecf5;border-radius:8px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;";
    const send = document.createElement("button");
    send.className = "btn btn-primary btn-sm";
    send.textContent = "Send";
    row.append(prompt, inp, send);
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.append(out, row);

    const hist = [];
    let hi = 0;
    const doSend = () => {
      const cmd = inp.value;
      if (!ws || ws.readyState !== 1) { setStatus(false, "Not connected"); return; }
      if (cmd.trim()) { hist.push(cmd); }
      hi = hist.length;
      ws.send(cmd + "\n");
      inp.value = "";
    };
    send.addEventListener("click", doSend);
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") doSend();
      else if (ev.key === "ArrowUp") { ev.preventDefault(); if (hi > 0) inp.value = hist[--hi] || ""; }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); hi = Math.min(hi + 1, hist.length); inp.value = hist[hi] || ""; }
    });
    setTimeout(() => inp.focus(), 80);

    const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
    window.NxFbTerm = {
      write(data) {
        let s = typeof data === "string" ? data : "";
        if (!s) return;
        out.textContent += s.replace(ANSI, "");
        while (out.childNodes.length > 5000) out.removeChild(out.firstChild);
        out.scrollTop = out.scrollHeight;
      },
      focus() { inp.focus(); },
    };
  }

  /* ---------- connection ---------- */
  function connect() {
    kill(true);
    if (!ensureTerm()) ensureFallback();
    if (usingFallback) { if (window.NxFbTerm) NxFbTerm.write(""); }
    else term.reset();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const token = localStorage.getItem("nexus_token") || "";
    const cwdSel = $("term-cwd").value;
    let url = proto + "://" + location.host + "/ws/terminal?token=" + encodeURIComponent(token);
    if (cwdSel) url += "&cwd=" + encodeURIComponent(cwdSel);
    setStatus(false, "Connecting…");
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus(false, "Connection failed");
      return;
    }
    opened = false;

    ws.onopen = () => {
      opened = true;
      setStatus(true, "Connected");
      if (usingFallback) { setStatus(true, "Connected (basic mode)"); }
      else fitTerm();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "exit") { setStatus(false, "Session ended"); return; }
        } catch (_) {}
        usingFallback ? writeOut(ev.data) : term.write(ev.data);
      } else {
        ev.data.arrayBuffer().then((b) => {
          const bytes = new Uint8Array(b);
          const dec = new TextDecoder();
          if (usingFallback) writeOut(dec.decode(bytes));
          else term.write(bytes);
        });
      }
    };
    ws.onclose = () => setStatus(opened ? false : false, opened ? "Disconnected" : "Connection rejected");
    ws.onerror = () => setStatus(false, "Error");
  }

  function kill(silent) {
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    if (!silent) setStatus(false, "Killed");
  }

  function setCwdOption(path) {
    const sel = $("term-cwd");
    const existing = [...sel.options].find((o) => o.value === path);
    if (!existing) {
      const o = document.createElement("option");
      o.value = path;
      o.textContent = path === "/" ? "/ (root)" : path;
      sel.append(o);
    }
  }

  window.NxTerm = {
    activate() {
      if (!ws || ws.readyState > 1) connect();
      else setTimeout(fitTerm, 50);
      if (usingFallback && window.NxFbTerm) NxFbTerm.focus();
    },
    setCwdOption,
  };

  document.addEventListener("DOMContentLoaded", () => {
    $("term-new").addEventListener("click", connect);
    $("term-kill").addEventListener("click", () => kill(false));
    $("term-wrap").addEventListener("click", () => {
      if (usingFallback && window.NxFbTerm) { const i = $("fb-in"); if (i && !getSelection().toString()) i.focus(); }
      else if (term) term.focus();
    });
  });
})();
