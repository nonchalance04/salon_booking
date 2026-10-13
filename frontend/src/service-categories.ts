// Customer-facing groups from the salon price list. Booking skill categories
// remain separate so browsing does not change service selection rules.
export const menuCategories = [
  "Hair Services", "Hair Color & Styling", "Hair Treatments",
  "Nail Services", "Spa & Relaxation",
] as const;

export function serviceMenuCategory(service: { category: string; description: string | null }): string {
  const label = service.description?.trim();
  const aliases: Record<string, string> = { hair: "Hair Services", nails: "Nail Services" };
  return menuCategories.find(category => category.toLowerCase() === label?.toLowerCase())
    ?? aliases[service.category.trim().toLowerCase()]
    ?? (service.category.trim() || "Other Services");
}
