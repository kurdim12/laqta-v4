import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";

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
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
