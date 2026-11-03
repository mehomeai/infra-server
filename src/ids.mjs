import { randomUUID } from 'node:crypto';

// Identifiers are full UUIDs with a readable kind prefix (H2). They fit in
// 128 bits of entropy; clients must treat them as opaque strings and never
// parse, truncate, or guess them.
export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function newRequestKey() {
  return randomUUID();
}
