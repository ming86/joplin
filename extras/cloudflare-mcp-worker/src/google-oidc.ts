import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/** Google's public signing keys for OpenID Connect ID tokens. */
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
/** Issuer values Google may use for a valid ID token. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** A Google identity produced only after its signed ID token has been verified. */
export interface GoogleIdentity {
	/** Stable Google Account identifier. Use this as the OAuth provider user ID. */
	sub: string;
	/** Verified email address from the ID token. */
	email: string;
	/** Display name, falling back to the verified email when Google omits it. */
	name: string;
	/** Profile image URL when Google includes it. */
	picture?: string;
}

/** Inputs required to verify one Google-issued OpenID Connect ID token. */
export interface VerifyGoogleIdTokenArgs {
	/** Signed ID token returned by Google's authorization-code exchange. */
	idToken: string;
	/** OAuth client ID that must appear in the token audience. */
	clientId: string;
	/** The one-time nonce stored with the corresponding authorization request. */
	expectedNonce: string;
}

/**
 * Verify a Google ID token and return its trusted account identity claims.
 * Signature, algorithm, issuer, audience, expiry, required claims, nonce, and
 * verified-email status are checked before any claim is returned.
 */
export async function verifyGoogleIdToken(args: VerifyGoogleIdTokenArgs): Promise<GoogleIdentity> {
	if (!args.expectedNonce) throw new Error('Expected Google nonce is required');

	const { payload } = await jwtVerify(args.idToken, GOOGLE_JWKS, {
		audience: args.clientId,
		issuer: GOOGLE_ISSUERS,
		algorithms: ['RS256'],
		requiredClaims: ['exp', 'sub', 'email', 'email_verified', 'nonce'],
	});

	if (payload.nonce !== args.expectedNonce) throw new Error('Google ID token nonce mismatch');
	return identityFromPayload(payload);
}

/**
 * Check the exact allowlisted email for an identity returned by
 * {@link verifyGoogleIdToken}.
 */
export function isAllowedGoogleIdentity(identity: GoogleIdentity, allowedEmail: string): boolean {
	return identity.email.toLowerCase() === allowedEmail.trim().toLowerCase();
}

/** Convert verified JWT claims to the small identity shape used by the auth flow. */
function identityFromPayload(payload: JWTPayload): GoogleIdentity {
	if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0
		|| typeof payload.email !== 'string' || payload.email.trim().length === 0) {
		throw new Error('Google ID token is missing required identity claims');
	}
	if (payload.email_verified !== true) throw new Error('Google account email is not verified');

	return {
		sub: payload.sub,
		email: payload.email,
		name: typeof payload.name === 'string' ? payload.name : payload.email,
		...(typeof payload.picture === 'string' ? { picture: payload.picture } : {}),
	};
}
