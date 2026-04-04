import { ValidationError } from "../../lib/errors.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(identifier, field = "identifier") {
  if (typeof identifier !== "string" || !IDENTIFIER_PATTERN.test(identifier)) {
    throw new ValidationError(`${field} must match ${IDENTIFIER_PATTERN}`);
  }
  return `"${identifier}"`;
}

export function qualifyTable(schema, table) {
  return `${quoteIdentifier(schema, "schema")}.${quoteIdentifier(table, "table")}`;
}
