export interface RequestContext {
  organisationId: string;
  /** Acting principal id: the API key id, or `user:<workos user id>` for dashboard users. */
  apiKeyId: string;
  scopes: string[];
  authMethod: 'api_key' | 'workos';
  userId?: string;
  sessionId?: string;
}

export const REQUEST_CONTEXT_KEY = 'durinRequestContext';
