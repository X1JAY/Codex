export const CONTENT_SCRIPT_INITIALIZED_KEY = "__douyinStudyAssistantContentScriptV1__";

export type ContentScriptInitializationScope = Record<string, unknown>;

export function initializeContentScriptOnce(
  scope: ContentScriptInitializationScope,
  initialize: () => void,
): boolean {
  if (scope[CONTENT_SCRIPT_INITIALIZED_KEY] === true) return false;
  scope[CONTENT_SCRIPT_INITIALIZED_KEY] = true;
  try {
    initialize();
    return true;
  } catch (error) {
    delete scope[CONTENT_SCRIPT_INITIALIZED_KEY];
    throw error;
  }
}

