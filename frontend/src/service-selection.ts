export type ServiceCategory = { id: string; category: string };
export type ServiceSelection = { key: number; serviceId: string; staffId: string };

export function selectService(
  rows: ServiceSelection[], service: ServiceCategory, catalog: ServiceCategory[], key: number,
): ServiceSelection[] {
  // Repeated clicks never add another instance or discard the chosen professional.
  if (rows.some(row => row.serviceId === service.id)) return rows;
  const category = service.category.trim().toLowerCase();
  const index = rows.findIndex(row => catalog.find(item => item.id === row.serviceId)?.category.trim().toLowerCase() === category);
  const selection = { key, serviceId: service.id, staffId: "" };
  if (index < 0) return rows.length < 20 ? [...rows, selection] : rows;
  return rows.map((row, i) => i === index ? selection : row);
}
