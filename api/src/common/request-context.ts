export interface RequestContext {
  organisationId: string;
  apiKeyId: string;
  scopes: string[];
}

export const REQUEST_CONTEXT_KEY = 'durinRequestContext';
