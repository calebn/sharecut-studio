(() => {
  const ROUTES = {
    "": { file: "home.md", title: "Home", nav: "home" },
    home: { file: "home.md", title: "Home", nav: "home" },
    quickstart: { file: "quickstart.md", title: "Quickstart", nav: "quickstart" },
    capabilities: {
      file: "capabilities.md",
      title: "Capabilities",
      nav: "capabilities",
    },
    "document-commands": {
      file: "document-commands.md",
      title: "Document commands",
      nav: "document-commands",
    },
    "share-http": { file: "share-http.md", title: "Share HTTP", nav: "share-http" },
    "remote-mcp": { file: "remote-mcp.md", title: "Remote MCP", nav: "remote-mcp" },
    errors: { file: "errors.md", title: "Errors & limits", nav: "errors" },
    "threat-model": { file: "threat-model.md", title: "Threat model", nav: "threat-model" },
  };

  const contentEl = document.getElementById("content");
  const copyBtn = document.getElementById("copy-md");
  const rawLink = document.getElementById("raw-link");
  let currentMarkdown = "";
  let currentFile = "home.md";
  let mermaidReady = null;

  function routeKey() {
    const hash = (location.hash || "#/").replace(/^#\/?/, "");
    return hash.split("?")[0].replace(/\/$/, "") || "";
  }

  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  async function ensureMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(
      (mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
        });
        return mermaid;
      },
    );
    return mermaidReady;
  }

  function rewriteInternalLinks(html) {
    return html
      .replace(
        /href="#\/(capabilities|document-commands|share-http|remote-mcp|quickstart|errors|threat-model|home)?"/g,
        (m) => m,
      )
      .replace(/src="\.\.\/assets\//g, 'src="./assets/');
  }

  function extractMermaid(md) {
    const blocks = [];
    const replaced = md.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
      const id = `mermaid-${blocks.length}`;
      blocks.push({ id, code: code.trim() });
      return `\n\n<div class="mermaid" id="${id}"></div>\n\n`;
    });
    return { md: replaced, blocks };
  }

  async function renderPage() {
    const key = routeKey();
    const route = ROUTES[key] || ROUTES[""];
    currentFile = route.file;
    document.title = `${route.title} · Podcast MCP Docs`;

    document.querySelectorAll(".top__nav a").forEach((a) => {
      const nav = a.getAttribute("data-nav");
      if (nav === route.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });

    const base = new URL(`./pages/${route.file}`, window.location.href).href;
    rawLink.href = `https://github.com/calebn/sharecut-studio/blob/main/docs-site/pages/${route.file}`;
    rawLink.textContent = "Raw on GitHub";

    contentEl.innerHTML = `<p class="loading">Loading ${route.file}…</p>`;

    try {
      const res = await fetch(base, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      currentMarkdown = await res.text();
      const { md, blocks } = extractMermaid(currentMarkdown);
      const html = rewriteInternalLinks(marked.parse(md, { gfm: true, breaks: false }));
      contentEl.innerHTML = html;

      if (blocks.length) {
        const mermaid = await ensureMermaid();
        for (const block of blocks) {
          const node = document.getElementById(block.id);
          if (!node) continue;
          const { svg } = await mermaid.render(`${block.id}-svg`, block.code);
          node.innerHTML = svg;
        }
      }

      contentEl.focus({ preventScroll: true });
    } catch (err) {
      contentEl.innerHTML = `<p>Failed to load <code>${route.file}</code>: ${String(err.message || err)}</p>`;
      currentMarkdown = "";
    }
  }

  copyBtn.addEventListener("click", async () => {
    if (!currentMarkdown) {
      toast("Nothing to copy yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(currentMarkdown);
      toast(`Copied ${currentFile}`);
    } catch {
      toast("Clipboard blocked — use Raw on GitHub");
    }
  });

  window.addEventListener("hashchange", renderPage);
  if (!location.hash) location.hash = "#/";
  else renderPage();
})();
