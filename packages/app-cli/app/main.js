#!/usr/bin/env node

// Use njstrace to find out what Node.js might be spending time on
// var njstrace = require('njstrace').inject();

const compareVersion = require('compare-version');
const nodeVersion = process && process.versions && process.versions.node ? process.versions.node : '0.0.0';
if (compareVersion(nodeVersion, '10.0.0') < 0) {
	console.error(`Joplin requires Node 10+. Detected version ${nodeVersion}`);
	process.exit(1);
}

const { readHeadlessConfig } = require('./headless/config');
let headlessConfig;
try {
	headlessConfig = readHeadlessConfig(process.env);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

// Keep module loading inside the failure boundary: SQLCipher and native imports can fail before startup.
let bootstrapStage = 'load-dependencies';
let headlessDiagnostics;
/** Load native/runtime dependencies and start the selected CLI mode within one failure boundary. */
async function startApplication() {
	if (headlessConfig) headlessDiagnostics = require('./headless/diagnostics');
	const Setting = require('@joplin/lib/models/Setting').default;
	Setting.setConstant('isHeadless', !!headlessConfig);

	const app = require('./app').default;
	const Folder = require('@joplin/lib/models/Folder').default;
	const Resource = require('@joplin/lib/models/Resource').default;
	const BaseItem = require('@joplin/lib/models/BaseItem').default;
	const Note = require('@joplin/lib/models/Note').default;
	const Tag = require('@joplin/lib/models/Tag').default;
	const NoteTag = require('@joplin/lib/models/NoteTag').default;
	const MasterKey = require('@joplin/lib/models/MasterKey').default;
	const Revision = require('@joplin/lib/models/Revision').default;
	const Logger = require('@joplin/utils/Logger').default;
	const FsDriverNode = require('@joplin/lib/fs-driver-node').default;
	const shimInitCli = require('./utils/shimInitCli').default;
	const shim = require('@joplin/lib/shim').default;
	const FileApiDriverLocal = require('@joplin/lib/file-api-driver-local').default;
	const EncryptionService = require('@joplin/lib/services/e2ee/EncryptionService').default;
	const envFromArgs = require('@joplin/lib/envFromArgs').default;
	bootstrapStage = 'load-sqlite-binding';
	const nodeSqlite = require(headlessConfig ? headlessConfig.sqliteModule : 'sqlite3');
	bootstrapStage = 'initialize-library';
	const initLib = require('@joplin/lib/initLib').default;

	let sharp = null;
	try {
		sharp = require('sharp');
	} catch (error) {
		// Don't print an error or it will pollute stdout every time the app is started. A warning will
		// be printed in app.ts
	}

	const env = headlessConfig ? 'prod' : envFromArgs(process.argv);

	const fsDriver = new FsDriverNode();
	Logger.fsDriver_ = fsDriver;
	Resource.fsDriver_ = fsDriver;
	EncryptionService.fsDriver_ = fsDriver;
	FileApiDriverLocal.fsDriver_ = fsDriver;

	// That's not good, but it's to avoid circular dependency issues
	// in the BaseItem class.
	BaseItem.loadClass('Note', Note);
	BaseItem.loadClass('Folder', Folder);
	BaseItem.loadClass('Resource', Resource);
	BaseItem.loadClass('Tag', Tag);
	BaseItem.loadClass('NoteTag', NoteTag);
	BaseItem.loadClass('MasterKey', MasterKey);
	BaseItem.loadClass('Revision', Revision);

	Setting.setConstant('appId', `net.cozic.joplin${env === 'dev' ? 'dev' : ''}-cli`);
	Setting.setConstant('appType', 'cli');

	let keytar;
	try {
		keytar = !headlessConfig && shim.platformSupportsKeyChain() ? require('keytar') : null;
	} catch (error) {
		console.error('Cannot load keytar - keychain support will be disabled', error);
		keytar = null;
	}

	function appVersion() {
		const p = require('./package.json');
		return p.version;
	}

	shimInitCli({ sharp, keytar, appVersion, nodeSqlite });

	const logger = new Logger();
	if (headlessConfig) logger.setLevel(Logger.LEVEL_NONE);
	Logger.initializeGlobalLogger(logger);
	initLib(logger);

	const application = app();

	if (process.platform === 'win32') {
		const rl = require('readline').createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		rl.on('SIGINT', () => {
			process.emit('SIGINT');
		});
	}

	process.stdout.on('error', (error) => {
		// https://stackoverflow.com/questions/12329816/error-write-epipe-when-piping-node-output-to-head#15884508
		if (error.code === 'EPIPE') {
			process.exit(0);
		}
	});

	bootstrapStage = 'start-application';
	const startup = headlessConfig ? application.startHeadless(process.argv, headlessConfig) : application.start(process.argv);
	await startup;
	if (headlessConfig) {
		await headlessDiagnostics.flushHeadlessDiagnostics();
		process.exit(0);
	}
}

startApplication().catch(async error => {
	if (headlessConfig) {
		headlessConfig.databaseKey.fill(0);
		if (headlessDiagnostics) {
			headlessDiagnostics.logHeadlessError('bootstrap', bootstrapStage, error);
			await headlessDiagnostics.flushHeadlessDiagnostics();
		} else {
			console.error('Headless diagnostics could not initialize while loading runtime dependencies.');
		}
		console.error('Headless client failed. See the safe diagnostics above and log-headless.txt when the profile was initialized.');
		process.exit(1);
	}
	const { _ } = require('@joplin/lib/locale');
	if (error.code === 'flagError') {
		console.error(error.message);
		console.error(_('Type `joplin help` for usage information.'));
	} else {
		console.error(_('Fatal error:'));
		console.error(error);
	}

	process.exit(1);
});
