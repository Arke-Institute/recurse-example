/**
 * Type definitions for the recurse splitter worker
 */

/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** Klados agent ID (registered in Arke) */
  AGENT_ID: string;

  /** Agent version for logging */
  AGENT_VERSION: string;

  /** Arke agent API key (secret) */
  ARKE_AGENT_KEY: string;

  /** Verification token for endpoint verification (set during registration) */
  VERIFICATION_TOKEN?: string;

  /** Agent ID for verification (used before AGENT_ID is configured) */
  ARKE_VERIFY_AGENT_ID?: string;
}

/**
 * Properties of the target entity being processed by the splitter
 */
export interface SplitterTargetProps {
  /** Initial text to split (used on first iteration) */
  text?: string;

  /** Array of text segments (grows as we split) */
  segments?: string[];

  /** Number of splits performed so far */
  split_count?: number;

  /** Recursion depth at last split */
  last_split_depth?: number;

  /** Allow any additional properties */
  [key: string]: unknown;
}
