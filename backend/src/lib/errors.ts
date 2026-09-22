export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, message, details);
export const notFound = (message = 'Not found') => new ApiError(404, message);
export const conflict = (message: string, details?: unknown) => new ApiError(409, message, details);