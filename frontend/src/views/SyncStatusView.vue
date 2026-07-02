<template>
	<div class="h-full min-h-0 flex flex-col">
		<div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
			<div>
				<h1 class="text-base font-semibold text-foreground">{{ __("Invoice Sync Status") }}</h1>
				<p class="text-xs text-muted-foreground">
					{{ __("Reconciles this terminal's local invoice queue against what actually exists on the server.") }}
				</p>
			</div>
			<Button variant="outline" size="sm" class="gap-1.5" :disabled="isLoading" @click="load">
				<Loader2 v-if="isLoading" class="w-4 h-4 animate-spin" />
				<RefreshCw v-else class="w-4 h-4" />
				{{ __("Refresh") }}
			</Button>
		</div>

		<div v-if="!isElectron()" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
			{{ __("Sync status is only available in the desktop app.") }}
		</div>

		<div v-else class="flex-1 overflow-y-auto p-4 space-y-6 xpos-scrollbar">
			<section>
				<h2 class="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
					<HardDrive class="w-4 h-4" />
					{{ __("Local Queue") }}
					<Badge variant="secondary" class="text-[10px]">{{ localRows.length }}</Badge>
				</h2>
				<div v-if="localRows.length === 0" class="text-xs text-muted-foreground py-4 text-center">
					{{ __("No local invoice records on this terminal.") }}
				</div>
				<div class="space-y-2">
					<div
						v-for="row in localRows"
						:key="row.local_id"
						class="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-3"
					>
						<div class="min-w-0">
							<p class="text-sm font-medium truncate">
								{{ row.customer_name || __("Unknown Customer") }}
								<span class="text-muted-foreground font-normal">
									&bull; {{ posStore.currencySymbol }}{{ formatAmount(row.grand_total) }}
								</span>
							</p>
							<p class="text-xs text-muted-foreground truncate">{{ row.local_id }}</p>
						</div>
						<div class="text-end shrink-0">
							<Badge :variant="linkStatusVariant(row.linkStatus)" class="text-[10px]">
								{{ row.linkStatus }}
							</Badge>
							<p v-if="row.server_name" class="text-xs text-muted-foreground mt-1">
								{{ row.server_name }}
							</p>
						</div>
					</div>
				</div>
			</section>

			<section>
				<h2 class="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
					<Cloud class="w-4 h-4" />
					{{ __("Live Invoices") }} ({{ posStore.profileName }})
					<Badge variant="secondary" class="text-[10px]">{{ liveRows.length }}</Badge>
				</h2>
				<div v-if="isLoading" class="text-xs text-muted-foreground py-4 text-center">
					{{ __("Loading...") }}
				</div>
				<div v-else-if="liveRows.length === 0" class="text-xs text-muted-foreground py-4 text-center">
					{{ __("No invoices found on the server for this POS profile.") }}
				</div>
				<div class="space-y-2">
					<div
						v-for="row in liveRows"
						:key="row.name"
						class="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-3"
					>
						<div class="min-w-0">
							<p class="text-sm font-medium truncate">
								{{ row.customer_name || row.customer }}
								<span class="text-muted-foreground font-normal">
									&bull; {{ posStore.currencySymbol }}{{ formatAmount(row.grand_total) }}
								</span>
							</p>
							<p class="text-xs text-muted-foreground truncate">{{ row.name }}</p>
						</div>
						<div class="text-end shrink-0">
							<Badge :variant="linkStatusVariant(row.linkStatus)" class="text-[10px]">
								{{ row.linkStatus }}
							</Badge>
							<Badge
								v-if="row.docstatus === 2"
								variant="outline"
								class="text-[10px] mt-1 block w-fit ml-auto text-destructive border-destructive/40"
							>
								{{ __("Cancelled") }}
							</Badge>
						</div>
					</div>
				</div>
			</section>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { usePosStore } from "@/stores/posStore";
import { isElectron } from "@/services/electronBridge";
import { getPendingInvoices } from "@/services/dbBridge";
import { call, showError } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Loader2, HardDrive, Cloud } from "lucide-vue-next";
import __ from "@/lib/translate";
import type { PendingInvoice } from "@/services/idbService";

interface LiveInvoice {
	name: string;
	customer: string;
	customer_name: string;
	posting_date: string;
	grand_total: number;
	status: string;
	docstatus: number;
	xpos_local_id: string | null;
	creation: string;
}

type LinkStatus =
	| "Linked"
	| "Cancelled on Server"
	| "Not Synced Yet"
	| "Orphaned Locally"
	| "No Local Record"
	| "Not Tracked";

interface LocalRow extends PendingInvoice {
	linkStatus: LinkStatus;
}

interface LiveRow extends LiveInvoice {
	linkStatus: LinkStatus;
}

const posStore = usePosStore();
const isLoading = ref(false);
const localRows = ref<LocalRow[]>([]);
const liveRows = ref<LiveRow[]>([]);

async function load() {
	if (!isElectron()) return;
	isLoading.value = true;
	try {
		const [local, live] = await Promise.all([
			getPendingInvoices() as Promise<PendingInvoice[]>,
			posStore.profileName
				? call<LiveInvoice[]>("xpos.api.invoices.get_invoice_sync_status", {
						pos_profile: posStore.profileName,
					})
				: Promise.resolve([]),
		]);

		const liveByLocalId = new Map(live.filter((l) => l.xpos_local_id).map((l) => [l.xpos_local_id, l]));
		const localIds = new Set(local.map((l) => l.local_id).filter(Boolean));

		localRows.value = local
			.map((row) => {
				const match = row.local_id ? liveByLocalId.get(row.local_id) : undefined;
				let linkStatus: LinkStatus;
				if (match) {
					linkStatus = match.docstatus === 2 ? "Cancelled on Server" : "Linked";
				} else if (row.status === "synced") {
					// Marked synced locally but no matching server record was found —
					// the server-side document this pointed to no longer exists.
					linkStatus = "Orphaned Locally";
				} else {
					linkStatus = "Not Synced Yet";
				}
				return { ...row, linkStatus };
			})
			.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

		liveRows.value = live.map((row) => {
			let linkStatus: LinkStatus;
			if (!row.xpos_local_id) {
				linkStatus = "Not Tracked";
			} else if (localIds.has(row.xpos_local_id)) {
				linkStatus = row.docstatus === 2 ? "Cancelled on Server" : "Linked";
			} else {
				linkStatus = "No Local Record";
			}
			return { ...row, linkStatus };
		});
	} catch (error) {
		showError(__("Failed to load sync status"));
		console.error("[XPOS] Failed to load sync status:", error);
	} finally {
		isLoading.value = false;
	}
}

function linkStatusVariant(
	status: LinkStatus,
): "default" | "success" | "warning" | "destructive" | "secondary" | "outline" {
	switch (status) {
		case "Linked":
			return "success";
		case "Not Synced Yet":
			return "warning";
		case "Cancelled on Server":
		case "Orphaned Locally":
		case "No Local Record":
			return "destructive";
		default:
			return "secondary";
	}
}

function formatAmount(val?: number) {
	if (val == null) return "0.00";
	return Number(val).toFixed(2);
}

onMounted(load);
</script>
