export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const invalidRequest = (message = 'A kérés nem érvényes.') =>
  new ApiError(400, 'INVALID_REQUEST', message);

export const unauthorized = () =>
  new ApiError(401, 'UNAUTHORIZED', 'A hitelesítés sikertelen vagy lejárt.');

export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'A művelet nem engedélyezett.');

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'A kért erőforrás nem található.');

export const conflict = (message = 'A művelet ebben az állapotban nem hajtható végre.') =>
  new ApiError(409, 'STATE_CONFLICT', message);
