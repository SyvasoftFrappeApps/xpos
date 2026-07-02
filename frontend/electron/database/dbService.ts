/**
 * X POS Local MariaDB Database Service
 *
 * Runs in the Electron main process. Manages the connection pool
 * to a local MariaDB instance and provides typed query helpers.
 *
 * Replaces IndexedDB (Dexie) for the Electron desktop app while
 * the PWA/browser version continues to use IndexedDB.
 */

import mysql, {
	type Pool,
	type PoolConnection,
	type RowDataPacket,
	type ResultSetHeader,
} from "mysql2/promise";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { app } from "electron";
import { createLogger } from "../logger";

const log = createLogger("DB");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DbConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

const DEFAULT_CONFIG: DbConfig = {
	host: "127.0.0.1",
	port: 3306,
	user: "xpos",
	password: "xpos",
	database: "xpos_local",
};

let pool: Pool | null = null;
let currentConfig: DbConfig = { ...DEFAULT_CONFIG };

function configFilePath(): string {
	return path.join(app.getPath("userData"), "db-config.json");
}

export function saveDbConfig(cfg: DbConfig): void {
	const pathsToWrite: string[] = [];
	try {
		pathsToWrite.push(path.join(app.getPath("userData"), "db-config.json"));
	} catch {
		/* ignore */
	}
	if (process.env.APPDATA) {
		pathsToWrite.push(path.join(process.env.APPDATA, "X POS", "db-config.json"));
		pathsToWrite.push(path.join(process.env.APPDATA, "xpos-frontend", "db-config.json"));
	}
	const data = JSON.stringify(cfg, null, 2);
	for (const p of pathsToWrite) {
		try {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, data, "utf-8");
		} catch (err) {
			log.warn(`Failed to save db-config.json to ${p}`, err);
		}
	}
}

export function loadDbConfig(): DbConfig {
	const candidates: string[] = [];
	try {
		candidates.push(path.join(app.getPath("userData"), "db-config.json"));
	} catch {}
	if (process.env.APPDATA) {
		candidates.push(path.join(process.env.APPDATA, "X POS", "db-config.json"));
		candidates.push(path.join(process.env.APPDATA, "xpos-frontend", "db-config.json"));
	}

	for (const candidate of candidates) {
		try {
			const raw = fs.readFileSync(candidate, "utf-8");
			const parsed = JSON.parse(raw) as Partial<DbConfig>;
			log.info(`Loaded DB config from: ${candidate}`);
			return { ...DEFAULT_CONFIG, ...parsed };
		} catch {
			// try next candidate
		}
	}

	log.warn(`No db-config.json found (tried: ${candidates.join(", ")}), using defaults`);
	return { ...DEFAULT_CONFIG };
}

export function getPool(): Pool {
	if (!pool) {
		throw new Error("Database not initialized. Call initDatabase() first.");
	}
	return pool;
}

