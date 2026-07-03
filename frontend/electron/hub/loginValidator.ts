import crypto from "crypto";
import { getMeta } from "../database/dbService";
import { createLogger } from "../logger";

const log = createLogger("LoginValidator");

export type HubAuthFailureReason =
	| "invalid_credentials"
	| "no_pos_profile"
	| "erpnext_unreachable"
	| "not_configured"
	| "error";

export interface HubAuthUser {
	name: string;
	username: string;
	full_name: string;
	password_hash: string;
	role: string;
	pos_profile: string;
	warehouse: string;
	company: string;
	theme: string;
	discount_limit: number;
	enabled: number;
	[permissionKey: string]: string | number;
}

export interface HubAuthResult {
	success: boolean;
	reason?: HubAuthFailureReason;
	error?: string;
	user?: HubAuthUser;
}

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Validate a username/password as a real ERPNext login and confirm the user
 * is linked to an active POS Profile. This is the single function that talks
 * to ERPNext for login purposes — called directly for the Hub's own login,
 * and by hubServer.ts's HTTP relay endpoint to serve Till login requests, so
 * both paths can never behave differently from one another.
 */
export async function validateOnlineLogin(username: string, password: string): Promise<HubAuthResult> {
	const serverUrl = (await getMeta("server_url")) || process.env.XPOS_SERVER_URL || "";
	const apiKey = await getMeta("api_key");
	const apiSecret = await getMeta("api_secret");

	if (!serverUrl) {
		return { success: false, reason: "not_configured", error: "No ERPNext server URL is configured" };
	}

	// Step 1: standard Frappe session login — proves the credentials are valid.
	// Whether we ever got an HTTP response at all is what distinguishes "wrong
	// password" from "server unreachable" (Frappe's error body shape varies
	// across versions, so we don't try to parse it for that distinction).
	let loginResponded = false;
	try {
		const resp = await fetch(`${serverUrl}/api/method/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ usr: username, pwd: password }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		loginResponded = true;
		const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
		if (!resp.ok || data.message !== "Logged In") {
			return { success: false, reason: "invalid_credentials", error: "Incorrect username or password" };
		}
	} catch (err) {
		if (loginResponded) throw err;
		log.warn("ERPNext unreachable during login:", err instanceof Error ? err.message : err);
		return { success: false, reason: "erpnext_unreachable", error: "Could not reach the ERPNext server" };
	}

	// Step 2: confirm POS Profile linkage + fetch role/permissions, using the
	// Hub's OWN admin API credentials (not the just-validated user's session).
	if (!apiKey || !apiSecret) {
		return { success: false, reason: "not_configured", error: "Hub has no ERPNext API key/secret configured" };
	}

	try {
		const url = `${serverUrl}/api/method/xpos.api.auth.get_pos_user_profile?user=${encodeURIComponent(username)}`;
		const resp = await fetch(url, {
			headers: { Authorization: `token ${apiKey}:${apiSecret}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const data = (await resp.json().catch(() => ({}))) as { message?: HubAuthUser };
		const profile = data.message;
		if (!resp.ok || !profile) {
			return {
				success: false,
				reason: "no_pos_profile",
				error: "This user is not linked to an active POS Profile",
			};
		}

		const password_hash = crypto.createHash("sha256").update(password).digest("hex");
		return { success: true, user: { ...profile, password_hash } };
	} catch (err) {
		log.warn("ERPNext unreachable during profile check:", err instanceof Error ? err.message : err);
		return { success: false, reason: "erpnext_unreachable", error: "Could not reach the ERPNext server" };
	}
}
