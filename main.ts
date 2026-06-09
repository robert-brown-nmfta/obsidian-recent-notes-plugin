import {
	App,
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_RECENT_NOTES = "recent-notes-view";

interface RecentNotesSettings {
	maxDays: number;
	maxFilesPerDay: number;
	showFullPath: boolean;
}

const DEFAULT_SETTINGS: RecentNotesSettings = {
	maxDays: 7,
	maxFilesPerDay: 50,
	showFullPath: false,
};

interface FileEntry {
	file: TFile;
	mtime: number;
}

function getParentPath(filePath: string): string {
	const split = filePath.split("/");
	split.pop();
	return split.length ? split.join("/") : "Root";
}

function formatRelativeTime(mtime: number, now: number): string {
	const diffMinutes = Math.max(1, Math.floor((now - mtime) / (1000 * 60)));
	if (diffMinutes < 60) return `${diffMinutes}m ago`;

	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;

	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

function getDayLabel(date: Date): string {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);

	const fileDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

	if (fileDay.getTime() === today.getTime()) return "Today";
	if (fileDay.getTime() === yesterday.getTime()) return "Yesterday";

	return fileDay.toLocaleDateString(undefined, {
		weekday: "long",
		month: "short",
		day: "numeric",
	});
}

function groupByDay(files: FileEntry[]): Map<string, FileEntry[]> {
	const groups = new Map<string, FileEntry[]>();

	for (const entry of files) {
		const date = new Date(entry.mtime);
		const label = getDayLabel(date);
		if (!groups.has(label)) {
			groups.set(label, []);
		}
		groups.get(label)!.push(entry);
	}

	return groups;
}

class RecentNotesView extends ItemView {
	private plugin: RecentNotesPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: RecentNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RECENT_NOTES;
	}

	getDisplayText(): string {
		return "Recent Notes";
	}

	getIcon(): string {
		return "clock";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		// cleanup
	}

	async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("recent-notes-container");

		const settings = this.plugin.settings;
		const now = Date.now();
		const cutoff = now - settings.maxDays * 24 * 60 * 60 * 1000;

		// Gather all markdown files modified within the cutoff
		const allFiles = this.app.vault.getMarkdownFiles();
		const recent: FileEntry[] = allFiles
			.filter((f) => f.stat.mtime >= cutoff)
			.map((f) => ({ file: f, mtime: f.stat.mtime }))
			.sort((a, b) => b.mtime - a.mtime);

		if (recent.length === 0) {
			const empty = container.createEl("div", { cls: "recent-notes-empty" });
			empty.setText("No recently edited notes found.");
			return;
		}

		const panelHead = container.createEl("div", { cls: "recent-notes-panel-head" });
		panelHead.createEl("div", { cls: "recent-notes-panel-title", text: "Recent Activity" });
		panelHead.createEl("div", {
			cls: "recent-notes-panel-subtitle",
			text: `${recent.length} notes edited in the last ${settings.maxDays} day${settings.maxDays === 1 ? "" : "s"}`,
		});

		const grouped = groupByDay(recent);

		for (const [dayLabel, entries] of grouped) {
			const daySection = container.createEl("div", { cls: "recent-notes-day-section" });
			const header = daySection.createEl("div", { cls: "recent-notes-day-header" });
			header.createEl("div", { cls: "recent-notes-day-label", text: dayLabel });
			header.createEl("div", { cls: "recent-notes-day-count", text: String(entries.length) });

			const list = daySection.createEl("div", { cls: "recent-notes-list" });

			const limited = entries.slice(0, settings.maxFilesPerDay);
			for (const entry of limited) {
				const item = list.createEl("div", { cls: "recent-notes-item" });
				const content = item.createEl("div", { cls: "recent-notes-content" });
				const link = content.createEl("a", { cls: "recent-notes-link" });

				const displayName = settings.showFullPath
					? entry.file.path
					: entry.file.basename;

				link.setText(displayName);
				link.title = entry.file.path;
				link.setAttribute("href", "#");

				link.addEventListener("click", (e) => {
					e.preventDefault();
					this.app.workspace.openLinkText(entry.file.path, "", false);
				});

				const meta = content.createEl("div", { cls: "recent-notes-meta" });
				if (!settings.showFullPath) {
					meta.createEl("span", {
						cls: "recent-notes-path",
						text: getParentPath(entry.file.path),
					});
				}
				meta.createEl("span", {
					cls: "recent-notes-meta-time",
					text: new Date(entry.mtime).toLocaleTimeString(undefined, {
						hour: "2-digit",
						minute: "2-digit",
					}),
				});

				item.createEl("span", {
					cls: "recent-notes-time",
					text: formatRelativeTime(entry.mtime, now),
				});
			}

			if (entries.length > settings.maxFilesPerDay) {
				const more = daySection.createEl("div", { cls: "recent-notes-more" });
				more.setText(`+${entries.length - settings.maxFilesPerDay} more`);
			}
		}
	}
}

export default class RecentNotesPlugin extends Plugin {
	settings: RecentNotesSettings;
	private view: RecentNotesView | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_RECENT_NOTES, (leaf) => {
			this.view = new RecentNotesView(leaf, this);
			return this.view;
		});

		this.addRibbonIcon("clock", "Recent Notes", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-recent-notes",
			name: "Open Recent Notes",
			callback: () => this.activateView(),
		});

		// Re-render when any file is modified
		this.registerEvent(
			this.app.vault.on("modify", () => this.refreshView())
		);
		this.registerEvent(
			this.app.vault.on("create", () => this.refreshView())
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.refreshView())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.refreshView())
		);

		this.addSettingTab(new RecentNotesSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_RECENT_NOTES);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getRightLeaf(false)!;
		await leaf.setViewState({ type: VIEW_TYPE_RECENT_NOTES, active: true });

		workspace.revealLeaf(leaf);
	}

	private refreshView(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECENT_NOTES);
		for (const leaf of leaves) {
			if (leaf.view instanceof RecentNotesView) {
				leaf.view.render();
			}
		}
	}
}

class RecentNotesSettingTab extends PluginSettingTab {
	plugin: RecentNotesPlugin;

	constructor(app: App, plugin: RecentNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Recent Notes Settings" });

		new Setting(containerEl)
			.setName("Days to show")
			.setDesc("Number of past days to include in the list.")
			.addText((text) =>
				text
					.setPlaceholder("7")
					.setValue(String(this.plugin.settings.maxDays))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.maxDays = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max files per day")
			.setDesc("Maximum number of files to show per day group.")
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.maxFilesPerDay))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.maxFilesPerDay = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Show full path")
			.setDesc("Show the full file path instead of just the file name.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFullPath)
					.onChange(async (value) => {
						this.plugin.settings.showFullPath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
