// Error type shared by the service modules. Messages cross the loopback API, so
// they must stay actionable without containing raw config, tokens or stacks.
export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST') => new ServiceError(400, code, message);

export const notFound = (message = 'Route not found.', code = 'NOT_FOUND') =>
  new ServiceError(404, code, message);

export const conflict = (message, code) => new ServiceError(409, code, message);

export const unauthorized = () => new ServiceError(401, 'UNAUTHORIZED', 'A host bearer token is required.');

// Unexpected failures surface as one fixed sentence. Details go to the service
// log, never to the caller.
export function toPublicError(error) {
  if (error instanceof ServiceError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'INTERNAL',
    message: 'The service could not complete the request. Nothing was changed.',
  };
}
