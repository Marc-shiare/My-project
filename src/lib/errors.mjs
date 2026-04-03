export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = undefined) {
    super("VALIDATION_ERROR", message, 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(message, details = undefined) {
    super("CONFLICT", message, 409, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message, details = undefined) {
    super("NOT_FOUND", message, 404, details);
  }
}

export class AuthorizationError extends AppError {
  constructor(message, details = undefined) {
    super("FORBIDDEN", message, 403, details);
  }
}

export class IntegrityError extends AppError {
  constructor(message, details = undefined) {
    super("INTEGRITY_ERROR", message, 500, details);
  }
}

export function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("INTERNAL_ERROR", error?.message ?? "Unexpected failure.", 500);
}
