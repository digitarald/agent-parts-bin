export function page(items, pageNumber, size) {
  if (!Number.isInteger(pageNumber) || pageNumber < 0) throw new Error('Invalid page');
  if (!Number.isInteger(size) || size < 1) throw new Error('Invalid size');
  const start = pageNumber * size;
  return items.slice(start, start + size);
}
