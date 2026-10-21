import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { isAllowedGoogleIdentity, verifyGoogleIdToken } from '../src/google-oidc.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_CLIENT_ID = 'local-test-client.apps.googleusercontent.com';
const EXPECTED_NONCE = 'local-test-nonce';
const ALLOWED_EMAIL = 'allowed@example.com';
const KEY_ID = 'local-test-key';
const originalFetch = globalThis.fetch;

after(() => {
	globalThis.fetch = originalFetch;
});

test('verifies Google ID tokens and gates on the exact verified email', async t => {
	const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
	const jwk = await exportJWK(publicKey);
	const jwks = {
		keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' } as JWK],
	};
	let jwksRequests = 0;
	globalThis.fetch = async input => {
		assert.equal(String(input), GOOGLE_JWKS_URL);
		jwksRequests += 1;
		return Response.json(jwks);
	};

	const now = Math.floor(Date.now() / 1000);
	const validClaims: JWTPayload = {
		iss: 'https://accounts.google.com',
		aud: GOOGLE_CLIENT_ID,
		sub: 'stable-google-subject',
		email: ALLOWED_EMAIL,
		email_verified: true,
		nonce: EXPECTED_NONCE,
		iat: now,
		exp: now + 300,
	};
	const createToken = async (
		claims: JWTPayload = validClaims,
		signingKey: CryptoKey = privateKey,
	): Promise<string> => new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
		.sign(signingKey);
	const verify = (idToken: string, expectedNonce = EXPECTED_NONCE) => verifyGoogleIdToken({
		idToken,
		clientId: GOOGLE_CLIENT_ID,
		expectedNonce,
	});

	await t.test('accepts a correctly signed token and preserves the stable subject', async () => {
		const identity = await verify(await createToken());

		assert.deepEqual(identity, {
			sub: 'stable-google-subject',
			email: ALLOWED_EMAIL,
			name: ALLOWED_EMAIL,
		});
		assert.equal(isAllowedGoogleIdentity(identity, ALLOWED_EMAIL), true);
		assert.equal(isAllowedGoogleIdentity(identity, 'another@example.com'), false);
	});

	await t.test('accepts the alternate Google issuer form', async () => {
		const identity = await verify(await createToken({ ...validClaims, iss: 'accounts.google.com' }));
		assert.equal(identity.sub, 'stable-google-subject');
	});

	await t.test('matches the allowed Google email without case sensitivity', async () => {
		const identity = await verify(await createToken({ ...validClaims, email: 'ALLOWED@EXAMPLE.COM' }));
		assert.equal(isAllowedGoogleIdentity(identity, ALLOWED_EMAIL), true);
	});

	await t.test('rejects an invalid signature', async () => {
		const otherKey = await generateKeyPair('RS256', { modulusLength: 2048 });
		await assert.rejects(verify(await createToken(validClaims, otherKey.privateKey)));
	});

	await t.test('rejects the wrong audience', async () => {
		await assert.rejects(verify(await createToken({ ...validClaims, aud: 'another-client' })));
	});

	await t.test('rejects an untrusted issuer', async () => {
		await assert.rejects(verify(await createToken({ ...validClaims, iss: 'https://attacker.example' })));
	});

	await t.test('rejects an expired token and one without an expiry', async () => {
		await assert.rejects(verify(await createToken({ ...validClaims, exp: now - 1 })));

		const missingExpiry = { ...validClaims };
		delete missingExpiry.exp;
		await assert.rejects(verify(await createToken(missingExpiry)));
	});

	await t.test('rejects a nonce mismatch and unverified email', async () => {
		await assert.rejects(verify(await createToken(), 'wrong-nonce'));
		await assert.rejects(verify(await createToken({ ...validClaims, email_verified: false })));
	});

	await t.test('rejects empty subject and email claims', async () => {
		await assert.rejects(verify(await createToken({ ...validClaims, sub: ' ' })));
		await assert.rejects(verify(await createToken({ ...validClaims, email: '' })));
	});

	assert.equal(jwksRequests, 1);
});
