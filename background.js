chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FETCH_JSON" && msg.url) {
    (async () => {
      try {
        const res = await fetch(msg.url, { cache: "no-store", credentials: "include" });
        const text = await res.text();

        if (!res.ok) {
          return sendResponse({ ok: false, status: res.status, text: text.slice(0, 500) });
        }

        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return sendResponse({ ok: false, status: 0, text: "not json: " + text.slice(0, 200) });
        }

        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, status: 0, text: String(e && e.message ? e.message : e) });
      }
    })();

    return true; // keep channel open
  }
});