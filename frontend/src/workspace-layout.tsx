import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { Configuration } from "./configuration";
import { type Section } from "./configuration.fields";
import { AdminAppointments } from "./appointment-management";
import { SettlementWorkspace } from "./settlement";
import { Reports } from "./reports";
import { PaymentsWorkspace } from "./payments";
import { CashierDashboard } from "./cashier";
import { AdminDashboard, type AppointmentFilters } from "./admin-dashboard";
import { DashboardClock } from "./dashboard-clock";

type Page =
  | "dashboard"
  | "master"
  | "settings"
  | "reports"
  | "overview"
  | "appointments"
  | "payments"
  | "settlement"
  | "accounts"
  | "configuration"
  | "report-detail";
type IconName =
  | "grid"
  | "data"
  | "settings"
  | "chart"
  | "calendar"
  | "receipt"
  | "user"
  | "logout"
  | "scissors"
  | "clock"
  | "check";
const paths: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18M6 15l5-5 4 2 6-7M16 5h5v5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4m10-4v4M3 11h18M7 15h2m6 0h2m-10 3h2" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 7h6M9 11h6M9 15h3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="7" r="4" />
      <path d="M4 21v-3c0-7 16-7 16 0v3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 3H4v18h5m5-14 5 5-5 5M8 12h13" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="m8 8 13 13M8 16 21 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m7 12 3 3 7-7" />
    </>
  ),
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="23"
      height="23"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
