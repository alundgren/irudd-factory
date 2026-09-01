/**
 * Renders an assignment-state list as a SQL literal list. The schema check,
 * the one-active-assignment index and the admission query all constrain the
 * same states, so they read the list from the contracts package instead of
 * repeating it in three query strings.
 */
export function sqlStateList(states: ReadonlyArray<string>): string {
  return states.map((state) => `'${state}'`).join(", ");
}
