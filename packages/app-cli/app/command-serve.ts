import BaseCommand from './base-command';
import app from './app';

class Command extends BaseCommand {
	public override usage() {
		return 'serve';
	}

	public override description() {
		return 'Run the private API, sync, decryption and search in one encrypted headless profile. Requires JOPLIN_HEADLESS=1.';
	}

	public override async action() {
		await app().runHeadlessService();
	}
}

module.exports = Command;
