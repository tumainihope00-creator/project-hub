/**
 * Error categories. The UI must be able to tell these apart:
 *
 *  - DATA_MISSING     the project simply has no information recorded
 *  - VALIDATION_FAILED the request was malformed / options were invalid
 *  - SYSTEM_ERROR     the backend could not do its job (database, crash, timeout)
 *  - GENERATION_ERROR the generator ran but could not produce a usable prompt
 *  - NOT_FOUND        the project or record does not exist
 *
 * The document importer adds its own, so a failed import never looks like a
 * generic backend fault:
 *
 *  - DOCUMENT_ERROR   the uploaded file could not be read
 *  - EXTRACTION_ERROR information was found but could not be turned into a
 *                     usable structured result
 *  - MAPPING_ERROR    something was extracted but Project Hub has no structure
 *                     that can hold it
 *  - DATABASE_ERROR   the write itself was refused; the transaction rolled back
 *
 * A generic "Not found" is never an acceptable explanation, so every error
 * carries a category plus an operation describing what was being attempted.
 */
export type ErrorCategory =
  | 'DATA_MISSING'
  | 'VALIDATION_FAILED'
  | 'SYSTEM_ERROR'
  | 'GENERATION_ERROR'
  | 'NOT_FOUND'
  | 'DOCUMENT_ERROR'
  | 'EXTRACTION_ERROR'
  | 'MAPPING_ERROR'
  | 'DATABASE_ERROR'
  // Phase 3. A workspace folder that already exists is a conflict the user must
  // resolve, not a validation slip, and a filesystem refusal (permissions, a
  // read-only volume) is neither a bad request nor a plain system fault.
  | 'CONFLICT'
  | 'FILESYSTEM_ERROR';

export interface ApiErrorBody {
  message: string;
  category: ErrorCategory;
  /** What the system was trying to do. */
  operation?: string;
  /** What the user can do next. */
  possibleAction?: string;
  details?: unknown;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  category: ErrorCategory;
  operation?: string;
  possibleAction?: string;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    extra: { category?: ErrorCategory; operation?: string; possibleAction?: string } = {}
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.category = extra.category ?? (status === 404 ? 'NOT_FOUND' : 'SYSTEM_ERROR');
    this.operation = extra.operation;
    this.possibleAction = extra.possibleAction;
  }

  toBody(): ApiErrorBody {
    return {
      message: this.message,
      category: this.category,
      operation: this.operation,
      possibleAction: this.possibleAction,
      details: this.details
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, details, {
    category: 'VALIDATION_FAILED',
    operation: 'validate the request body',
    possibleAction: 'Correct the highlighted values and try again.'
  });

export const notFound = (message = 'Not found', operation?: string, possibleAction?: string) =>
  new ApiError(404, message, undefined, {
    category: 'NOT_FOUND',
    operation,
    possibleAction
  });

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, message, details, {
    category: 'VALIDATION_FAILED',
    operation: 'apply the change',
    possibleAction: 'Reload the page and try again.'
  });

export const dataMissing = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(422, message, details, {
    category: 'DATA_MISSING',
    operation,
    possibleAction
  });

export const generationFailed = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(500, message, details, {
    category: 'GENERATION_ERROR',
    operation,
    possibleAction
  });

export const systemError = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(500, message, details, {
    category: 'SYSTEM_ERROR',
    operation,
    possibleAction
  });

/** The uploaded file could not be read. Never used for anything else. */
export const documentError = (message: string, filename: string, operation: string, details?: unknown) =>
  new ApiError(422, message, details, {
    category: 'DOCUMENT_ERROR',
    operation,
    possibleAction: `"${filename}" could not be read. Try a different file, or export the content as .md or .txt.`
  });

/** The document was read, but no usable structured information came out. */
export const extractionError = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(422, message, details, {
    category: 'EXTRACTION_ERROR',
    operation,
    possibleAction
  });

/** Something was extracted that Project Hub has no existing structure for. */
export const mappingError = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(422, message, details, {
    category: 'MAPPING_ERROR',
    operation,
    possibleAction
  });

/** The database refused a write. The import was rolled back in full. */
export const databaseError = (message: string, operation: string, possibleAction: string, details?: unknown) =>
  new ApiError(500, message, details, {
    category: 'DATABASE_ERROR',
    operation,
    possibleAction
  });
