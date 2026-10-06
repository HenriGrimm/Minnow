export const VISIBLE_MARKER = 'grep-fixture-visible';
export function visibleHelper() {
  return VISIBLE_MARKER;
}

// Literal code search fixtures:
// object.property
// items[0]
// value?.name ?? fallback
// const config = { enabled: true };
// total += price * quantity;
// ${value} | ^prefix$
// C:\workspace\src
// --flag
// -n
// Regex lookalikes must not match literal queries: objectXproperty items0