export async function initDatabase(config?: Partial<DbConfig>): Promise<void> {
	const persisted = loadDbConfig();
	currentConfig = { ...persisted, ...(config || {}) };

	log.info(
		`DB init — host: ${currentConfig.host}, port: ${currentConfig.port}, user: ${currentConfig.user}, db: ${currentConfig.database}`,
	);

	saveDbConfig(currentConfig);

	const rootPool = mysql.createPool({
		host: currentConfig.host,
		port: currentConfig.port,
		user: currentConfig.user,
		password: currentConfig.password,
		waitForConnections: true,
		connectionLimit: 2,
		connectTimeout: 5000,
	});

	try {
		await rootPool.execute(
			`CREATE DATABASE IF NOT EXISTS \`${currentConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
		);
	} finally {
		await rootPool.end();
	}

	pool = mysql.createPool({
		host: currentConfig.host,
		port: currentConfig.port,
		user: currentConfig.user,
		password: currentConfig.password,
		database: currentConfig.database,
		waitForConnections: true,
		connectionLimit: 10,
		queueLimit: 0,
		charset: "utf8mb4",
		timezone: "+00:00",
		connectTimeout: 5000,
		dateStrings: true,
	});

	const conn = await pool.getConnection();
	conn.release();

	await runSchema();

	log.info(`Connected to MariaDB: ${currentConfig.host} ${currentConfig.database}`);
}

export async function closeDatabase(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
		log.info("Connection pool closed");
	}
}

export function getConfig(): DbConfig {
	return { ...currentConfig };
}

async function runSchema(): Promise<void> {
	const candidates = [
		path.join(process.resourcesPath || "", "schema.sql"),
		path.join(__dirname, "schema.sql"),
		path.join(process.cwd(), "electron", "database", "schema.sql"),
	];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			await executeSchemaFile(candidate);
			await runMigrations();
			return;
		}
	}

	log.warn("schema.sql not found, skipping migrations");
}

async function addUniqueIndexIfMissing(
	db: Pool,
	table: string,
	column: string,
	indexName: string,
): Promise<void> {
	try {
		const [existing] = await db.execute<RowDataPacket[]>(
			"SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
			[table, indexName],
		);
		if ((existing as RowDataPacket[]).length > 0) return;

		const [dupes] = await db.execute<RowDataPacket[]>(
			`SELECT \`${column}\` FROM \`${table}\` WHERE \`${column}\` IS NOT NULL GROUP BY \`${column}\` HAVING COUNT(*) > 1`,
		);
		if ((dupes as RowDataPacket[]).length > 0) {
			log.warn(
				`Migration skipped: ${table}.${column} has duplicate values, resolve manually before adding UNIQUE index`,
			);
			return;
		}

		await db.execute(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${indexName}\` (\`${column}\`)`);
		log.info(`Migration: added UNIQUE index on ${table}.${column}`);
	} catch (err) {
		log.warn(`Migration for ${table}.${column} unique index failed`, err);
	}
}

/**
 * Incremental schema migrations that can't be expressed as CREATE TABLE IF NOT EXISTS.
 * Safe to run on every startup (idempotent).
 */