type Card = {
  title: string;
  description: string;
  icon: IconName;
  page: Page;
  section?: Section;
  kind?: string;
};
const masterCards: Card[] = [
  {
    title: "Services",
    description: "Edit treatments, pricing, and duration",
    icon: "scissors",
    page: "configuration",
    section: "services",
  },
  {
    title: "Staff / Stylists",
    description: "Manage the people behind every appointment",
    icon: "user",
    page: "configuration",
    section: "staff",
  },
  {
    title: "Service assignments",
    description: "Manage staff qualifications and commission rates",
    icon: "check",
    page: "configuration",
    section: "qualifications",
  },
  {
    title: "Staff schedules",
    description: "Manage working hours and recurring shifts",
    icon: "calendar",
    page: "configuration",
    section: "schedules",
  },
  {
    title: "Staff time off",
    description: "Manage temporary absences and availability",
    icon: "clock",
    page: "configuration",
    section: "unavailability",
  },
];
const settingsCards: Card[] = [
  {
    title: "Manage Users",
    description: "Manage Admin and Cashier accounts",
    icon: "user",
    page: "accounts",
  },
  {
    title: "General Settings",
    description: "Customize salon details and contact information",
    icon: "settings",
    page: "configuration",
    section: "profile",
  },
  {
    title: "Appointment Settings",
    description: "Manage appointment fees and booking policies",
    icon: "calendar",
    page: "configuration",
    section: "policies",
  },
  {
    title: "Opening hours",
    description: "Set weekly salon operating hours",
    icon: "clock",
    page: "configuration",
    section: "hours",
  },
  {
    title: "Salon closures",
    description: "Manage temporary closures",
    icon: "calendar",
    page: "configuration",
    section: "closures",
  },
];
const reportCards: Card[] = [
  {
    title: "Sales Summary",
    description: "Review collections and payments",
    icon: "chart",
    page: "report-detail",
    kind: "payments",
  },
  {
    title: "Appointment Report",
    description: "Browse completed and upcoming client bookings",
    icon: "calendar",
    page: "report-detail",
    kind: "appointments",
  },
  {
    title: "Staff Commission Report",
    description: "Review finalized staff commissions",
    icon: "user",
    page: "report-detail",
    kind: "commissions",
  },
  {
    title: "Receipts",
    description: "Browse historical service receipts",
    icon: "receipt",
    page: "report-detail",
    kind: "receipts",
  },
  {
    title: "Audit history",
    description: "Review recorded system and account activity",
    icon: "data",
    page: "report-detail",
    kind: "audit",
  },
];
const overviewCards: Card[] = [
  {
    title: "Appointments",
    description: "View bookings, status, and reschedule appointments",
    icon: "calendar",
    page: "appointments",
  },
  {
    title: "Appointment fees",
    description: "Review and record appointment fee payments",
    icon: "receipt",
    page: "payments",
  },
  {
    title: "Outcomes & commissions",
    description: "Settle services and review staff commissions",
    icon: "check",
    page: "settlement",
  },
];
const adminNav: { page: Page; label: string; icon: IconName }[] = [
  { page: "dashboard", label: "Dashboard", icon: "grid" },
  { page: "master", label: "Salon Management", icon: "data" },
  { page: "settings", label: "Settings", icon: "settings" },
  { page: "reports", label: "Reports", icon: "chart" },
  { page: "overview", label: "Appointments", icon: "calendar" },
];
const cashierNav: typeof adminNav = [
  { page: "dashboard", label: "Services", icon: "data" },
  { page: "payments", label: "Payments", icon: "receipt" },
];
const headings: Partial<Record<Page, [string, string]>> = {
  master: ["Salon Management", "Core configurations and salon data"],
  settings: ["Settings", "Configure settings and manage system controls"],
  reports: ["Reports", "Collections and transaction history"],
  overview: ["Appointments", "Appointments, payments, and service outcomes"],
  accounts: ["Manage Users", "Workspace accounts and permissions"],
  configuration: [
    "Salon management",
    "Keep your salon’s information up to date",
  ],
  "report-detail": ["Reports", "Historical records and salon activity"],
  appointments: ["Appointments", "Review and manage salon bookings"],
  payments: [
    "Appointment fees",
    "Review booking obligations and payment history",
  ],
  settlement: [
    "Service payments",
    "Service outcomes, settlement, and receipts",
  ],
};
export function WorkspaceLayout({ accounts }: { accounts: ReactNode }) {
  const { user, logout } = useAuth();
  const admin = user?.role === "ADMIN";
  const [page, setPage] = useState<Page>("dashboard");
  const [section, setSection] = useState<Section>("profile");
  const [appointmentFilters, setAppointmentFilters] =
    useState<AppointmentFilters>({});
  const [bookingCode, setBookingCode] = useState<string | undefined>();
  const [cashierNavigation, setCashierNavigation] = useState({ busy: false, dirty: false });
  const [kind, setKind] = useState("appointments");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const menu = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menu.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  // A refreshed session can change role without unmounting the workspace.
  useEffect(() => {
    setPage("dashboard");
    setBookingCode(undefined);
    setCashierNavigation({ busy: false, dirty: false });
    setOpen(false);
    setSearch("");
  }, [user?.role]);
  function navigate(next: Page, code?: string) {
    if (!admin) {
      if (cashierNavigation.busy) return;
      if (cashierNavigation.dirty && !window.confirm("Discard unsaved changes and leave this view?")) return;
      setCashierNavigation({ busy: false, dirty: false });
      setBookingCode(code);
    }
    setPage(next);
    setSearch("");
    setOpen(false);
    requestAnimationFrame(() => {
      content.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  }
  function openAppointments(filters: AppointmentFilters) {
    setAppointmentFilters(filters);
    navigate("appointments");
  }
  function openBooking(next: "payments" | "settlement", code?: string) {
    setBookingCode(code);
    navigate(next);
  }
  function choose(card: Card) {
    setBookingCode(undefined);
    setAppointmentFilters({});
    if (card.section) setSection(card.section);
    if (card.kind) setKind(card.kind);
    navigate(card.page);
  }
  const active =
    page === "configuration"
      ? settingsCards.some((c) => c.section === section)
        ? "settings"
        : "master"
      : page === "accounts"
        ? "settings"
        : page === "report-detail"
          ? "reports"
          : admin && ["appointments", "payments", "settlement"].includes(page)
            ? "overview"
            : page;
  const cards = admin
    ? page === "master"
      ? masterCards
      : page === "settings"
        ? settingsCards
        : page === "reports"
          ? reportCards
          : page === "overview"
            ? overviewCards
            : null
    : null;
  const heading = !admin
    ? page === "payments"
      ? ["Payments", "Collect service payments and review receipts"]
      : ["Services", "Manage arrivals, service outcomes and no-show corrections"]
    : (headings[page] ?? [
        "CLIQUE SALON AND SPA",
        "Where everything you need meets you at the best time.",
      ]);
  return (
    <div
      className={`clique-workspace ${admin ? "clique-admin" : "clique-cashier"}`}
    >
      <a className="clique-skip" href="#workspace-content">
        Skip to workspace
      </a>
      <button
        ref={menu}
        className="clique-menu-toggle"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls="workspace-navigation"
        onClick={() => setOpen(!open)}
      >
        ☰
      </button>
      {open && (
        <button
          className="clique-scrim"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        id="workspace-navigation"
        className={`clique-sidebar${open ? " is-open" : ""}`}
      >
        <div className="clique-brand">
          <a className="clique-logo" href="/" aria-label="Clique Salon home">
            CLIQUE
          </a>
          <div>
            {/* <strong>{user?.firstName}</strong> */}
            <strong>{admin ? "ADMIN ACCOUNT" : "CASHIER ACCOUNT"}</strong>
          </div>
        </div>
        <nav aria-label={admin ? "Admin workspace" : "Cashier workspace"}>
          {(admin ? adminNav : cashierNav).map((item) => (
            <button
              key={item.page}
              aria-current={active === item.page ? "page" : undefined}
              disabled={!admin && cashierNavigation.busy}
              onClick={() => navigate(item.page)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="clique-sidebar-footer">
          {admin ? (
            <button onClick={() => navigate("accounts")}>
              <Icon name="user" />
              Account (admin)
            </button>
          ) : (
            <div className="clique-account">
              <Icon name="user" />
              {/* {user?.firstName} {user?.lastName} */}
              <div>Cashier Account</div>
              {/* <small>Cashier account</small> */}
            </div>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await logout();
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Unable to sign out.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="logout" />
            {busy ? "Signing out…" : "Log Out"}
          </button>
        </div>
      </aside>
      <div className="clique-content">
        <header
          className={`clique-topbar${page === "dashboard" ? " is-dashboard" : ""}`}
        >
          <div>
            <h1>{heading[0]}</h1>
            <p>{heading[1]}</p>
          </div>
          <DashboardClock />
        </header>
        <main
          ref={content}
          id="workspace-content"
          className="clique-main"
          tabIndex={-1}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {cards ? (
            <>
              {/* <label className="clique-search">
                <span className="sr-only">Search {heading[0]}</span>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="10" cy="10" r="7" />
                  <path d="m15 15 6 6" />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${heading[0].toLowerCase()}`}
                />
                input
              </label> */}
              <h2 className="clique-section-label">
                {page === "master"
                  ? "Core configurations"
                  : "Explore your workspace"}
              </h2>
              <div
                className={`clique-cards ${page === "master" ? "is-grid" : "is-list"}`}
              >
                {cards
                  .filter((card) =>
                    `${card.title} ${card.description}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((card) => (
                    <button
                      className="clique-card"
                      key={card.title}
                      onClick={() => choose(card)}
                    >
                      <span className="clique-card-icon">
                        <Icon name={card.icon} />
                      </span>
                      <span className="clique-card-copy">
                        <strong>{card.title}</strong>
                        <small>{card.description}</small>
                      </span>
                      <span className="clique-card-arrow" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
              </div>
              {!cards.some((card) =>
                `${card.title} ${card.description}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && (
                <p role="status" className="empty-state">
                  No options match your search.
                </p>
              )}
            </>
          ) : (
            <>
              {admin && page !== "dashboard" && (
                <button
                  className="clique-back"
                  onClick={() => navigate(active as Page)}
                >
                  ← Back to{" "}
                  {adminNav
                    .find((item) => item.page === active)
                    ?.label.replace("\n", " ")}
                </button>
              )}
              {page === "dashboard" && admin ? (
                <AdminDashboard
                  onSettlement={(code) => openBooking("settlement", code)}
                />
              ) : !admin ? (
                <CashierDashboard
                  mode={page === "payments" ? "payments" : "services"}
                  bookingCode={bookingCode}
                  onNavigate={(view, code) => navigate(view === "payments" ? "payments" : "dashboard", code)}
                  onNavigationStateChange={setCashierNavigation}
                />
              ) : page === "configuration" && admin ? (
                <Configuration
                  key={section}
                  initialSection={section}
                  onReviewBooking={(code) => openAppointments({ search: code })}
                />
              ) : page === "accounts" && admin ? (
                accounts
              ) : page === "appointments" && admin ? (
                <AdminAppointments
                  key={JSON.stringify(appointmentFilters)}
                  initialFilters={appointmentFilters}
                  onPayment={(code) => openBooking("payments", code)}
                  onSettlement={(code) => openBooking("settlement", code)}
                />
              ) : page === "payments" ? (
                <PaymentsWorkspace
                  key={bookingCode ?? "payments"}
                  admin={admin}
                  initialCode={bookingCode}
                />
              ) : page === "settlement" ? (
                <SettlementWorkspace
                  key={bookingCode ?? "settlement"}
                  admin={admin}
                  initialCode={bookingCode}
                  onBack={
                    bookingCode ? () => setBookingCode(undefined) : undefined
                  }
                />
              ) : (
                <Reports key={kind} admin={admin} initialKind={kind} />
              )}
            </>
          )}
        </main>
        <footer className="clique-content-footer">
          Clique Salon · {admin ? "Admin" : "Cashier"} workspace
        </footer>
      </div>
    </div>
  );
}
