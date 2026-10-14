type Service = { id: string; name: string };

// Only combine variants explicitly listed on the salon menu. Every choice
// retains its catalog ID, price, duration, and staff requirements.
const families = [
  { name: "Ladies Haircut", options: [
    ["Ladies Haircut", "Standard haircut"],
    ["Ladies Haircut w/ Blowdry", "With blowdry"],
    ["Ladies Haircut w/ Shampoo & Conditioner + Blowdry", "With shampoo & conditioner + blowdry"],
  ] },
  { name: "Men's Haircut", options: [
    ["Men's Haircut", "Standard haircut"],
    ["Men's Haircut w/ Blowdry & Shampoo", "With blowdry & shampoo"],
  ] },
  { name: "Kids Haircut", options: [
    ["Kids Haircut", "Standard haircut"],
    ["Kids Haircut w/ Blowdry", "With blowdry"],
  ] },
  { name: "Hair Color", options: [
    ["Hair Color (Short)", "Short hair"],
    ["Hair Color (Medium)", "Medium hair"],
    ["Hair Color (Long)", "Long hair"],
  ] },
  { name: "Rebonding", options: [
    ["Rebonding", "Standard rebonding"],
    ["Rebond with Color", "With color"],
    ["Rebonding with Color & Keratin", "With color & keratin"],
    ["Rebonding with Color & Brazilian", "With color & Brazilian"],
  ] },
  { name: "Foot Spa", options: [
    ["Foot Spa", "Standard foot spa"],
    ["Foot Spa with Pedicure", "With pedicure"],
  ] },
];

export type ServiceFamily<T extends Service> = { key: string; name: string; options: { label: string; service: T }[] };

export function groupServiceVariants<T extends Service>(services: T[]): ServiceFamily<T>[] {
  const groups = new Map<string, ServiceFamily<T>>();
  for (const service of services) {
    const normalized = service.name.trim().toLowerCase();
    const family = families.find(item => item.options.some(([name]) => name.toLowerCase() === normalized));
    const key = family ? `family:${family.name}` : `service:${service.id}`;
    const group = groups.get(key) ?? { key, name: family?.name ?? service.name, options: [] };
    group.options.push({ label: family?.options.find(([name]) => name.toLowerCase() === normalized)?.[1] ?? service.name, service });
    groups.set(key, group);
  }
  // Keep the menu's standard option first, regardless of API sorting.
  for (const group of groups.values()) {
    const family = families.find(item => `family:${item.name}` === group.key);
    if (family) group.options.sort((a, b) => family.options.findIndex(([name]) => name.toLowerCase() === a.service.name.trim().toLowerCase()) - family.options.findIndex(([name]) => name.toLowerCase() === b.service.name.trim().toLowerCase()));
  }
  return [...groups.values()];
}
