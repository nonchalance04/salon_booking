type StaffHistory = {
  staffFirstNameSnapshot?: string;
  staffLastNameSnapshot?: string;
  staff?: { firstName: string; lastName: string } | null;
};

export function historicalStaff(row: StaffHistory) {
  return {
    firstName: row.staffFirstNameSnapshot || row.staff?.firstName || "Deleted staff",
    lastName: row.staffFirstNameSnapshot ? (row.staffLastNameSnapshot ?? "") : (row.staff?.lastName ?? ""),
  };
}
