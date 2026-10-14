import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

// Controllers read the parsed output from res.locals.validated. Query/params are
// not reassigned because Express 5 exposes req.query through a getter.
export function validateRequest(schema: z.ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (!result.success) {
      next(new ApiError(400, "VALIDATION_ERROR", "Invalid request data."));
      return;
    }
    res.locals.validated = result.data;
    next();
  };
}

export const requestContext: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader("X-Request-Id", res.locals.requestId);
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, "NOT_FOUND", "The requested resource was not found."));
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  let apiError = error instanceof ApiError ? error : undefined;
  if (
    !apiError &&
    typeof error === "object" &&
    error !== null &&
    "type" in error
  ) {
    if (error.type === "entity.parse.failed") {
      apiError = new ApiError(
        400,
        "VALIDATION_ERROR",
        "Malformed JSON request body.",
      );
    } else if (error.type === "entity.too.large") {
      apiError = new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request body is too large.",
      );
    } else if (
      error.type === "encoding.unsupported" ||
      error.type === "charset.unsupported"
    ) {
      apiError = new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Unsupported request encoding.",
      );
    }
  }
  if (!apiError) {
    // Deliberately exclude raw errors, URLs, bodies, headers, tokens, and PII.
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        requestId: res.locals.requestId,
        code: "INTERNAL_ERROR",
      }),
    );
    apiError = new ApiError(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred.",
    );
  }
  res
    .status(apiError.status)
    .json({
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined
          ? {}
          : { details: apiError.details }),
      },
    });
};
