// Prix en euros : « € », « £ » et « ¥ » prennent plusieurs octets.
export function euros(amount: number): string {
  return amount > 0 ? `${amount} €` : '—'
}

export const pounds = (amount: number): string => `£${amount}`
