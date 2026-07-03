import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { boot } from "./store/store";
import { installDevShim } from "./lib/devShim";
import "./styles/app.css";

installDevShim();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void boot();
