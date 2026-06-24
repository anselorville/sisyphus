import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import "./design-system/tokens/tokens.css";
import "./design-system/fonts/fonts.css";
import "./design-system/global/reset.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
