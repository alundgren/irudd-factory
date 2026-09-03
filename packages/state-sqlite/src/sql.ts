/**
 * Renders an assignment-state list as a SQL literal list. The schema check,
 * active-attempt indexes and admission queries all constrain the same states,
 * so they read the list from the contracts package.
 */
export function sqlStateList(states: ReadonlyArray<string>): string {
  return states.map((state) => `'${state}'`).join(", ");
}
