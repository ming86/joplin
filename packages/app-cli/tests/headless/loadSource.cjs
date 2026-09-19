const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../../..');

// Isolate the new boundaries without importing all Desktop/mobile dependencies.
// This transpiles, but does not replace the full workspace type-check/build.
module.exports = function loadSource(relativePath, mocks = {}) {
	const filename = path.join(root, relativePath);
	const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		fileName: filename,
		reportDiagnostics: true,
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, esModuleInterop: true },
	});
	const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
	const loaded = { exports: {} };
	const isolatedRequire = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
	new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputText)(isolatedRequire, loaded, loaded.exports, filename, path.dirname(filename));
	return loaded.exports;
};
