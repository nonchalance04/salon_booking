import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import "./staff-skills-editor.css";

type Service = { id: string; name: string; category: string; isActive: boolean };
type Qualification = { serviceId: string; commissionRate: string; isActive: boolean };
export function StaffSkillsEditor({ staffId, name, services, qualifications, busy, onBusy, onSaved, onError, onClose }: {
  staffId: string; name: string; services: Service[]; qualifications: Qualification[]; busy: boolean;
  onBusy: (busy: boolean) => void; onSaved: () => Promise<void>; onError: (error: unknown) => void; onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => new Set(qualifications.filter(row => row.isActive).map(row => row.serviceId)));
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries(services.map(service => {
    const qualification = qualifications.find(row => row.serviceId === service.id);
    return [service.id, qualification ? (Number(qualification.commissionRate) * 100).toFixed(2) : "40"];
  })));
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.focus(); form.current?.scrollIntoView({ block: "start" }); }, []);
  const groups = [...new Set(services.map(row => row.category))].sort((a, b) => a.localeCompare(b));
  const toggle = (id: string, checked: boolean) => setSelected(current => {
    const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next;
  });
  async function save(event: FormEvent) {
    event.preventDefault(); if (sending.current) return;
    sending.current = true; onBusy(true);
    try {
      await api(`/configuration/staff/${staffId}/skills`, { method: "PUT", body: JSON.stringify({
        services: [...selected].map(serviceId => ({ serviceId, commissionRate: (Number(rates[serviceId]) / 100).toFixed(4) })),
      }) });
      await onSaved();
    } catch (error) { onError(error); }
    finally { sending.current = false; onBusy(false); }
  }
  return <form ref={form} tabIndex={-1} className="account-form staff-skills-editor" onSubmit={save} aria-label={`Manage skills for ${name}`}>
    <h3>Manage skills · {name}</h3>
    <p className="muted">Select the services this staff member can perform. Categories organize the list; only checked services are eligible for booking.</p>
    <p role="status">{selected.size} service{selected.size === 1 ? "" : "s"} selected{selected.size === 0 ? " · This staff member will not be available for new bookings." : ""}</p>
    <fieldset disabled={busy} className="skills-fields">
      {groups.map(category => <fieldset className="skills-group" key={category}><legend>{category}</legend>
        {services.filter(row => row.category === category).map(service => <div className="skills-service" key={service.id}>
          <label className="skills-check"><input type="checkbox" checked={selected.has(service.id)} disabled={!service.isActive && !qualifications.some(row => row.serviceId === service.id && row.isActive)} onChange={event => toggle(service.id, event.target.checked)} />
            <span>{service.name}{!service.isActive && <small>Inactive service · unavailable for booking</small>}</span></label>
          {selected.has(service.id) && <label className="skills-rate">Commission (%)<input aria-label={`Commission for ${service.name} (%)`} type="number" required min="0" max="100" step="0.01" value={rates[service.id] ?? "40"} onChange={event => setRates(current => ({ ...current, [service.id]: event.target.value }))} /></label>}
        </div>)}
      </fieldset>)}
      {services.length === 0 && <p>No services configured. Add services before assigning staff skills.</p>}
      <p className="muted">Removing a service required by an upcoming reservation is blocked. Existing bookings keep their saved commission rates.</p>
      <div className="actions"><button className="primary">{busy ? "Saving…" : "Save skills"}</button><button type="button" onClick={onClose}>Cancel</button></div>
    </fieldset>
  </form>;
}
