export type AppEnv = {
  Variables: {
    userId: string;
    /** Correlation id set by the request-id middleware, echoed in responses. */
    requestId: string;
    /** Parsed request parts set by the `validate` middleware (see middleware/validate.ts). */
    validatedBody: unknown;
    validatedQuery: unknown;
    validatedParam: unknown;
  };
};