async function runMigrations(): Promise<void> {
	const db = getPool();

	// Drop the legacy `barcode` column from `items` (barcodes live in `item_barcodes` now)
	try {
		const [cols] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = 'barcode'",
		);
		if ((cols as RowDataPacket[]).length > 0) {
			await db.execute("ALTER TABLE `items` DROP INDEX `idx_barcode`").catch(() => {
				/* index may not exist */
			});
			await db.execute("ALTER TABLE `items` DROP COLUMN `barcode`");
			log.info("Migration: dropped items.barcode column");
		}
	} catch (err) {
		log.warn("Migration check for items.barcode failed", err);
	}

	// Add the missing 'syncing' value to sync_status enums (push code sets this
	// transitional state before calling the API; tables created before this fix
	// only allowed 'pending'/'synced'/'failed', so every push attempt failed).
	for (const table of ["pos_opening_shifts", "pos_closing_entries"]) {
		try {
			const [cols] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'sync_status'",
				[table],
			);
			const columnType = (cols as RowDataPacket[])[0]?.COLUMN_TYPE as string | undefined;
			if (columnType && !columnType.includes("'syncing'")) {
				await db.execute(
					`ALTER TABLE \`${table}\` MODIFY COLUMN \`sync_status\` ENUM('pending','syncing','synced','failed') DEFAULT 'pending'`,
				);
				log.info(`Migration: added 'syncing' to ${table}.sync_status enum`);
			}
		} catch (err) {
			log.warn(`Migration for ${table}.sync_status enum failed`, err);
		}
	}

	// Once a local document syncs to ERPNext, its erp_id/server_name must be
	// unique locally too — otherwise two local rows can end up pointing at (or
	// being mistaken for) the same server document. NULL is exempt so unsynced
	// rows don't collide with each other.
	const erpIdUniqueTables = [
		"pos_opening_shifts",
		"pos_closing_entries",
		"expenses",
		"bank_drops",
		"stock_adjustments",
		"quotations",
	];
	for (const table of erpIdUniqueTables) {
		await addUniqueIndexIfMissing(db, table, "erp_id", "idx_erp_id");
	}
	for (const table of ["pending_invoices", "pending_purchases"]) {
		await addUniqueIndexIfMissing(db, table, "server_name", "idx_server_name");
	}

	// pos_opening_shifts/pos_closing_entries used their small sequential `id`
	// as the value sent to the server for xpos_local_id deduplication. That id
	// resets to 1 after any local wipe/reinstall, while the server remembers
	// old xpos_local_id mappings forever — so a fresh install's first shift
	// could get "deduplicated" onto a years-old, already-closed shift instead
	// of creating a new one. local_uid is a proper globally-unique value
	// (timestamp + random, like pending_invoices.local_id) used for that
	// purpose instead; existing already-synced rows are left as-is since
	// they'll never be pushed again.
	for (const table of ["pos_opening_shifts", "pos_closing_entries"]) {
		try {
			const [cols] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'local_uid'",
				[table],
			);
			if ((cols as RowDataPacket[]).length === 0) {
				await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`local_uid\` VARCHAR(64) DEFAULT NULL`);
				log.info(`Migration: added ${table}.local_uid`);
			}
		} catch (err) {
			log.warn(`Migration for ${table}.local_uid failed`, err);
		}
		await addUniqueIndexIfMissing(db, table, "local_uid", "idx_local_uid");
	}

	try {
		const [cols] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = 'local_item_name'",
		);
		if ((cols as RowDataPacket[]).length === 0) {
			await db.execute(
				"ALTER TABLE `items` ADD COLUMN `local_item_name` VARCHAR(255) DEFAULT NULL AFTER `item_name`",
			);
			log.info("Migration: added items.local_item_name column");
		}
	} catch (err) {
		log.warn("Migration for items.local_item_name failed", err);
	}

	const posProfileMigrations: [string, string][] = [
		["allow_rate_change", "TINYINT(1) NOT NULL DEFAULT 0"],
		["allow_change_posting_date", "TINYINT(1) NOT NULL DEFAULT 0"],
		["hide_images", "TINYINT(1) NOT NULL DEFAULT 0"],
		["hide_unavailable_items", "TINYINT(1) NOT NULL DEFAULT 0"],
		["block_sale_beyond_available_qty", "TINYINT(1) NOT NULL DEFAULT 0"],
		["display_items_in_stock", "TINYINT(1) NOT NULL DEFAULT 0"],
		["cash_mode_of_payment", "VARCHAR(255) DEFAULT NULL"],
		["apply_customer_discount", "TINYINT(1) NOT NULL DEFAULT 0"],
		["allow_print_draft_invoices", "TINYINT(1) NOT NULL DEFAULT 0"],
		["use_offline_mode", "TINYINT(1) NOT NULL DEFAULT 0"],
	];
	for (const [col, typedef] of posProfileMigrations) {
		try {
			const [existing] = await db.execute<RowDataPacket[]>(
				"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_profiles' AND COLUMN_NAME = ?",
				[col],
			);
			if ((existing as RowDataPacket[]).length === 0) {
				await db.execute(`ALTER TABLE \`pos_profiles\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added pos_profiles.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_profiles.${col} failed`, err);
		}
	}

	const posUserMigrations: [string, string][] = [
		["close_bill", "TINYINT(1) DEFAULT 1"],
		["close_shift", "TINYINT(1) DEFAULT 0"],
		["allow_reprint_invoice", "TINYINT(1) DEFAULT 0"],
		["print_draft_invoice", "TINYINT(1) DEFAULT 0"],
		["manage_role_permissions", "TINYINT(1) DEFAULT 0"],
		["shift_report", "TINYINT(1) DEFAULT 0"],
		["allow_cancel_invoice", "TINYINT(1) DEFAULT 0"],
		["unsettled_invoices", "TINYINT(1) DEFAULT 0"],
		["apply_additional_discount", "TINYINT(1) DEFAULT 0"],
		["apply_standard_discount", "TINYINT(1) DEFAULT 0"],
		["show_edit_discount_field", "TINYINT(1) DEFAULT 0"],
		["edit_tax_template", "TINYINT(1) DEFAULT 0"],
		["allow_change_price", "TINYINT(1) DEFAULT 0"],
		["quotation", "TINYINT(1) DEFAULT 0"],
		["sale_return", "TINYINT(1) DEFAULT 0"],
		["local_purchase", "TINYINT(1) DEFAULT 0"],
		["purchase_order", "TINYINT(1) DEFAULT 0"],
		["purchase_invoice", "TINYINT(1) DEFAULT 0"],
		["stock_adjustment", "TINYINT(1) DEFAULT 0"],
		["stock_entry", "TINYINT(1) DEFAULT 0"],
		["near_expiry_items", "TINYINT(1) DEFAULT 0"],
		["expense", "TINYINT(1) DEFAULT 0"],
		["bank_drop", "TINYINT(1) DEFAULT 0"],
		["list_of_invoices", "TINYINT(1) DEFAULT 1"],
		["list_of_cancelled_invoices", "TINYINT(1) DEFAULT 0"],
		["list_of_errors", "TINYINT(1) DEFAULT 0"],
		["list_of_purchase_invoices", "TINYINT(1) DEFAULT 0"],
		["list_of_quotations", "TINYINT(1) DEFAULT 0"],
		["list_of_stock_entries", "TINYINT(1) DEFAULT 0"],
		["list_of_local_purchases", "TINYINT(1) DEFAULT 0"],
		["list_of_stock_adjustments", "TINYINT(1) DEFAULT 0"],
		["list_of_expense", "TINYINT(1) DEFAULT 0"],
		["list_of_bank_drops", "TINYINT(1) DEFAULT 0"],
		["invoice_settlement_report", "TINYINT(1) DEFAULT 0"],
		["sales_report_by_time", "TINYINT(1) DEFAULT 0"],
		["sales_summary_by_hour", "TINYINT(1) DEFAULT 0"],
		["current_stock_by_brand", "TINYINT(1) DEFAULT 0"],
		["stock_register", "TINYINT(1) DEFAULT 0"],
		["current_stock_report", "TINYINT(1) DEFAULT 0"],
		["discount_limit", "DECIMAL(18,6) DEFAULT 100"],
	];

	const posUserColumnExists = async (col: string): Promise<boolean> => {
		const [existing] = await db.execute<RowDataPacket[]>(
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_users' AND COLUMN_NAME = ?",
			[col],
		);
		return (existing as RowDataPacket[]).length > 0;
	};

	for (const [col, typedef] of posUserMigrations) {
		try {
			if (!(await posUserColumnExists(col))) {
				await db.execute(`ALTER TABLE \`pos_users\` ADD COLUMN \`${col}\` ${typedef}`);
				log.info(`Migration: added pos_users.${col}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_users.${col} failed`, err);
		}
	}

	const posUserRenames: [string, string][] = [
		["allow_return", "sale_return"],
		["allow_expense", "expense"],
		["allow_bank_drop", "bank_drop"],
		["show_edit_item_tax_template", "edit_tax_template"],
	];
	for (const [oldCol, newCol] of posUserRenames) {
		try {
			if (await posUserColumnExists(oldCol)) {
				await db.execute(`UPDATE \`pos_users\` SET \`${newCol}\` = \`${oldCol}\``);
				await db.execute(`ALTER TABLE \`pos_users\` DROP COLUMN \`${oldCol}\``);
				log.info(`Migration: renamed pos_users.${oldCol} -> ${newCol}`);
			}
		} catch (err) {
			log.warn(`Migration for pos_users rename ${oldCol} -> ${newCol} failed`, err);
		}
	}
}

async function executeSchemaFile(filePath: string): Promise<void> {
	const sql = fs.readFileSync(filePath, "utf-8");
	const statements = sql
		.split(";")
		.map((s) =>
			s
				.split("\n")
				.filter((line) => !line.trim().startsWith("--"))
				.join("\n")
				.trim(),
		)
		.filter((s) => s.length > 0);

	const db = getPool();
	for (const stmt of statements) {
		try {
			await db.execute(stmt);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("already exists")) {
				log.error(`Schema error: ${msg}\nStatement: ${stmt.substring(0, 100)}`);
			}
		}
	}
	log.info("Schema applied");
}

