/**
 * Limits shared by the SOAP editor (browser) and the SOAP draft generator
 * (server). Kept apart from soap-draft.ts so the editor can import it without
 * pulling in the AI provider code.
 */

/** Room for everything the clinician already typed into the four sections. */
export const SOAP_DRAFT_VISIT_CONTEXT_MAX_LENGTH = 12_000;
