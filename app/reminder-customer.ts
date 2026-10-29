// Resolve only against the authenticated customer's list returned by the API.
// Never fetch an arbitrary notification-supplied customer identifier directly.
export function reminderCustomer<T extends { id: number }>(search: string, customers: T[]) {
  const values = new URLSearchParams(search).getAll("customer");
  if (values.length === 0) return { requested: false, customer: null };
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return { requested: true, customer: null };
  const id = Number(values[0]);
  if (!Number.isSafeInteger(id)) return { requested: true, customer: null };
  return { requested: true, customer: customers.find(customer => customer.id === id) || null };
}
