class ApiError extends Error {
	private httpCode_: number;

	public constructor(message: string, httpCode = 400) {
		super(message);
		this.httpCode_ = httpCode;
	}

	public get httpCode() {
		return this.httpCode_;
	}
}

export class ErrorMethodNotAllowed extends ApiError {
	public constructor(message = 'Method Not Allowed') {
		super(message, 405);
	}
}
export class ErrorNotFound extends ApiError {
	public constructor(message = 'Not Found') {
		super(message, 404);
	}
}
export class ErrorForbidden extends ApiError {
	public constructor(message = 'Forbidden') {
		super(message, 403);
	}
}
export class ErrorBadRequest extends ApiError {
	public constructor(message = 'Bad Request') {
		super(message, 400);
	}
}

/** Represents a BaseModel user-side validation failure returned to an API caller. */
export class ErrorValidation extends ApiError {
	/** Marker used by ClipperServer to return the stable validation response shape. */
	public readonly code = 'validation_error';

	/** Creates a bad-request error while preserving the model validation message. */
	public constructor(message: string) {
		super(message, 400);
	}
}
