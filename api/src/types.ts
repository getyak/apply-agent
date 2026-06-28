export type AppEnv = {
  Variables: {
    userId: string;
    /** Correlation id set by the request-id middleware, echoed in responses. */
    requestId: string;
    /**
     * End-to-end trace id (UUID). Spans web → api → agents → LLM.
     * Set by traceId middleware (api/src/middleware/trace-id.ts);
     * forwarded to agents via X-Trace-Id by the agent fetch helper.
     */
    traceId: string;
    /** Parsed request parts set by the `validate` middleware (see middleware/validate.ts). */
    validatedBody: unknown;
    validatedQuery: unknown;
    validatedParam: unknown;
  };
};
