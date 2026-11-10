export function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s/gu, "-")
    .replace(/[^\p{L}\p{N}\p{M}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
