// A list of chapter numbers, for example "1-3" or "2,5".
export function parseChapters(value: string): number[] {
  const numbers = new Set<number>();
  for (const part of value.split(",")) {
    const [start, end] = part.split("-").map((item) => Number(item.trim()));
    if (!start || Number.isNaN(start)) throw new Error(`"${value}" is not a valid chapter list.`);
    for (let n = start; n <= (end || start); n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}
