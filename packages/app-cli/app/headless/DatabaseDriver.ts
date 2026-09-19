import { DatabaseDriverNode } from '@joplin/lib/database-driver-node';
import { initializeSqlCipher } from './sqlCipher';

export default class HeadlessDatabaseDriver extends DatabaseDriverNode {
	public constructor(private key: Buffer) {
		super();
	}

	public override async open(options: { name: string }) {
		let opened = false;
		try {
			await super.open(options);
			opened = true;
			await initializeSqlCipher(this, this.key);
		} catch (error) {
			if (opened) await super.close();
			throw error;
		} finally {
			this.key.fill(0);
		}
	}
}
