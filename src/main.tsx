import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

// HashRouter, not BrowserRouter, and the reason is the deployment model rather than taste.
// The contract requires a drag-and-drop folder: no build step on the host, no rewrite rules.
// With path routing, opening /wall/lynk-and-co directly asks the host for /wall/assets/... ,
// which a plain static host answers with index.html - and the app never boots. A refresh at
// /booth 404s for the same reason. Hash routes resolve every asset from the document root, so
// a wall screen and a booth tablet can be opened straight at their own URL on any host.
//
// The service worker is what makes every station installable and lets the shell open with no
// network at all. Registration failing is never fatal: the app still runs, it just will not
// survive an outage, and Phase 1's outbox is what turns that from a nicety into the law.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* Non-fatal: an uninstalled worker is a degraded station, not a broken one. */
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </I18nProvider>
  </React.StrictMode>,
);
