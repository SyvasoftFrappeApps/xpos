import { call } from "@/services/api";
import { isElectron } from "@/services/electronBridge";
import type { HubAuthResult } from "@/services/electronBridge";
import { loadPermissions, resetPermissions } from "@/services/userRights";
import { UserSession } from "@/types/pos.types";
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { isOnline } from "@/utils";

export const useAuthStore = defineStore("auth", () => {
	const isLoading = ref(false);
	const isAuthenticated = ref(false);
	const user = ref<UserSession | null>(null);
	const error = ref("");
	const resetEmailSent = ref(false);
	const isOfflineAuth = ref(false);

	const userName = computed(() => user.value?.user || "Guest");
	const userEmail = computed(() => user.value?.user_email || "");
	const userFullName = computed(() => user.value?.user_fullname || "");
	const isGuest = computed(() => !user.value || user.value.user === "Guest");
	const isSystemManager = computed(() =>
		Boolean((window.xpos?.boot as Record<string, unknown> | undefined)?.xpos_is_system_manager),
	);
	const canManagePermissions = computed(() =>
		Boolean((window.xpos?.boot as Record<string, unknown> | undefined)?.xpos_can_manage_permissions),
	);

	async function checkAuth(): Promise<boolean> {
		try {
			isLoading.value = true;
			error.value = "";

			if (isElectron()) {
				return await checkOfflineAuth();
			}

			const response = await call("frappe.auth.get_logged_user");

			if (!response) {
				isAuthenticated.value = false;
				user.value = null;
				return false;
			}
			const loggedUser = response as string;

			if (loggedUser && loggedUser !== "Guest") {
				isAuthenticated.value = true;
				isOfflineAuth.value = false;
				if (window.xpos) {
					const bootUserInfo = xpos?.boot?.user_info[loggedUser] as any;
					user.value = {
						user: loggedUser,
						user_email: bootUserInfo?.user_email || loggedUser,
						user_fullname: bootUserInfo?.user_fullname || loggedUser,
						image: bootUserInfo?.image || "",
					};
				}
				await loadPermissions(loggedUser);
				return true;
			}

			isAuthenticated.value = false;
			user.value = null;
			return false;
		} catch (err) {
			console.error("Auth check failed:", err);
			if (isAuthenticated.value && !isOnline()) {
				return true;
			}
			isAuthenticated.value = false;
			user.value = null;
			return false;
		} finally {
			isLoading.value = false;
		}
	}

	async function checkOfflineAuth(): Promise<boolean> {
		return false;
	}

	async function attemptOnlineLogin(role: string, username: string, password: string): Promise<HubAuthResult> {
		try {
			if (role === "till") {
				return await window.electronAPI!.node.loginViaHub(username, password);
			}
			return await window.electronAPI!.node.loginOnline(username, password);
		} catch (err) {
			return {
				success: false,
				reason: "erpnext_unreachable",
				error: err instanceof Error ? err.message : "Login request failed",
			};
		}
	}

	async function login(username: string, password: string): Promise<boolean> {
		try {
			isLoading.value = true;
			error.value = "";

			if (isElectron()) {
				let role = "hub";
				try {
					role = await window.electronAPI!.node.getRole();
				} catch {
					/* default to hub, matching main.ts's own default when role is unknown */
				}

				const onlineResult = await attemptOnlineLogin(role, username, password);

				if (onlineResult.success && onlineResult.user) {
					isAuthenticated.value = true;
					isOfflineAuth.value = false;
					user.value = {
						user: username,
						user_email: username,
						user_fullname: onlineResult.user.full_name || username,
					};
					if (role === "hub") {
						window.electronAPI!.startSyncEngine().catch(() => {
							/* non-fatal — background sync will retry */
						});
					}
					await loadPermissions(username);
					return true;
				}

				// Hard stops: the server has just told us definitively that this
				// credential pair is wrong, or this user isn't a POS user. Do NOT
				// fall back to a stale local hash here — that would mask a real
				// password change or deactivation with an old local hash, which
				// would be a security regression.
				if (onlineResult.reason === "invalid_credentials") {
					error.value = "Incorrect username or password.";
					return false;
				}
				if (onlineResult.reason === "no_pos_profile") {
					error.value = "This user is not linked to an active POS Profile.";
					return false;
				}

				// Remaining reasons (erpnext_unreachable / not_configured /
				// wrong_role / error) are connectivity or configuration problems,
				// not credential problems — fall back to local offline auth.
				return await loginOffline(username, password);
			}

			await call("login", {
				usr: username,
				pwd: password,
			});

			isAuthenticated.value = true;
			isOfflineAuth.value = false;
			user.value = {
				user: username,
				user_email: username,
			};

			await loadPermissions(username);
			return true;
		} catch (err) {
			console.error("Login failed:", err);
			error.value = err instanceof Error ? err.message : "Login failed";
			return false;
		} finally {
			isLoading.value = false;
		}
	}

	async function loginOffline(username: string, password: string): Promise<boolean> {
		try {
			const posUser = await window.electronAPI!.db.getPosUser(username);
			if (!posUser) {
				error.value = "User not found. Check your username.";
				return false;
			}

			const userData = posUser as Record<string, unknown>;
			const storedHash = userData.password_hash as string | undefined;
			if (!storedHash) {
				error.value = "No password configured for this user.";
				return false;
			}

			const inputHash = await hashPassword(password);
			if (inputHash !== storedHash) {
				error.value = "Invalid password";
				return false;
			}

			isAuthenticated.value = true;
			isOfflineAuth.value = true;
			user.value = {
				user: username,
				user_email: (userData.email as string) || username,
				user_fullname: (userData.full_name as string) || username,
			};

			await window.electronAPI!.db.setSetting("last_logged_user", username, "auth");
			window
				.electronAPI!.startSyncEngine()
				.then((result) => {
					if (!result.success) {
						console.warn("[XPOS] Sync engine start failed:", result.error);
					}
				})
				.catch((err) => {
					console.warn("[XPOS] startSyncEngine error:", err);
				});

			await loadPermissions(username);
			return true;
		} catch (err) {
			console.error("Login failed:", err);
			error.value = "Login failed";
			return false;
		}
	}

	async function hashPassword(password: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(password);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	async function sendResetPasswordEmail(email: string): Promise<boolean> {
		try {
			isLoading.value = true;
			error.value = "";
			resetEmailSent.value = false;

			await call("frappe.core.doctype.user.user.reset_password", { user: email });

			resetEmailSent.value = true;
			return true;
		} catch (err) {
			console.error("Reset password failed:", err);
			error.value = err instanceof Error ? err.message : "Failed to send reset email";
			return false;
		} finally {
			isLoading.value = false;
		}
	}

	async function logout(): Promise<void> {
		try {
			isLoading.value = true;

			if (!isOfflineAuth.value) {
				await call("logout");
			}

			isAuthenticated.value = false;
			isOfflineAuth.value = false;
			user.value = null;
			resetPermissions();

			if (isElectron()) {
				try {
					await window.electronAPI!.db.setSetting("last_logged_user", "", "auth");
				} catch {
					/* ignore */
				}
				window.location.hash = "#/login";
				window.location.reload();
			} else {
				window.location.href = "/xpos/login";
			}
		} catch (err) {
			console.error("Logout failed:", err);
		} finally {
			isLoading.value = false;
		}
	}

	function clearError(): void {
		error.value = "";
	}

	function $reset(): void {
		isLoading.value = false;
		isAuthenticated.value = false;
		isOfflineAuth.value = false;
		user.value = null;
		error.value = "";
		resetEmailSent.value = false;
		resetPermissions();
	}

	return {
		isLoading,
		isAuthenticated,
		isOfflineAuth,
		user,
		error,
		resetEmailSent,
		userName,
		userEmail,
		userFullName,
		isGuest,
		isSystemManager,
		canManagePermissions,
		checkAuth,
		login,
		sendResetPasswordEmail,
		logout,
		clearError,
		$reset,
	};
});
