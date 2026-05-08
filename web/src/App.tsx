import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { detectMode, type ApiMode } from "./api/loader";
import { RunPicker } from "./components/RunPicker";
import CodeObjects from "./pages/CodeObjects";
import Configuration from "./pages/Configuration";
import Cost from "./pages/Cost";
import Dashboard from "./pages/Dashboard";
import Delta from "./pages/Delta";
import EstateOverview from "./pages/EstateOverview";
import Governance from "./pages/Governance";
import Help from "./pages/Help";
import PrintReport from "./pages/PrintReport";
import Recommendations from "./pages/Recommendations";
import Run from "./pages/Run";
import RunDiff from "./pages/RunDiff";
import Runbook from "./pages/Runbook";
import RunsHistory from "./pages/RunsHistory";
import Security from "./pages/Security";

const STATIC_NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/code-objects", label: "Code objects" },
  { to: "/recommendations", label: "Recommendations" },
  { to: "/runbook", label: "Runbook" },
  { to: "/delta", label: "Delta" },
  { to: "/cost", label: "Cost" },
  { to: "/governance", label: "Governance" },
  { to: "/security", label: "Security" },
  { to: "/help", label: "Help" },
];

const CONTROL_PLANE_NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/code-objects", label: "Code objects" },
  { to: "/recommendations", label: "Recommendations" },
  { to: "/runbook", label: "Runbook" },
  { to: "/cost", label: "Cost" },
  { to: "/governance", label: "Governance" },
  { to: "/security", label: "Security" },
  { to: "/run", label: "Run" },
  { to: "/runs", label: "Runs" },
  { to: "/diff", label: "Diff" },
  { to: "/configuration", label: "Configuration" },
  { to: "/help", label: "Help" },
];

export default function App() {
  const [mode, setMode] = useState<ApiMode | null>(null);

  useEffect(() => {
    detectMode().then(setMode).catch(() => setMode("static"));
  }, []);

  const nav = mode === "control-plane" ? CONTROL_PLANE_NAV : STATIC_NAV;

  return (
    <div className="layout">
      <header className="topbar">
        <Link to="/" className="brand">
          Synapse Migration Analyzer
        </Link>
        <nav className="nav">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        {mode === "control-plane" && (
          <div className="picker">
            <RunPicker />
          </div>
        )}
      </header>
      <main className="content">
        <Routes>
          {mode === "control-plane" ? (
            <>
              <Route path="/" element={<EstateOverview />} />
              <Route path="/dashboard" element={<Dashboard />} />
            </>
          ) : (
            <Route path="/" element={<Dashboard />} />
          )}
          <Route path="/code-objects" element={<CodeObjects />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/runbook" element={<Runbook />} />
          <Route path="/delta" element={<Delta />} />
          <Route path="/cost" element={<Cost />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="/security" element={<Security />} />
          <Route path="/help" element={<Help />} />
          <Route path="/help/:slug" element={<Help />} />
          {mode === "control-plane" && (
            <>
              <Route path="/run" element={<Run />} />
              <Route path="/runs" element={<RunsHistory />} />
              <Route path="/diff" element={<RunDiff />} />
              <Route path="/configuration" element={<Configuration />} />
              <Route path="/report/print" element={<PrintReport />} />
            </>
          )}
        </Routes>
      </main>
      <footer className="footer">
        <span>
          {mode === "control-plane"
            ? "Control plane — local FastAPI backend. No data leaves your machine."
            : "Static SPA — reads JSON outputs in place. No data leaves your machine."}
        </span>
      </footer>
    </div>
  );
}

