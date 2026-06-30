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
    /**
     * Resolved UI locale ("en" | "zh"), set by `middleware/locale.ts` from
     * X-Relay-Locale → Accept-Language → DEFAULT. Routes that need to
     * forward to agents read this from context instead of re-resolving
     * the request headers; the same value is echoed on the response as
     * X-Relay-Locale so the web layer can confirm.
     */
    locale: "en" | "zh";
  };
};
