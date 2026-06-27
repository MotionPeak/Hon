/** The name to SHOW for a transaction: the user's custom title when set,
 *  otherwise the scraped description. The description remains the grouping /
 *  categorization key everywhere else — this is display-only. */
export function displayName(t: { customTitle?: string | null; description: string }): string {
  const title = t.customTitle?.trim();
  return title ? title : t.description;
}
