const PORT = 9223;

async function exportCurrentWindowTabs() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  tabs.sort((a, b) => a.index - b.index);
  const payload = tabs.map(t => ({
    index: t.index,
    url: t.url,
    title: t.title,
  }));
  try {
    const res = await fetch(`http://localhost:${PORT}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[tab_exporter] sent", payload.length, "tabs ->", res.status);
  } catch (e) {
    console.warn("[tab_exporter] could not reach localhost:" + PORT, e);
  }
}

chrome.action.onClicked.addListener(exportCurrentWindowTabs);
chrome.commands.onCommand.addListener(cmd => {
  if (cmd === "export-tabs") exportCurrentWindowTabs();
});
