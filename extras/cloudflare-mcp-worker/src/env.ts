import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** Worker bindings and secrets supplied by Wrangler. */
export interface Bindings extends Cloudflare.Env {
	/** Google web application's OAuth client identifier. */
	GOOGLE_OAUTH_CLIENT_ID: string;
	/** Google web application's OAuth client secret. */
	GOOGLE_OAUTH_CLIENT_SECRET: string;
	/** Fixed HTTPS origin exposing the private sidecar's /mcp route. */
	JOPLIN_MCP_ORIGIN_URL: string;
	/** Credential matching the sidecar HTTP server's bearer token file. */
	JOPLIN_MCP_BEARER_TOKEN: string;
}

/** Request environment after the OAuth provider injects its helpers. */
export interface Env extends Bindings {
	/** Library helpers bound to this request's provider configuration and KV. */
	OAUTH_PROVIDER: OAuthHelpers;
}
