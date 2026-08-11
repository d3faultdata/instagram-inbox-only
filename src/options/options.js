/**
 * Options UI. Every mutation goes through InboxOnly.requestAction, so the
 * commitment delay is enforced by the config layer rather than by this page —
 * bypassing the UI does not bypass the delay.
 */
(function () {
  const {
    loadConfig,
    saveConfig,
    requestAction,
    cancelPending,
    actionLoosens,
  } = globalThis.InboxOnly;

  const sitesEl = document.getElementById("sites");
  const pendingSection = document.getElementById("pending-section");
  const pendingList = document.getElementById("pending-list");
  const addForm = document.getElementById("add-site");
  const addError = document.getElementById("add-error");
  const delayForm = document.getElementById("delay-form");

  let config = null;

  async function dispatch(action) {
    const result = requestAction(config, action);
    config = await saveConfig(result.config);
    render();
    return result;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "applying…";
    const minutes = Math.ceil(ms / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function renderPending() {
    const pending = config.pending || [];
    pendingSection.hidden = pending.length === 0;
    pendingList.replaceChildren(
      ...pending.map((entry) => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${entry.label} — in ${formatCountdown(
          entry.applyAt - Date.now()
        )}`;
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.className = "secondary";
        cancel.addEventListener("click", async () => {
          config = await saveConfig(cancelPending(config, entry.id));
          render();
        });
        li.append(text, cancel);
        return li;
      })
    );
  }

  function renderSite(site) {
    const card = document.createElement("article");
    card.className = "site";
    card.dataset.siteId = site.id;
    if (site.enabled === false) card.classList.add("off");

    const head = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = site.label || site.id;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = site.enabled === false ? "not guarded" : "guarded";
    head.append(title, status);

    const hosts = document.createElement("p");
    hosts.className = "hint";
    hosts.textContent = `${site.hosts.join(", ")} → ${site.home}`;

    const list = document.createElement("ul");
    list.className = "paths";
    for (const path of site.allow) {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = path;
      const remove = document.createElement("button");
      remove.className = "secondary";
      remove.textContent = "Block";
      remove.addEventListener("click", () =>
        dispatch({ type: "removeAllowPath", siteId: site.id, path })
      );
      li.append(code, remove);
      list.append(li);
    }

    const addPath = document.createElement("form");
    addPath.className = "inline";
    const input = document.createElement("input");
    input.placeholder = "/some-path";
    input.required = true;
    const submit = document.createElement("button");
    submit.textContent = "Allow";
    addPath.append(input, submit);
    addPath.addEventListener("submit", async (event) => {
      event.preventDefault();
      const path = input.value.trim();
      if (!path.startsWith("/")) return;
      await dispatch({ type: "addAllowPath", siteId: site.id, path });
      input.value = "";
    });

    const actions = document.createElement("div");
    actions.className = "actions";
    const toggle = document.createElement("button");
    const enabling = site.enabled === false;
    toggle.textContent = enabling ? "Guard this site" : "Stop guarding";
    toggle.className = enabling ? "" : "danger";
    toggle.addEventListener("click", () =>
      dispatch({
        type: enabling ? "enableSite" : "disableSite",
        siteId: site.id,
      })
    );
    actions.append(toggle);

    if (!site.builtin) {
      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Remove site";
      remove.addEventListener("click", () =>
        dispatch({ type: "removeSite", siteId: site.id })
      );
      actions.append(remove);
    }

    card.append(head, hosts, list, addPath, actions);
    return card;
  }

  function render() {
    renderPending();
    sitesEl.replaceChildren(...config.sites.map(renderSite));
    delayForm.elements.minutes.value = config.guardDelayMinutes;
  }

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    addError.hidden = true;

    const data = new FormData(addForm);
    const host = String(data.get("host")).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const home = String(data.get("home")).trim() || "/";
    const label = String(data.get("label")).trim() || host;
    const allow = String(data.get("allow") || "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.startsWith("/"));

    if (!host.includes(".")) {
      addError.textContent = "That does not look like a domain.";
      addError.hidden = false;
      return;
    }
    if (!home.startsWith("/")) {
      addError.textContent = "The landing page must start with /.";
      addError.hidden = false;
      return;
    }
    if (config.sites.some((s) => s.hosts.includes(host))) {
      addError.textContent = "That domain is already in the list.";
      addError.hidden = false;
      return;
    }

    // Must be requested from the user gesture, before any await.
    const granted = await chrome.permissions.request({
      origins: [`*://${host}/*`, `*://*.${host}/*`],
    });
    if (!granted) {
      addError.textContent = "Permission for that domain was declined.";
      addError.hidden = false;
      return;
    }

    await dispatch({
      type: "addSite",
      site: {
        id: `custom_${host.replace(/[^a-z0-9]/g, "_")}`,
        label,
        hosts: [host],
        home,
        allow: allow.length ? allow : [home],
        hideChrome: true,
      },
    });
    addForm.reset();
  });

  delayForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const minutes = Number(new FormData(delayForm).get("minutes"));
    if (!Number.isFinite(minutes)) return;
    const action = { type: "setDelay", minutes };
    const queued = actionLoosens(action, config);
    await dispatch(action);
    if (queued) {
      delayForm.elements.minutes.value = config.guardDelayMinutes;
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes[globalThis.InboxOnly.STORAGE_KEY]) return;
    config = await loadConfig();
    render();
  });

  loadConfig().then((loaded) => {
    config = loaded;
    render();
    setInterval(renderPending, 30_000);
  });
})();
