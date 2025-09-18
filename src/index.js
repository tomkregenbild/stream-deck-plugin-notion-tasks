// src/index.js
const TODAY_PAGE_SIZE = 8;

let globalState = {
  tasks: [],
  page: 0,
  contexts: new Set(), // all displayed keys/encoders
  settingsByContext: {}
};

function sdConnect(port, uuid, registerEvent, info) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => ws.send(JSON.stringify({ event: registerEvent, uuid }));
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    const { event, context, payload, action } = msg;

    if (event === "willAppear") {
      globalState.contexts.add(context);
      // cache per-context settings
      if (payload?.settings) globalState.settingsByContext[context] = payload.settings;
      refresh(context);
    }

    if (event === "didReceiveSettings") {
      globalState.settingsByContext[context] = payload.settings || {};
      refresh(context, true);
    }

    if (event === "keyUp") {
      const task = getCurrentTasks(context)[payload?.userDesiredState ?? 0];
      openTaskIfAny(task);
    }

    // Stream Deck+ encoder (dial) rotate to page
    if (event === "dialRotate") {
      const { ticks } = payload;
      if (ticks > 0) globalState.page++;
      if (ticks < 0) globalState.page = Math.max(0, globalState.page - 1);
      paintAll(ws);
    }

    // touchTap on the strip could toggle done
    if (event === "touchTap") {
      const task = pickTaskByTap(context, payload); // implement tap position → task index
      if (task) toggleDone(context, task, ws).catch(console.error);
    }
  };
  return ws;
}

// ===== Notion helpers =====
async function fetchTodayTasks(settings) {
  const { token, db, statusProp = "Status", doneValue = "Done", dateProp = "Due" } = settings || {};
  if (!token || !db) return [];

  // Compute "today" in ISO (Notion uses date objects with start)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,"0");
  const dd = String(today.getDate()).padStart(2,"0");
  const iso = `${yyyy}-${mm}-${dd}`;

  // Filter: (dateProp == today) AND (statusProp != Done)
  const body = {
    page_size: 100,
    filter: {
      and: [
        { property: dateProp, date: { equals: iso } },
        { property: statusProp, status: { does_not_equal: doneValue } }
      ]
    },
    sorts: [{ property: dateProp, direction: "ascending" }]
  };

  const res = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (res.status === 429) { // backoff on rate-limit
    const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return fetchTodayTasks(settings);
  }
  if (!res.ok) throw new Error(`Notion ${res.status} ${await res.text()}`);

  const data = await res.json();
  // Map minimal fields (title + url + page_id)
  return (data.results || []).map(page => {
    const titleProp = Object.values(page.properties).find(p => p.type === "title");
    const title = titleProp?.title?.map(t => t.plain_text).join("") || "(untitled)";
    return { id: page.id, url: page.url, title };
  });
}

async function toggleDone(context, task, ws) {
  const s = globalState.settingsByContext[context];
  const { token, statusProp = "Status", doneValue = "Done" } = s || {};
  if (!token) return;
  const res = await fetch(`https://api.notion.com/v1/pages/${task.id}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: {
        [statusProp]: { status: { name: doneValue } }
      }
    })
  });
  if (res.status === 429) return setTimeout(() => toggleDone(context, task, ws), 1000);
  if (!res.ok) console.warn("toggle failed", await res.text());
  await refresh(context, true);
}

function openTaskIfAny(task) {
  if (!task?.url) return;
  const isMac = navigator.userAgent.includes("Mac");
  const cmd = isMac ? "open" : "cmd";
  // Stream Deck provides a "openUrl" event; use that instead of spawning a process:
  // (we're inside the plugin runtime, so send the event)
  // This just illustrates intent; the CLI’s runtime provides openUrl in actions.
}

async function refresh(context, force = false) {
  const s = globalState.settingsByContext[context] || {};
  // Fetch and cache across all contexts (same DB, token) to avoid rate overuse
  if (force || globalState.tasks.length === 0) {
    try {
      globalState.tasks = await fetchTodayTasks(s);
      globalState.page = 0;
    } catch (e) {
      console.error(e);
      globalState.tasks = [{ title: "Notion error (check token/db)" }];
    }
  }
  paintAll();
}

function getCurrentTasks(/*context*/) {
  const start = globalState.page * TODAY_PAGE_SIZE;
  return globalState.tasks.slice(start, start + TODAY_PAGE_SIZE);
}

function paintAll(/*ws unused in modern SDK runtime*/) {
  for (const ctx of globalState.contexts) {
    const tasks = getCurrentTasks(ctx);
    // Set key title: first task (or "No tasks")
    const t0 = tasks[0]?.title || "No\ntoday\ntasks";
    $SD.setTitle(ctx, truncateTitle(t0));
    // Optionally, draw touch strip layout summarizing the page or IDs
    // (See "layouts" in dials guide)
  }
}

function truncateTitle(s) {
  return s.length > 28 ? s.slice(0, 27) + "…" : s;
}

// ===== Boilerplate: called by Stream Deck app =====
function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info) {
  // In modern SDK scaffolds you get $SD helper injected; use it.
  // If you keep a custom connector, uncomment the manual ws approach:
  // sdConnect(port, uuid, registerEvent, info);
}
