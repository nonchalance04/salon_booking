import { useState, type FormEvent } from "react";
import { SettlementWorkspace } from "./settlement";
import { ConfirmedServices } from "./confirmed-services";

export function CashierDashboard() {
  const [selected, setSelected] = useState<string | null>(null);
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    if (code) setSelected(code);
  }
  return (
    <section aria-labelledby="cashier-title">
      <p className="eyebrow">CASHIER DESK</p>
      <h2 id="cashier-title">Process payments</h2>
      <p className="muted">
        Select a visit ready for payment, verify the money received, and issue
        the receipt. An Admin records service outcomes before collection.
      </p>
      {selected ? (
        <SettlementWorkspace
          key={selected}
          admin={false}
          initialCode={selected}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <ConfirmedServices admin={false} onSelect={setSelected} />
          <details>
            <summary>Find a payment or receipt by booking code</summary>
            <form className="account-form cashier-search" onSubmit={search}>
              <label>
                Booking code
                <input
                  name="code"
                  required
                  maxLength={100}
                  placeholder="Enter booking code"
                />
              </label>
              <button className="primary">Find payment</button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