export async function query<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
	const db = getPool();
	const [rows] = await db.execute<RowDataPacket[]>(sql, params as (string | number | null | Buffer)[]);
	return rows as T[];
}

export async function queryOne<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | null> {
	const rows = await query<T>(sql, params);
	return rows[0] || null;
}

export async function execute(
	sql: string,
	params: unknown[] = [],
): Promise<{ affectedRows: number; insertId: number }> {
	const db = getPool();
	const [result] = await db.execute<ResultSetHeader>(sql, params as (string | number | null | Buffer)[]);
	return { affectedRows: result.affectedRows, insertId: result.insertId };
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
	const db = getPool();
	const conn = await db.getConnection();
	try {
		await conn.beginTransaction();
		const result = await fn(conn);
		await conn.commit();
		return result;
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
}

export async function upsertBatch(
	table: string,
	rows: Record<string, unknown>[],
	primaryKey: string,
	preserveOnUpdate: string[] = [],
): Promise<number> {
	if (rows.length === 0) return 0;

	const columns = Object.keys(rows[0]);
	const placeholders = columns.map(() => "?").join(", ");
	// Columns in preserveOnUpdate are still written on first INSERT, but an
	// existing row's value is left untouched on conflict (e.g. password_hash,
	// which the server always sends empty and must never overwrite a locally
	// set offline-login password).
	const updateCols = columns
		.filter((c) => c !== primaryKey && !preserveOnUpdate.includes(c))
		.map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
		.join(", ");

	const db = getPool();
	let affected = 0;

	const CHUNK = 100;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK);
		const valuesSql = chunk.map(() => `(${placeholders})`).join(", ");
		const flatParams = chunk.flatMap((row) => columns.map((c) => row[c] ?? null));

		const sql = `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(", ")})
      VALUES ${valuesSql}
      ON DUPLICATE KEY UPDATE ${updateCols}`;

		const result = await db.execute<ResultSetHeader>(
			sql,
			flatParams as (string | number | null | Buffer)[],
		);
		affected += result[0].affectedRows;
	}

	return affected;
}

export async function getMeta(key: string): Promise<string | null> {
	const row = await queryOne<{ value: string }>("SELECT `value` FROM `sync_meta` WHERE `key` = ?", [key]);
	return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
	await execute(
		`INSERT INTO \`sync_meta\` (\`key\`, \`value\`, \`updated_at\`)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`updated_at\` = NOW()`,
		[key, value],
	);
}

export async function testConnection(
	config: Partial<DbConfig>,
): Promise<{ success: boolean; error?: string }> {
	const testConfig = { ...currentConfig, ...config };
	let testPool: Pool | null = null;
	try {
		testPool = mysql.createPool({
			host: testConfig.host,
			port: testConfig.port,
			user: testConfig.user,
			password: testConfig.password,
			connectionLimit: 1,
		});
		const conn = await testPool.getConnection();
		conn.release();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (testPool) await testPool.end();
	}
}
