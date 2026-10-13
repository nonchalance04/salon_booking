import { useId, useState } from "react";
import { money, type CatalogService } from "./public-site";
import type { ServiceFamily } from "./service-variants";
import { serviceMenuCategory } from "./service-categories";

export function ServiceFamilyOption({ family, selectedIds, onSelect }: {
  family: ServiceFamily<CatalogService>; selectedIds: string[]; onSelect: (service: CatalogService) => void;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const optionsId = useId();
  const selected = family.options.find(option => selectedIds.includes(option.service.id));
  const multiple = family.options.length > 1;
  const minimumPrice = Math.min(...family.options.map(option => Number(option.service.price)));
  const showOptions = expanded ?? Boolean(selected);
  function option(service: CatalogService, label: string) {
    const isSelected = selectedIds.includes(service.id);
    return <button type="button" className={`service-option ${isSelected ? "selected" : ""}`} key={service.id}
      aria-label={`Select ${service.name} (${service.category})`} aria-pressed={isSelected} onClick={() => onSelect(service)}>
      <div><h3>{label}</h3><p className="service-duration">◷ {service.durationMinutes} min{isSelected && <span className="service-added">Selected</span>}</p>
        {service.description && service.description.trim().toLowerCase() !== serviceMenuCategory(service).toLowerCase() && <p className="muted">{service.description}</p>}
        <strong>{money(service.price)}</strong></div><span className="select-circle" aria-hidden="true">{isSelected ? "✓" : "＋"}</span>
    </button>;
  }
  if (!multiple) return option(family.options[0].service, family.options[0].service.name);
  return <section className={`service-family ${selected ? "selected" : ""}`} aria-label={family.name}>
    <button type="button" className="service-family-heading" aria-expanded={showOptions} aria-controls={optionsId}
      onClick={() => setExpanded(!showOptions)}>
      <span><strong>{family.name}</strong><span className="service-family-caption">{selected ? selected.label : `${family.options.length} options · From ${money(minimumPrice)}`}</span></span>
      <span aria-hidden="true">{showOptions ? "−" : "＋"}</span>
    </button>
    {showOptions && <div className="service-family-options" id={optionsId} role="group" aria-label={`${family.name} options`}>
      <p>Choose your option</p>{family.options.map(({ service, label }) => option(service, label))}
    </div>}
  </section>;
}
