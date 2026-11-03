import Logger from '@joplin/utils/Logger';
import { HeadlessPerformanceRecord, reportHeadlessPerformance, setHeadlessPerformanceReporter } from './HeadlessPerformance';

describe('services/HeadlessPerformance', () => {
	afterEach(() => {
		setHeadlessPerformanceReporter(null);
	});

	it('forwards a safe timing record while native logging is disabled, without changing logger settings', () => {
		const nativeLogger = new Logger();
		nativeLogger.setLevel(Logger.LEVEL_NONE);
		nativeLogger.enabled = false;
		const callback = jest.fn();
		setHeadlessPerformanceReporter(callback);
		const record: HeadlessPerformanceRecord = { stage: 'historyLock', itemType: 1, itemId: '0123456789abcdef0123456789abcdef', waitMs: 3, holdMs: 7 };
		reportHeadlessPerformance(Logger.create('HeadlessPerformanceTest', nativeLogger), record);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(record);
		expect(nativeLogger.enabled).toBe(false);
		expect(nativeLogger.level()).toBe(Logger.LEVEL_NONE);
	});

	it('retains native debug logging and removes the headless callback when its host stops', () => {
		const logger = { debug: jest.fn() };
		const callback = jest.fn();
		setHeadlessPerformanceReporter(callback);
		reportHeadlessPerformance(logger, { stage: 'nativeSearch', elapsedMs: 5, resultCount: 10 });
		setHeadlessPerformanceReporter(null);
		reportHeadlessPerformance(logger, { stage: 'nativeSearch', elapsedMs: 2, resultCount: 4 });
		expect(callback).toHaveBeenCalledTimes(1);
		expect(logger.debug.mock.calls).toEqual([
			['nativeSearch', { elapsedMs: 5, resultCount: 10 }],
			['nativeSearch', { elapsedMs: 2, resultCount: 4 }],
		]);
	});
});
