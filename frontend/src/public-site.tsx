import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { PublicBooking } from "./public-booking";
import { GuestAppointment } from "./booking";
import { Chatbot } from "./chatbot";
import { ChatbotWidget } from "./chatbot-widget";
import "./public-design.css";
import "./booking-design.css";
import "./reservation-design.css";
import "./phone-input.css";
import "./professional-picker.css";

export type CatalogService = {
  id: string;
  category: string;
  name: string;
  description: string | null;
  price: string;
  durationMinutes: number;
};
export type Salon = {
  profile: {
    name: string;
    address: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  timeZone: string;
};
export const money = (value: string | number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
    Number(value),
  );
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";

function Logo() {
  return (
    <a className="logo" href="/" aria-label="Clique Salon home">
      <span>CLIQUE</span>
      <small>salon and spa</small>
    </a>
  );
}
function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <div className="container header-row">
        <Logo />
        <nav
          className={`main-nav ${open ? "nav-open" : ""}`}
          aria-label="Main navigation"
        >
          {[
            ["/", "Home"],
            ["/services", "Services"],
            ["/about", "About Us"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className={window.location.pathname === href ? "active" : ""}
            >
              {label}
            </a>
          ))}
        </nav>
        <form action="/services" className="search-box">
          <input
            name="q"
            aria-label="Search services"
            placeholder="Searching for something?"
          />
          <button type="submit" aria-label="Search">
            ⌕
          </button>
        </form>
        <button
          className="icon-button mobile-menu"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "×" : "☰"}
        </button>
      </div>
    </header>
  );
}
function Artwork({ interior = false }: { interior?: boolean }) {
  return (
    <div className={`salon-art ${interior ? "interior-art" : ""}`}>
      {/* <div className="art-mirror" />
      <div className="art-chair" />
      <span className="art-caption">A little time for yourself.</span> */}
      <img src="/images/banner.jpg" alt="Clique salon banner" />
    </div>
  );
}
function About({ salon }: { salon: Salon | null }) {
  return (
    <section className="container about-section about-grid">
      <Artwork interior />
      <div>
        <p className="eyebrow">A LITTLE ABOUT CLIQUE</p>
        <h2 className="section-title">
          Your beauty.
          <br />
          <span className="gold">Our passion.</span>
        </h2>
        <p className="muted">
          A fresh look. A little care. A moment just for you. Explore our
          services and find a time with our salon professionals.
        </p>
        <div className="values-grid">
          {[
            ["♡", "Quality Service"],
            ["✂", "Salon Professionals"],
            ["☆", "Customer Care"],
          ].map(([icon, title]) => (
            <div key={title}>
              <span className="value-icon gold">{icon}</span>
              <h3>{title}</h3>
            </div>
          ))}
        </div>
        {salon?.profile && (
          <address className="salon-contact">
            <strong>{salon.profile.name}</strong>
            {salon.profile.address && <p>{salon.profile.address}</p>}
            {salon.profile.phone && (
              <p>
                <a href={`tel:${salon.profile.phone}`}>{salon.profile.phone}</a>
              </p>
            )}
            {salon.profile.email && (
              <p>
                <a href={`mailto:${salon.profile.email}`}>
                  {salon.profile.email}
                </a>
              </p>
            )}
          </address>
        )}
        <a className="text-link" href="/help">
          Opening hours & booking guidance →
        </a>
      </div>
    </section>
  );
}
function ServiceCards({ services }: { services: CatalogService[] }) {
  return (
    <div className="service-grid">
      {services.map((service, i) => (
        <article className="service-card" key={service.id}>
          <div
            className={`service-icon service-icon--${["scissors", "palette", "sparkles", "hand"][i % 4]}`}
            aria-hidden="true"
          >
            {["✂", "◈", "✧", "♡"][i % 4]}
          </div>
          <h3>{service.name}</h3>
          <p className="muted">
            {service.description || "Make a little time for yourself."}
          </p>
          <p className="muted">{service.durationMinutes} min</p>
          <div className="card-actions">
            <strong>{money(service.price)}</strong>
            <a
              className="text-link"
              href={`/booking?service=${encodeURIComponent(service.id)}`}
            >
              Book service ↗
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}
export function PublicSite() {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [salon, setSalon] = useState<Salon | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const [catalog, profile] = await Promise.all([
        api<{ services: CatalogService[] }>("/services"),
        api<Salon>("/salon"),
      ]);
      setServices(catalog.services);
      setSalon(profile);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const path = window.location.pathname;
  const [query, setQuery] = useState(
    new URLSearchParams(window.location.search).get("q") || "",
  );
  let content: ReactNode;
  const catalogStatus = (
    <>
      {loading && <p role="status">Loading salon services…</p>}
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>
      )}
      {!loading && !error && !services.length && (
        <p className="empty-state">
          No services are available for online booking yet.
        </p>
      )}
    </>
  );
  if (["/booking", "/availability"].includes(path))
    content = <PublicBooking salon={salon} />;
  else if (
    ["/a", "/appointment", "/booking-confirmed", "/manage", "/payment"].includes(path) ||
    path.startsWith("/confirmation/")
  )
    content = <GuestAppointment embedded salon={salon} />;
  else if (path === "/help") content = <Chatbot embedded />;
  else if (path === "/about")
    content = (
      <>
        <div className="container page-section">
          <p className="eyebrow">WELCOME TO CLIQUE</p>
          <h1 className="section-title">A little about us.</h1>
        </div>
        <About salon={salon} />
        {error && <div className="container">{catalogStatus}</div>}
      </>
    );
  else if (path === "/services")
    content = (
      <section className="container page-section">
        <p className="eyebrow">FIND YOUR NEXT FAVORITE</p>
        <h1 className="section-title">Our Services</h1>
        <p className="muted">
          A fresh look. A little care. A moment just for you.
        </p>
        <label className="catalog-search">
          Search services
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services"
          />
        </label>
        {catalogStatus}
        <ServiceCards
          services={services.filter((s) =>
            s.name.toLowerCase().includes(query.toLowerCase()),
          )}
        />
        {!loading &&
          !error &&
          services.length > 0 &&
          !services.some((s) =>
            s.name.toLowerCase().includes(query.toLowerCase()),
          ) && (
            <p className="empty-state">
              No matching services. Try another search.
            </p>
          )}
      </section>
    );
  else if (path === "/")
    content = (
      <>
        <section className="container hero hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">BEAUTY. CONFIDENCE. YOU.</p>
            <h1>
              Look Good.
              <br />
              <span>Feel Amazing.</span>
            </h1>
            <p className="hero-description">
              Discover our professional salon services
              <br /> and book your appointment with ease.
            </p>
            <a className="button button--primary hero-cta" href="/booking">
              Book an Appointment <span>→</span>
            </a>
            <a className="manage-link" href="/manage">
              ▦ Manage Existing Appointment
            </a>
          </div>
          <Artwork />
        </section>
        <section className="container services-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MADE FOR YOUR MOMENT</p>
              <h2 className="section-title">Browse Services</h2>
              <p className="muted">Explore our salon services.</p>
            </div>
            <a className="text-link" href="/services">
              View all services →
            </a>
          </div>
          {catalogStatus}
          <ServiceCards services={services.slice(0, 4)} />
        </section>
        <About salon={salon} />
      </>
    );
  else
    content = (
      <section className="container page-section">
        <h1 className="section-title">Page not found</h1>
        <a className="text-link" href="/">
          Return home
        </a>
      </section>
    );
  return (
    <div className="customer-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">{content}</main>
      <footer className="container site-footer footer-row">
        <Logo />
        <p>
          © {new Date().getFullYear()} {salon?.profile?.name || "Clique Salon"}
        </p>
        <div>
          <a href="/help">Salon guide ↗</a>
          <a href="/staff">Staff sign in ↗</a>
        </div>
      </footer>
      {path !== "/help" && <ChatbotWidget />}
    </div>
  );
}
