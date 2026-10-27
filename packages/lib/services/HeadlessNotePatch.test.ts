import applyBodyPatch from './HeadlessNotePatch';

/** Assert that patch rejection uses the stable public error code. */
function expectPatchError(originalBody: string, patchText: string, code: string): void {
	let caught: unknown;
	try {
		applyBodyPatch(originalBody, patchText);
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject({ code });
}

describe('services/HeadlessNotePatch', () => {
	it('applies multiple source-ordered hunks with line-count changes against one original body', () => {
		const body = 'intro\nsection A\nold one\nbetween\nsection B\nold two\noutro';
		const patch = [
			'@@',
			' section A',
			'-old one',
			'+new one',
			'+new two',
			'@@',
			' section B',
			'-old two',
			'+updated',
		].join('\n');

		expect(applyBodyPatch(body, patch)).toBe('intro\nsection A\nnew one\nnew two\nbetween\nsection B\nupdated\noutro');
	});

	it('uses unchanged context to distinguish repeated source text', () => {
		const body = 'first\nsame\nmiddle\nsame\nlast';
		const patch = '@@\n middle\n-same\n+revised';

		expect(applyBodyPatch(body, patch)).toBe('first\nsame\nmiddle\nrevised\nlast');
	});

	it('rejects missing and globally ambiguous source sequences', () => {
		expectPatchError('alpha\nbeta', '@@\n-absent\n+replacement', 'note_patch_not_found');
		expectPatchError('same\nother\nsame', '@@\n-same\n+replacement', 'note_patch_ambiguous');
	});

	it('rejects out-of-order and overlapping source windows', () => {
		const body = 'a\nb\nc\nd\ne';
		const outOfOrder = '@@\n-e\n+E\n@@\n-b\n+B';
		const overlapping = '@@\n b\n-c\n+C\n@@\n-c\n d\n+D';

		expectPatchError(body, outOfOrder, 'note_patch_order');
		expectPatchError(body, overlapping, 'note_patch_order');
	});

	it('initializes an empty body and represents inserted or removed blank lines', () => {
		expect(applyBodyPatch('', '@@\n-\n+hello\n')).toBe('hello');
		expect(applyBodyPatch('one', '@@\n one\n+\n')).toBe('one\n');
		expect(applyBodyPatch('one\n', '@@\n one\n-\n')).toBe('one');
		expect(applyBodyPatch('one\ntwo', '@@\n-one\n-two\n')).toBe('');
	});

	it.each(['\n', '\r\n', '\r'])('accepts %p patch separators and ignores one final syntax separator', (separator) => {
		const patch = ['@@', '-old', '+new'].join(separator) + separator;
		expect(applyBodyPatch('before\nold\nafter', patch)).toBe('before\nnew\nafter');
	});

	it('preserves mixed source separators and chooses a hunk separator for new boundaries', () => {
		const body = 'first\r\nreplace\rkeep\nlast';
		const patch = '@@\r\n-replace\r\n+updated\r\n';
		expect(applyBodyPatch(body, patch)).toBe('first\r\nupdated\rkeep\nlast');

		// The matched final line has no separator, so this hunk uses the body's first CRLF.
		expect(applyBodyPatch('first\r\nlast', '@@\n+x\n last')).toBe('first\r\nx\r\nlast');
	});

	it('preserves or changes the final newline only when the patch expresses it', () => {
		const replacement = '@@\n-one\n+two\n';
		expect(applyBodyPatch('one', replacement)).toBe('two');
		expect(applyBodyPatch('one\n', replacement)).toBe('two\n');
		expect(applyBodyPatch('one', '@@\n one\n+\n')).toBe('one\n');
		expect(applyBodyPatch('one\n', '@@\n one\n-\n')).toBe('one');
	});

	it('keeps exact whitespace and Unicode code units', () => {
		const source = '  e\u0301  \t';
		const patch = `@@\n-${source}\n+é`;
		expect(applyBodyPatch(source, patch)).toBe('é');
		expectPatchError('  é  \t', patch, 'note_patch_not_found');
	});

	it('keeps separators unchanged when a replacement has the same line text', () => {
		const body = 'alpha\r\nbeta\nomega\r';
		const patch = '@@\n-alpha\n-beta\n+alpha\n+beta\n';
		expect(applyBodyPatch(body, patch)).toBe(body);
	});

	it('handles a large single source line without imposing a patch-size ceiling', () => {
		const source = 'x'.repeat(100_000);
		const replacement = `${source.slice(0, -1)}y`;
		expect(applyBodyPatch(source, `@@\n-${source}\n+${replacement}`)).toBe(replacement);
	});

	it('assembles a large body without spreading its lines into function arguments', () => {
		const lines = Array.from({ length: 150_000 }, (_, index) => `line-${index}`);
		const targetIndex = lines.length - 2;
		const originalBody = lines.join('\n');
		lines[targetIndex] = 'updated';
		const expectedBody = lines.join('\n');

		expect(applyBodyPatch(originalBody, `@@\n-line-${targetIndex}\n+updated`)).toBe(expectedBody);
	});

	it.each([
		'',
		'line without a hunk',
		'@@',
		'@@\n context only',
		'@@\n+addition only',
		'@@\n source\nunprefixed',
		'*** Begin Patch\n@@\n-line\n+new',
	])('rejects malformed patch syntax %p', (patch) => {
		expectPatchError('source', patch, 'note_patch_invalid');
	});
});
