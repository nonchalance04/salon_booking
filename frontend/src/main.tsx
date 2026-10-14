import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, type User } from "./api";
import { AuthProvider, useAuth } from "./auth";
import "./style.css";
import { WorkspaceLayout } from "./workspace-layout";
import { PublicSite } from "./public-site";
import "./workspace-design.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";
function Login() {
  const { login } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await login(
        String(data.get("email")).trim().toLowerCase(),
        String(data.get("password")),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="clique-login">
      <section className="clique-login-card" aria-labelledby="login-title">
        <div className="clique-login-heading">
          <a href="/" id="login-title">
            CLIQUE HAIRCUTTERS
          </a>
          <p>
            Because you deserve more than just a beautiful look — you deserve a
            moment to relax, recharge, and feel your absolute best.
          </p>
        </div>
        <img
          className="clique-login-photo"
          src="https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1200&q=85"
          alt="A client enjoying a salon appointment"
        />
        <form onSubmit={submit} className="clique-login-form">
          <h1>Sign in to your workspace</h1>
          <label>
            Email address
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="Password"
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy} className="primary">
            {busy ? "Signing in…" : "Sign In"}
          </button>
          {/* <p className="clique-login-help">Need access or a password reset? Ask your salon administrator.</p>
        <a href="/availability">Find an available salon time →</a>
        <a href="/help">Questions? Ask the salon guide →</a> */}
        </form>
      </section>
    </main>
  );
}

function Accounts() {
  const { user, refresh } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setUsers((await api<{ users: User[] }>("/users")).users);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password && new TextEncoder().encode(password).length > 72) {
      setError("Password must fit within 72 UTF-8 bytes.");
      return;
    }
    const target = editing;
    const body = {
      firstName: String(data.get("firstName")),
      lastName: String(data.get("lastName")),
      email: String(data.get("email")).trim().toLowerCase(),
      role: String(data.get("role")),
      isActive: data.get("isActive") === "on",
      ...(password ? { password } : {}),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(target === "new" ? "/users" : `/users/${(target as User).id}`, {
        method: target === "new" ? "POST" : "PATCH",
        body: JSON.stringify(body),
      });
      setEditing(null);
      setNotice("Account saved.");
      if (target !== "new" && target?.id === user?.id) {
        await refresh();
        if (body.role === "ADMIN" && body.isActive) await load();
      } else await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const selected = editing && editing !== "new" ? editing : null;
  return (
    <section aria-labelledby="accounts-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">WORKSPACE ACCESS</p>
          <h2 id="accounts-title">People & permissions</h2>
          <p className="muted">Manage Admin and Cashier accounts.</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEditing("new");
            setError("");
            setNotice("");
          }}
        >
          + Add account
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          {!editing && <button onClick={() => void load()}>Retry</button>}
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {editing && (
        <form
          className="account-form"
          onSubmit={save}
          key={selected?.id ?? "new"}
        >
          <h3>{selected ? "Edit account" : "New account"}</h3>
          <div className="form-grid">
            <label>
              First name
              <input
                name="firstName"
                required
                maxLength={100}
                defaultValue={selected?.firstName}
              />
            </label>
            <label>
              Last name
              <input
                name="lastName"
                required
                maxLength={100}
                defaultValue={selected?.lastName}
              />
            </label>
            <label>
              Email address
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                defaultValue={selected?.email}
              />
            </label>
            <label>
              Role
              <select name="role" defaultValue={selected?.role ?? "CASHIER"}>
                <option value="CASHIER">Cashier</option>
                <option value="ADMIN">Admin</option>
              </select>
            </label>
            <label>
              {selected ? "New password (optional)" : "Password"}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required={!selected}
              />
              <small>
                At least 12 characters; no more than 72 UTF-8 bytes.
              </small>
            </label>
            <label className="checkbox">
              <input
                name="isActive"
                type="checkbox"
                defaultChecked={selected?.isActive ?? true}
              />{" "}
              Active account
            </label>
          </div>
          {selected?.id === user?.id && (
            <p className="muted">
              Changing your own role or active status changes your workspace
              access immediately.
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save account"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <p role="status">Loading accounts…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>
                      {account.firstName} {account.lastName}
                    </strong>
                    {account.id === user?.id && (
                      <small className="you">You</small>
                    )}
                  </td>
                  <td>{account.email}</td>
                  <td>{account.role === "ADMIN" ? "Admin" : "Cashier"}</td>
                  <td>
                    <span
                      className={`badge ${account.isActive ? "active" : ""}`}
                    >
                      {account.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>
                    <button
                      aria-label={`Edit ${account.firstName} ${account.lastName}`}
                      onClick={() => {
                        setEditing(account);
                        setError("");
                        setNotice("");
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Workspace() {
  return <WorkspaceLayout accounts={<Accounts />} />;
}
function App() {
  const { user, loading, error, refresh } = useAuth();
  if (loading)
    return (
      <main className="loading" role="status">
        Opening your workspace…
      </main>
    );
  if (error)
    return (
      <main className="loading">
        <h1>Unable to connect</h1>
        <p role="alert">{error}</p>
        <button onClick={() => void refresh()}>Try again</button>
      </main>
    );
  return user ? <Workspace /> : <Login />;
}
createRoot(document.getElementById("root")!).render(
  ["/staff", "/login", "/admin"].includes(window.location.pathname) ? (
    <AuthProvider>
      <App />
    </AuthProvider>
  ) : (
    <PublicSite />
  ),
);
