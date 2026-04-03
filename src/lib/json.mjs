export function stableSerialize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`);
  return `{${pairs.join(",")}}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
