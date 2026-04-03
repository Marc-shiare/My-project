import { AuthorizationError, ValidationError } from "./errors.mjs";

function fail(field, message) {
  throw new ValidationError(`${field}: ${message}`);
}

export function ensureObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be an object");
  }
  return value;
}

export function ensureString(value, field, options = {}) {
  const { min = 1, max = undefined, pattern = undefined } = options;
  if (typeof value !== "string") {
    fail(field, "must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length < min) {
    fail(field, `must be at least ${min} characters`);
  }

  if (max !== undefined && trimmed.length > max) {
    fail(field, `must be at most ${max} characters`);
  }

  if (pattern && !pattern.test(trimmed)) {
    fail(field, "has an invalid format");
  }

  return trimmed;
}

export function ensureOptionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return ensureString(value, field, options);
}

export function ensureInteger(value, field, options = {}) {
  const { min = undefined, max = undefined } = options;
  if (!Number.isInteger(value)) {
    fail(field, "must be an integer");
  }

  if (min !== undefined && value < min) {
    fail(field, `must be >= ${min}`);
  }

  if (max !== undefined && value > max) {
    fail(field, `must be <= ${max}`);
  }

  return value;
}

export function ensureNumber(value, field, options = {}) {
  const { min = undefined, max = undefined } = options;
  if (typeof value !== "number" || Number.isNaN(value)) {
    fail(field, "must be a number");
  }

  if (min !== undefined && value < min) {
    fail(field, `must be >= ${min}`);
  }

  if (max !== undefined && value > max) {
    fail(field, `must be <= ${max}`);
  }

  return value;
}

export function ensureArray(value, field, itemValidator = (item) => item) {
  if (!Array.isArray(value)) {
    fail(field, "must be an array");
  }

  return value.map((item, index) => itemValidator(item, `${field}[${index}]`));
}

export function ensureEnum(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    fail(field, `must be one of ${allowedValues.join(", ")}`);
  }
  return value;
}

export function ensureCurrency(value, field = "currency") {
  return ensureString(value, field, { min: 3, max: 3, pattern: /^[A-Z]{3}$/ });
}

export function ensureIsoDate(value, field) {
  const normalized = ensureString(value, field, { min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    fail(field, "must be a valid ISO date");
  }
  return normalized;
}

export function ensureStringArray(value, field) {
  return ensureArray(value ?? [], field, (item, itemField) => ensureString(item, itemField, { min: 1, max: 120 }));
}

export function ensureActor(actor) {
  const normalized = ensureObject(actor, "actor");
  return {
    actorId: ensureString(normalized.actorId, "actor.actorId", { max: 80 }),
    displayName: ensureString(normalized.displayName ?? normalized.actorId, "actor.displayName", { max: 120 }),
    roles: ensureStringArray(normalized.roles ?? [], "actor.roles"),
  };
}

export function ensureHasRole(actor, requiredRoles) {
  const actorRoles = new Set(actor.roles);
  const matches = requiredRoles.some((role) => actorRoles.has(role));
  if (!matches) {
    throw new AuthorizationError(`Actor requires one of roles: ${requiredRoles.join(", ")}`);
  }
}
