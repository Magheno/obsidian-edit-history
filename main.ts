import {
    App,
    ButtonComponent,
    Component,
    DropdownComponent,
    Editor,
    MarkdownRenderer,
    MarkdownView,
    Modal,
    normalizePath,
    Notice,
    Plugin,
    PluginSettingTab,
    setIcon,
    Setting,
    TAbstractFile,
    TFile,
    TFolder,
    ToggleComponent
} from "obsidian";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { DiffMatchPatch, Diff } from "diff-match-patch-ts";
// diff-match-patch-ts doesn't export properly module enums, it uses a const
// enum (instead of a non const enum) which is removed at compile time and not
// visible by importers:
//  - Without isolatedModules set it errors out with "Cannot access ambient
//    const enums when the '--isolatedModules' flag is provided" 
//  - With isolated isolatedModules set to false in tsconfig.json, when
//    importing DiffOp the DiffOp object exists but it's null and the defines
//    cannot be used 
// Copy them here from diff-op.enum.d.ts
const enum DiffOp {
    Delete = -1,
    Equal = 0,
    Insert = 1
}

// @ts-ignore: Complains about default export this way, but since jszip 3.10
// this is the recommended way
import JSZip from "jszip";


// Debuglevels in increasing severity so messages >= indexOf(debugLevel) will be
// shown
const debugLevels = ["debug", "info", "warn", "error"];

let logError = function(message?: any, ...optionalParams: any[]) {};
let logWarn = function(message?: any, ...optionalParams: any[]) {};
// Note console.log is an alias of console.info
let logInfo = function(message?: any, ...optionalParams: any[]) {};
let logDbg = function(message?: any, ...optionalParams: any[]) {};

function hookLogFunctions(debugLevelIndex: number, tag: string) {
    logInfo("hookLogFunctions", debugLevelIndex, tag);

    const logIgnore = function(message?: any, ...optionalParams: any[]) {};
    logError = (debugLevelIndex <= debugLevels.indexOf("error")) ? 
        console.error.bind(console, tag + "[ERROR]:") :
        logIgnore;
    logWarn = (debugLevelIndex <= debugLevels.indexOf("warn")) ?
        console.warn.bind(console, tag + "[WARN]:") :
        logIgnore;
    logInfo = (debugLevelIndex <= debugLevels.indexOf("info")) ?
        console.info.bind(console, tag + "[INFO]:") :
        logIgnore;
    logDbg = (debugLevelIndex <= debugLevels.indexOf("debug")) ?
        console.debug.bind(console, tag + "[DEBUG]:") :
        logIgnore;
}

function debugbreak() {
    debugger;
}

 const htmlChars :  { [key: string]: string } = {
    "&" : "&amp;",
    "\"": "&quot;",
    "'/": '&#39;',
    "<" : '&lt;',
    ">": '&gt;',
    "\n": "<br>\n",
 };
 const htmlCharsRegexp = new RegExp(Object.keys(htmlChars).join("|"), "g");

 const htmlWhitespaceChars : { [key: string]: string } = {
     ...htmlChars,
    "\t": "&rarr;\t",
    " ": "&middot;",
    "\n": "&para;<br>\n"
 };
 const htmlWhitespaceCharsRegexp = new RegExp(Object.keys(htmlWhitespaceChars).join("|"), "g");

function htmlEncode(str: string, whitespace: boolean): string {
    // XXX or use document.createTextNode(str).textContent?
    // This can be a performance hotspot, so use an efficient way of replacing
    // multiple strings in a single pass
    return (whitespace) 
        ? str.replace(htmlWhitespaceCharsRegexp, c => htmlWhitespaceChars[c])
        : str.replace(htmlCharsRegexp, c => htmlChars[c]);
}

enum DiffDisplayFormat {
    Page       = "PAGE",
    Raw        = "RAW",
    Timeline   = "TIMELINE",
    Inline     = "INLINE",
    Horizontal = "HORIZONTAL",
    Vertical   = "VERTICAL",
};

const diffDisplayFormatToString: Record<DiffDisplayFormat, string> = {
    [DiffDisplayFormat.Page]       : "page (rendered)",
    [DiffDisplayFormat.Raw]        : "raw",
    [DiffDisplayFormat.Timeline]   : "timeline",
    [DiffDisplayFormat.Inline]     : "inline",
    [DiffDisplayFormat.Horizontal] : "side by side",
    [DiffDisplayFormat.Vertical]   : "top by bottom",
};

interface EditHistorySettings {
    minSecondsBetweenEdits: string;
    maxEdits: string;
    maxEditAge: string;
    maxHistoryFileSizeKB: string;
    editHistoryRootFolder: string;
    extensionWhitelist: string;
    substringBlacklist: string;
    showOnStatusBar: boolean;
    diffDisplayFormat: string;
    showWhitespace: boolean;
    debugLevel: string;
    authorName: string;
    authorOverrideTimeoutMinutes: string;
    // Vault-shared map of OS hostname -> author name. When set, takes priority
    // over `authorName` so a single shared `data.json` correctly attributes
    // edits made on different devices to different humans (e.g.
    // {"Crest": "Raf Peeters", "APL-BBB": "Mark Volders"}). The override file
    // still wins so external agents can self-identify.
    deviceAuthors: Record<string, string>;
    useMirroredStorage: boolean;
    // XXX Have color setting for addition fore/back, deletion fore/back
}

const DEFAULT_SETTINGS: EditHistorySettings = {
    minSecondsBetweenEdits: "60",
    maxEditAge: "0",
    maxEdits: "0",
    maxHistoryFileSizeKB: "0",
    editHistoryRootFolder: "",
    extensionWhitelist: ".md, .txt, .csv, .htm, .html",
    substringBlacklist: "",
    showOnStatusBar: true,
    diffDisplayFormat: DiffDisplayFormat.Page,
    showWhitespace: true,
    debugLevel: "warn",
    authorName: "",
    authorOverrideTimeoutMinutes: "10",
    deviceAuthors: {},
    useMirroredStorage: false
}

// Root folder used when mirrored storage is enabled. Starts with "." so
// Obsidian's file explorer hides it by default — the whole point of this mode
// is to get .edtz files out of the user's visible tree.
const MIRRORED_STORAGE_ROOT = ".edtz";

// Filename format for edits: <epoch36> or <epoch36>$ (full snapshot), with an
// optional "@<urlencoded-author>" suffix. parseInt(fn, 36) stops at "@"/"$" so
// the epoch still parses out of either variant.
const EDIT_AUTHOR_DELIM = "@";

// Path inside the plugin's config dir (relative to vault root) that an external
// process — CLI, AI agent — can write/delete to override the active author for
// subsequent edits. Content is the author name (whitespace-trimmed). If the
// file is empty or missing the active author falls back to settings.authorName
// then the device hostname then "unknown".
const AUTHOR_OVERRIDE_FILE = "current-author";

const EDIT_HISTORY_FILE_EXT = ".edtz";

// --- Device-local "seen changes" state ---------------------------------------
// We track "last time you viewed this file on THIS device" in localStorage so
// that opening a note shows changes since your previous visit. localStorage is
// per-Electron-install = per-device; even if the vault is synced, each machine
// has its own bookmark. Keys are prefixed to avoid collisions with other
// plugins / with Obsidian internals.
const LAST_VIEWED_LS_PREFIX = "edit-history:last-viewed:";

function getLastViewed(filePath: string): number | null {
    try {
        const raw = localStorage.getItem(LAST_VIEWED_LS_PREFIX + filePath);
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}
function setLastViewed(filePath: string, epoch: number) {
    try {
        localStorage.setItem(LAST_VIEWED_LS_PREFIX + filePath, String(epoch));
    } catch {
        // localStorage quota / disabled — ignore, we just lose the bookmark.
    }
}

// --- Author → color ----------------------------------------------------------
// Deterministic hash-to-hue so the same author always gets the same color, and
// different authors spread around the color wheel without needing a configured
// palette.
function hashStringToHue(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % 360;
}
function getAuthorColor(author: string): string {
    return `hsl(${hashStringToHue(author)}, 65%, 50%)`;
}

// Minimum line length (after trimming) for a line to be considered for blame
// matching. Blank lines and single-char markers like "---" or "|" would match
// too often and swamp the output with noise.
const BLAME_MIN_LINE_LEN = 3;

// --- CM6 integration ---------------------------------------------------------
// A StateField per editor view holds the current set of per-line "changed
// since your last visit" decorations. Two effects act on it:
//  - replaceBlameDecorationsEffect: overwrite the whole set (dispatched by the
//    plugin after it's recomputed blame for the file).
//  - clearAllBlameEffect: drop everything (used by the "Mark as read" command).
// Additionally, any doc-change in a transaction automatically clears
// decorations on the touched lines — that's the "fade once you've edited the
// changed region" behavior baked into the field itself, no plugin round-trip
// required.
interface BlameLineSpec {
    line: number;      // 1-based line number
    author: string;
    color: string;
}

const replaceBlameDecorationsEffect = StateEffect.define<DecorationSet>();
const clearAllBlameEffect = StateEffect.define<null>();

function buildBlameDecorations(view: EditorView, specs: BlameLineSpec[]): DecorationSet {
    const doc = view.state.doc;
    const items: { from: number; spec: BlameLineSpec }[] = [];
    for (const s of specs) {
        if (s.line < 1 || s.line > doc.lines) continue;
        items.push({ from: doc.line(s.line).from, spec: s });
    }
    items.sort((a, b) => a.from - b.from);
    const decos = items.map(b =>
        Decoration.line({
            attributes: {
                style: `--edit-history-blame-color: ${b.spec.color};`,
                title: `Changed since your last visit — ${b.spec.author}`
            },
            class: "edit-history-blame-line"
        }).range(b.from)
    );
    return Decoration.set(decos, true);
}

const blameField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const e of tr.effects) {
            if (e.is(replaceBlameDecorationsEffect)) decos = e.value;
            if (e.is(clearAllBlameEffect)) decos = Decoration.none;
        }
        if (tr.docChanged) {
            const touched = new Set<number>();
            tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
                const doc = tr.state.doc;
                let pos = fromB;
                while (pos <= toB) {
                    const line = doc.lineAt(pos);
                    touched.add(line.from);
                    if (line.to >= doc.length) break;
                    pos = line.to + 1;
                }
            });
            if (touched.size > 0) {
                decos = decos.update({ filter: (from) => !touched.has(from) });
            }
        }
        return decos;
    },
    provide: f => EditorView.decorations.from(f)
});

// XXX Use Github actions to release plugin 
//     See https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions
//     See https://github.com/marcusolsson/obsidian-projects/blob/main/.github/workflows/release.yml

// XXX Ignore changes if not enough diffs/too small?

// XXX Allow merging entries in the edit history file older than a given time,
//     at a given granularity

// XXX Feed the editor undo stack with the contents of the history file? (could
//     be done without private apis by inserting the text in edit history order at file
//     load, will probably need a flag to prevent from storing double history)

// XXX Allow management in the edit history modal, merging diffs, deleting, deleting all historyç

// XXX tgz reduces size by half, use native browser gzip plus tar? (at the
//     expense of having to uncompress the whole file in memory, not clear jszip
//     does that already anyway?)
//     See https://stackoverflow.com/questions/65446607/how-do-i-extract-data-from-a-tar-gz-file-stored-in-the-cloud-from-a-browser


export default class EditHistory extends Plugin {
    settings: EditHistorySettings;
    statusBarItemEl: HTMLElement;

    // Minimum number of milliseconds between edits or Infinity, if a
    // modification occurs before that time will be ignored at this moment and
    // lumped with later modifications once the minimum time has passed and a
    // new modification is done This means that the edit file may not contain
    // the latest version Note that because of the current filename being
    // derived from the epoch in seconds, changes done less than one second
    // apart are ignored and lumped with the next change 
    minMsBetweenEdits: number;
    // Maximum number of age in milliseconds or Infinity
    maxEditAgeMs: number;
    // Maximum number of edits to keep or Infinity
    maxEdits: number;
    // Maximum size in bytes of the history file or Infinity
    maxEditHistoryFileSize: number;
    // Whitelist of note filename extensions to store edit history for. In
    // lowercase and including the initial dot. Empty for all.
    extensionWhitelist: string[];
    // Blacklist of note filepath substrings not to store edit history for. In
    // lowercase, empty for none. Note obsidian normalizes paths to use forward
    // slash, so substrings for paths should use forward slashes
    substringBlacklist: string[];
    // For now this should be "", other values work but the UX is not clear
    // because the folder will be visible and the user may move it around
    // breaking things
    editHistoryRootFolder: string;

    /**
     * @return true if an edit history file should be kept for this file
     */
    keepEditHistoryForFile(file: TAbstractFile): boolean {
        // Don't keep edit history for folders
        if (!(file instanceof TFile)) {
            return false;
        }

        // The vault will call on change callback on the edit history file when
        // modified using the Obsidian API, trap it so it's ignored downstream
        if (file.name.endsWith(EDIT_HISTORY_FILE_EXT)) {
            return false;
        }

        // Don't keep edit history file for filepaths containing the substring
        // blacklist
        if (this.substringBlacklist.length > 0) {
            const filepath = file.path.toLowerCase();
            for (let substring of this.substringBlacklist) {
                if (filepath.contains(substring)) {
                    logInfo("Not keeping history file '" + filepath + "' due to blacklist substring '" + substring + "'");
                    return false;
                }
            }
        }

        // Keep an edit history file for all files if there are no extensions,
        // otherwise just for the extensions that match
        if (this.extensionWhitelist.length == 0) {
            return true;
        } else {
            const filename = file.name.toLowerCase();
            for (let ext of this.extensionWhitelist) {
                if (filename.endsWith(ext)) {
                    return true;
                }
            }
        }
        return false;
    }

    keepEditHistoryForActiveFile(): boolean {
        const activeFile = this.app.workspace.getActiveFile();

        return ((activeFile != null) && (this.keepEditHistoryForFile(activeFile)));
    }
    
    getEditHistoryFilepath(filepath: string): string {
        return normalizePath(this.editHistoryRootFolder + "/" + filepath + EDIT_HISTORY_FILE_EXT);
    }

    /**
     * The history-file I/O goes through the low-level vault.adapter, not
     * vault.getAbstractFileByPath + vault.readBinary, because Obsidian's
     * vault tree does not reliably expose files inside dotfile folders
     * (`.edtz/`) — which means the modal, blame logic, and save path would
     * all think history doesn't exist when mirrored storage is active. The
     * adapter reads the actual filesystem.
     */
    async editHistoryExists(notePath: string): Promise<boolean> {
        return this.app.vault.adapter.exists(this.getEditHistoryFilepath(notePath));
    }

    async readEditHistoryBinary(notePath: string): Promise<ArrayBuffer | null> {
        const p = this.getEditHistoryFilepath(notePath);
        if (!(await this.app.vault.adapter.exists(p))) return null;
        return this.app.vault.adapter.readBinary(p);
    }

    async writeEditHistoryBinary(notePath: string, data: ArrayBuffer): Promise<void> {
        const p = this.getEditHistoryFilepath(notePath);
        await this.ensureParentFolder(p);
        await this.app.vault.adapter.writeBinary(p, data);
    }

    async deleteEditHistory(notePath: string): Promise<void> {
        const p = this.getEditHistoryFilepath(notePath);
        if (await this.app.vault.adapter.exists(p)) {
            await this.app.vault.adapter.remove(p);
        }
    }

    async renameEditHistory(oldNotePath: string, newNotePath: string): Promise<boolean> {
        const oldP = this.getEditHistoryFilepath(oldNotePath);
        const newP = this.getEditHistoryFilepath(newNotePath);
        if (oldP === newP) return false;
        if (!(await this.app.vault.adapter.exists(oldP))) return false;
        if (await this.app.vault.adapter.exists(newP)) {
            logWarn("Rename target already exists, skipping", newP);
            return false;
        }
        await this.ensureParentFolder(newP);
        await this.app.vault.adapter.rename(oldP, newP);
        return true;
    }

    async ensureParentFolder(path: string): Promise<void> {
        const slash = path.lastIndexOf("/");
        if (slash <= 0) return;
        const parent = path.slice(0, slash);
        if (await this.app.vault.adapter.exists(parent)) return;
        try {
            await this.app.vault.createFolder(parent);
        } catch (e) {
            // createFolder races with other code creating the same parent —
            // if it throws because the folder now exists that's fine, the
            // next write will succeed.
            logDbg("createFolder threw (likely already exists)", parent, e);
        }
    }

    /**
     * Given the current vault path of a `.edtz` file, return the path of the
     * note it belongs to (i.e. strip off the mirrored-root prefix if present,
     * and the trailing `.edtz`). Returns null if the path doesn't look like a
     * managed edit-history file.
     */
    edtzToNotePath(edtzPath: string): string | null {
        if (!edtzPath.toLowerCase().endsWith(EDIT_HISTORY_FILE_EXT)) return null;
        let remainder = edtzPath.slice(0, edtzPath.length - EDIT_HISTORY_FILE_EXT.length);
        const mirroredPrefix = MIRRORED_STORAGE_ROOT + "/";
        if (remainder.startsWith(mirroredPrefix)) {
            remainder = remainder.slice(mirroredPrefix.length);
        }
        return remainder.length > 0 ? remainder : null;
    }

    /**
     * Move every existing .edtz file into the layout selected by
     * `targetUseMirrored`. Returns a small summary for the caller to display.
     * This walks the vault once and uses fileManager.renameFile for each move
     * so Obsidian's link tracker + any watchers stay consistent.
     */
    async migrateEditHistoryFiles(targetUseMirrored: boolean): Promise<{ moved: number; skipped: number; errors: number }> {
        const edtzFiles = this.app.vault.getFiles().filter(
            f => f.path.toLowerCase().endsWith(EDIT_HISTORY_FILE_EXT)
        );
        let moved = 0;
        let skipped = 0;
        let errors = 0;
        for (const edtz of edtzFiles) {
            const notePath = this.edtzToNotePath(edtz.path);
            if (!notePath) { skipped++; continue; }
            const targetPath = normalizePath(
                (targetUseMirrored ? (MIRRORED_STORAGE_ROOT + "/") : "") + notePath + EDIT_HISTORY_FILE_EXT
            );
            if (targetPath === edtz.path) { skipped++; continue; }
            // Avoid clobbering: if a destination already exists, keep both
            // and leave the old one for the user to inspect.
            if (this.app.vault.getAbstractFileByPath(targetPath) != null) {
                logWarn("Migration target already exists, skipping", edtz.path, "->", targetPath);
                errors++;
                continue;
            }
            // Make sure parent folders exist. fileManager.renameFile requires
            // the destination parent directory.
            const parent = targetPath.includes("/") ? targetPath.slice(0, targetPath.lastIndexOf("/")) : "";
            if (parent && this.app.vault.getAbstractFileByPath(parent) == null) {
                try {
                    await this.app.vault.createFolder(parent);
                } catch (e) {
                    // createFolder throws if the folder already exists (race)
                    // — that's fine, proceed.
                    logDbg("createFolder threw (likely already exists)", parent, e);
                }
            }
            try {
                await this.app.fileManager.renameFile(edtz, targetPath);
                moved++;
            } catch (e) {
                logWarn("Failed to move", edtz.path, "->", targetPath, e);
                errors++;
            }
        }
        // If we moved everything out of the .edtz root, try to prune the
        // now-empty mirror tree so there are no ghost folders sitting around.
        if (!targetUseMirrored) {
            const root = this.app.vault.getAbstractFileByPath(MIRRORED_STORAGE_ROOT);
            if (root instanceof TFolder) {
                await this.pruneEmptyFolders(root);
            }
        }
        return { moved, skipped, errors };
    }

    /**
     * Build a Set of note paths (no .edtz extension, no mirrored-root prefix)
     * that currently have a stored edit history. This is the single source of
     * truth for the file-explorer badge and is layout-agnostic.
     *
     * Why not just vault.getAbstractFileByPath per note? Because in mirrored
     * storage mode the history files live inside a dotfile folder (`.edtz/`),
     * which Obsidian's vault tree may not track — the vault API happily
     * returns null for paths inside `.`-prefixed folders on many versions.
     * Falling back to the low-level adapter.list() reads the actual
     * filesystem and always sees the files.
     */
    async getNotesWithHistorySet(): Promise<Set<string>> {
        const result = new Set<string>();

        for (const f of this.app.vault.getFiles()) {
            const notePath = this.edtzToNotePath(f.path);
            if (notePath) result.add(notePath);
        }

        // When mirrored storage is active, the authoritative listing comes
        // from the filesystem adapter, not the vault tree.
        if (this.editHistoryRootFolder) {
            try {
                await this.walkAdapterForEdtzFiles(this.editHistoryRootFolder, result);
            } catch (e) {
                logWarn("Adapter walk for edit-history files failed", e);
            }
        }
        return result;
    }

    async walkAdapterForEdtzFiles(folder: string, acc: Set<string>): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(folder))) return;
        const listing = await adapter.list(folder);
        for (const file of listing.files) {
            const notePath = this.edtzToNotePath(file);
            if (notePath) acc.add(notePath);
        }
        for (const sub of listing.folders) {
            await this.walkAdapterForEdtzFiles(sub, acc);
        }
    }

    /**
     * Walk all visible file-explorer items, hide .edtz rows, and add/remove
     * the clock badge on notes that have a stored history file.
     */
    async refreshFileExplorer(): Promise<void> {
        const notesWithHistory = await this.getNotesWithHistorySet();
        const leaves = this.app.workspace.getLeavesOfType("file-explorer");
        for (const leaf of leaves) {
            const view = leaf.view as unknown as {
                fileItems?: Record<string, { el?: HTMLElement; selfEl?: HTMLElement; titleEl?: HTMLElement }>
            };
            const fileItems = view?.fileItems;
            if (!fileItems) continue;
            for (const p in fileItems) {
                const item = fileItems[p];
                const titleEl = item.selfEl ?? item.titleEl;
                const rowEl = item.el ?? titleEl?.parentElement ?? undefined;
                if (!titleEl || !rowEl) continue;

                if (p.toLowerCase().endsWith(EDIT_HISTORY_FILE_EXT)) {
                    rowEl.addClass("edit-history-hidden-file");
                    continue;
                }

                const hasHistory = notesWithHistory.has(p);
                const existing = titleEl.querySelector(".edit-history-file-badge");
                if (hasHistory && !existing) {
                    const badge = titleEl.createEl("span", { cls: "edit-history-file-badge" });
                    setIcon(badge, "clock");
                    badge.setAttribute("aria-label", "Has edit history");
                } else if (!hasHistory && existing) {
                    existing.remove();
                }
            }
        }
    }

    /** Recursively delete any folder under `folder` (and folder itself) that
     *  has no descendants left. Used after a mirrored→sibling migration to
     *  tidy up the empty `.edtz/...` shadow tree. */
    async pruneEmptyFolders(folder: TFolder): Promise<boolean> {
        // Depth-first so children get a chance to become empty first.
        for (const child of folder.children.slice()) {
            if (child instanceof TFolder) {
                await this.pruneEmptyFolders(child);
            }
        }
        if (folder.children.length === 0 && folder.path !== "/" && folder.path !== "") {
            try {
                await this.app.vault.delete(folder);
                return true;
            } catch (e) {
                logWarn("Failed to delete empty folder", folder.path, e);
            }
        }
        return false;
    }

    getEditCompressedSize(zip: JSZip, filepath: string): number {
        // The only way of getting the file size is by accessing
        // the internal field _data
        // See https://github.com/Stuk/jszip/issues/247
        return zip.file(filepath)._data.compressedSize;
    }
    
    getEditEpoch(editFilename: string): number {
        return parseInt(editFilename, 36) * 1000;
    }

    getEditDate(editFilename: string): Date {
        return new Date(this.getEditEpoch(editFilename));
    }

    getEditLocalDateStr(editFilename: string): string {
        const date = this.getEditDate(editFilename).toLocaleString();
        const author = this.getEditAuthor(editFilename);
        return author ? `${date} — ${author}` : `${date} — unknown`;
    }

    getEditFileTime(editFilename: string): number {
        // Note this ignores the hh:mm:ss part of the time
        let d = this.getEditDate(editFilename);
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const t = d.getTime();
        return t;
    }

    getEditIsDiff(editFilename: string): boolean {
        // Full snapshots end with "$" in the epoch portion; an optional
        // "@<author>" suffix may follow either variant.
        const atIdx = editFilename.indexOf(EDIT_AUTHOR_DELIM);
        const epochPart = atIdx === -1 ? editFilename : editFilename.slice(0, atIdx);
        return !epochPart.endsWith("$");
    }

    getEditAuthor(editFilename: string): string | null {
        const atIdx = editFilename.indexOf(EDIT_AUTHOR_DELIM);
        if (atIdx === -1) return null;
        const raw = editFilename.slice(atIdx + 1);
        if (raw.length === 0) return null;
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }

    buildEditFilename(mtime: number, isDiff: boolean, author?: string | null): string {
        const utcepoch = Math.floor(mtime / 1000);
        let editFilename = utcepoch.toString(36) + (isDiff ? "" : "$");
        if (author) {
            editFilename += EDIT_AUTHOR_DELIM + encodeURIComponent(author);
        }
        return editFilename;
    }

    getAuthorOverridePath(): string {
        return normalizePath(
            `${this.app.vault.configDir}/plugins/${this.manifest.id}/${AUTHOR_OVERRIDE_FILE}`
        );
    }

    /**
     * Returns this device's OS hostname, or empty string if unavailable
     * (mobile platforms have no `os` module). The hostname is used as the key
     * into `settings.deviceAuthors` and as the final fallback author name.
     */
    getDeviceHostname(): string {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const os = require("os");
            const host = os?.hostname?.();
            return host ? String(host) : "";
        } catch {
            // Mobile: no node modules.
            return "";
        }
    }

    /**
     * Looks up this device in the vault-shared `deviceAuthors` map and
     * returns the configured author for the device's hostname. Returns ""
     * if the hostname is unknown, the map is empty, or there is no entry —
     * so callers can simply check truthiness and fall through to other
     * sources.
     */
    resolveDeviceAuthor(): string {
        const host = this.getDeviceHostname();
        if (!host) return "";
        const map = this.settings.deviceAuthors || {};
        const direct = map[host];
        if (direct && direct.trim().length > 0) return direct.trim();
        return "";
    }

    async getCurrentAuthor(): Promise<string> {
        // Priority: runtime override file > deviceAuthors[hostname] > settings.authorName > OS hostname > "unknown".
        // The override file lets an external CLI / agent set the active author
        // without re-opening Obsidian settings. If the override file hasn't
        // been touched within `authorOverrideTimeoutMinutes`, it's treated as
        // stale (agent forgot to clean up) and removed — future saves then
        // fall back to deviceAuthors / settings / hostname, preventing agent
        // names from "poisoning" manual edits made after the agent session
        // ended.
        try {
            const overridePath = this.getAuthorOverridePath();
            if (await this.app.vault.adapter.exists(overridePath)) {
                const timeoutMin = parseInt(this.settings.authorOverrideTimeoutMinutes, 10);
                if (timeoutMin > 0) {
                    const stat = await this.app.vault.adapter.stat(overridePath);
                    const ageMs = stat ? Date.now() - stat.mtime : 0;
                    if (ageMs > timeoutMin * 60 * 1000) {
                        logInfo(`Author override stale (age ${Math.round(ageMs / 60000)}m > ${timeoutMin}m); removing`, overridePath);
                        await this.app.vault.adapter.remove(overridePath);
                        // Fall through to deviceAuthors / settings / hostname.
                    } else {
                        const raw = (await this.app.vault.adapter.read(overridePath)).trim();
                        if (raw.length > 0) return raw;
                    }
                } else {
                    // Timeout disabled — override is permanent until cleared.
                    const raw = (await this.app.vault.adapter.read(overridePath)).trim();
                    if (raw.length > 0) return raw;
                }
            }
        } catch (e) {
            logWarn("Failed reading author override file", e);
        }
        // Vault-shared per-device map wins over the single `authorName`
        // setting because in a multi-device, multi-human vault the per-device
        // mapping is the source of truth — `authorName` only ever applies
        // when nobody added this device to the map.
        const deviceAuthor = this.resolveDeviceAuthor();
        if (deviceAuthor) return deviceAuthor;
        if (this.settings.authorName && this.settings.authorName.trim().length > 0) {
            return this.settings.authorName.trim();
        }
        const host = this.getDeviceHostname();
        if (host) return host;
        return "unknown";
    }

    /**
     * Sort in place
     */
    sortEdits(filenames: string[], descending: boolean = true) {
        const i = descending ? 1 : -1; 
        // Note this cannot do straight alphabetical sort on the base-36 encoded
        // epochs since theoretically strings could be different lengths, convert
        // to epoch before sorting
        // XXX Could do .length plus < checks, though, removing trailing $ when
        //     necessary)
        filenames.sort((a,b) => i * (this.getEditEpoch(b) - this.getEditEpoch(a)));
    }

    commaSeparatedToList(s: string) {
        let list : string[] = [];
        // typescript string.split() returns 1-element array with empty item if
        // s is empty, return empty list instead. Note if s is whitespace still
        // want to return a single element list with a whitespace item.
        if (s != "") {
            list = s.split(",");
            for (let i in list) {
                list[i] = list[i].trim().toLowerCase();
            }
        }
        
        return list;
    }

    parseSettings(settings: EditHistorySettings) {
        // Hook log functions as early as possible so any console output is seen
        // if enabled
        hookLogFunctions(debugLevels.indexOf(settings.debugLevel), "EditHistoryPlugin");

        this.minMsBetweenEdits = parseInt(settings.minSecondsBetweenEdits) * 1000 || Infinity; 
        this.maxEdits = parseInt(settings.maxEdits) || Infinity;
        this.maxEditAgeMs = parseInt(settings.maxEditAge) * 1000 || Infinity;
        // XXX This needs to remove all edit history files when
        //     extensions/substrings are removed/added?
        this.extensionWhitelist = this.commaSeparatedToList(settings.extensionWhitelist)
        this.substringBlacklist = this.commaSeparatedToList(settings.substringBlacklist);
        this.maxEditHistoryFileSize = parseInt(settings.maxHistoryFileSizeKB) * 1024 || Infinity;
        // The storage mode toggle drives the root folder. Mirrored mode stores
        // all .edtz files under a hidden ".edtz" root that mirrors the vault
        // layout (e.g. `.edtz/Business Plan/Draft ideas.md.edtz`). Sibling mode
        // stores each .edtz next to its note (e.g.
        // `Business Plan/Draft ideas.md.edtz`). The underlying path logic is
        // already parametrized by editHistoryRootFolder, so we only set that.
        this.editHistoryRootFolder = settings.useMirroredStorage
            ? MIRRORED_STORAGE_ROOT
            : (settings.editHistoryRootFolder ?? "");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.parseSettings(this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.parseSettings(this.settings);
    }

    async onload() {
        // Load settings as early as possible console output is seen if enabled
        await this.loadSettings();

        // XXX Make this a member variable?
        let dmpobj = new DiffMatchPatch();

        logInfo("onLoad");

        this.registerEvent(this.app.vault.on("modify", async (fileOrFolder: TAbstractFile, force: boolean = false) => {
            logInfo("vault modify", fileOrFolder.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(fileOrFolder))) {
                logDbg("Ignoring non whitelisted file", fileOrFolder.path);
                return;
            }

            if ((this.minMsBetweenEdits == Infinity) && !force) {
                // Don't generate a history file when manual saving is on until
                // it's done manually. This prevents generating empty history
                // files below for files that may never be manually saved
                logDbg("Ignoring due to manual saving enabled")
                return;
            }

            let file = fileOrFolder as TFile;
            let zipFilepath = this.getEditHistoryFilepath(file.path);
            // We used to use vault.getAbstractFileByPath here, but Obsidian's
            // vault tree does not reliably expose files inside dotfile folders
            // (which is exactly where mirrored storage puts them). Switch to
            // the low-level adapter which reads the filesystem directly.
            const zipStat = (await this.app.vault.adapter.exists(zipFilepath))
                ? await this.app.vault.adapter.stat(zipFilepath)
                : null;
            const zipExists = zipStat != null;
            
            // XXX Cleanup all naming:
            //
            //     - revision/edit: each individual file stored inside the zip
            //       file containg a dmp patch in text form (collection of
            //       contextless dmp diffs). Has a unique date and time. The
            //       file stores the diff between this version and the previous
            //       one and has the date at which the current version was
            //       saved. First the whole version is saved verbatim without
            //       diffs, when the next version comes across, then the current
            //       version is diffed against the verbatim version and the
            //       verbatin replaced with that diff
            //
            //     - diff: a version has one or more diffs (or none if the file
            //       was stored verbatim).
            //
            //     - dmp diff: A dmp diff is context-full, it can be traversed.
            //       Each diff has one DiffOp operation (delete, equal, insert)
            //       with one or more lines of payload
            //
            //     - dmp patch: A dmp a patch is context-less, ie a set of diffs
            //       that requires the file in order to be applied. Only has
            //       delete and insert operations, equal has been removed so
            //       they cannot be applied without the original file

            // Ignore changes less than a given time ago unless forcing (ie event
            // was triggered explicitly in order to force saving pending edits)
            // XXX Abstract this and remove the force flag?
            
            // Note this uses the zipFile time and not the entry time (which
            // requires reading the zipFile and has a DOS date 2-second
            // inaccuracy and is local time) or the name to timestamp
            // translation (which is accurate and UTC but requires hitting the
            // zipFile)
            
            // XXX The zipFile date could be cached for later invocations to
            //     early exit above without even decoding the zipfile path? (but
            //     requires a per zipFile cache)
            
            // XXX Still there can be some minor inaccuracy because the zipFile
            //     date is not reset, see
            //     https://github.com/antoniotejada/obsidian-edit-history/issues/15

            // XXX This has the issue that edits that are far apart in time 
            //      could appear merged together:
            //      1) An edit A was done at time T but it was too close to
            //         the previous edit so it's ignored
            //      2) Edit B is done hours later, now edit A and B are
            //         stored as a single edit
            //     This should either 
            //     a) merge the current edit with the previous one as long
            //        as not enough time has passed (inefficient since it will
            //        be doing idle work on every modification) 
            //     b) fire a timer on every modification, and only save from
            //        that timer. Probably delay that timer if already running
            //        so edits are only saved after "n seconds of idle time"
            //        Using a timer also avoids any date checks on the file
            //        This needs to watch out for any race conditions with a
            //        simultaneous change, hopefully none since the file api
            //        should be safe? (and typescript should be single
            //        threaded) but still the file could have been deleted in 
            //        the interim? Note this approach will still merge
            //        unrelated edits when the app is closed before the timer
            //        expires. The timer needs to be per file/editor?
            //     See https://github.com/antoniotejada/obsidian-edit-history/issues/9
            if (!force && zipStat != null &&
                ((file.stat.mtime - zipStat.mtime) < this.minMsBetweenEdits)) {
                logDbg("Need to pass",
                    (this.minMsBetweenEdits - (file.stat.mtime - zipStat.mtime)) / 1000, "s between edits, ignoring");
                return;
            }

            // Ideally, in order to minimize history file size, the history file
            // would store only diffs and then, at modify time:
            // 1. recreate the currently stored version applying the last stored
            //    diff to the pre-modified file
            // 2. compute the diff between the pre-modified file and the
            //    modified file
            // 3. store that diff 
            //
            // Unfortunately there's no way to get the pre-modified version here
            // since when the callback is called, the file has already been
            // modified, so only the modified version is available. The solution
            // is to always store the last modified version in full and then
            // when a new modification is done, replace that version with the
            // diff and store the full version, rinse repeat.
            //
            // Storing the latest version in full in the history file has
            // benefits, though:
            // - The history file can act as a backup even if the main file is
            //   deleted
            // - The history file is still valid even if the original file is
            //   modified from outside Obsidian
            
            // XXX Another option that would likely make the Edit History File
            //     smaller is to do the diffs backwards and store the first
            //     version fully and build diffs on top of that first version.
            //     That would make saving slower, though, since it will have to
            //     rebuild the history from the start on every save, or cache
            //     that the first time. Would also make trimming the history
            //     file slightly harder (needs to rebuild the version that will
            //     now become the first version when older versions are removed
            //     from the file).

            // Load the modified file data
            let fileData = await this.app.vault.read(file);
            // UI edits (you typing in Obsidian) bypass the override file —
            // otherwise an agent that set the override and forgot to clear
            // would hijack your manual saves. External writes (agents
            // modifying .md files directly) never fire editor-change and
            // fall through to the full getCurrentAuthor chain including
            // the override file.
            const currentAuthor = this.isRecentUiEdit(file.path)
                ? this.getUiAuthor()
                : await this.getCurrentAuthor();
            let newFilename = this.buildEditFilename(file.stat.mtime, false, currentAuthor);

            // Create or open the zip with the versions of this file
            let zip: JSZip = new JSZip();
            let zipData: ArrayBuffer | null = zipExists
                ? await this.app.vault.adapter.readBinary(zipFilepath)
                : null;
            let numEdits = 0;
            if (zipData != null) {
                // There's an existing zip file, update the most recent
                // edit in the zip from full to diff wrt the incoming
                // file
                await zip.loadAsync(zipData);
                
                // Read the latest edit which, if it exists, it should
                // be stored in full (vs diffed)
                
                // jszip seems to return newest files first, so arguably it
                // would be enough with getting the first file in the list,
                // but go through all of them and sort for robustness
                let filepaths:string[] = [];
                zip.forEach(function (relativePath:string, file: JSZip.JSZipObject) {
                    filepaths.push(relativePath);
                });

                // Sort most recent first
                this.sortEdits(filepaths);

                // Purge entries, oldest first
                let todayUTC = new Date().getTime();
                let zipFileSize = zipData.byteLength;
                while (filepaths.length > 0) {
                    let purge = false;
                    // Note entries are purged last entry first
                    let filepath = filepaths[filepaths.length-1];
                    // Note there's a new edit incoming, so check max number of
                    // edits for equality too
                    if (filepaths.length >= this.maxEdits) {
                        logInfo("Will purge entry", filepath, "over max count", 
                            filepaths.length, ">", this.maxEdits)
                        purge = true;
                    }
                    let filepathAgeMs = todayUTC - this.getEditEpoch(filepath);
                    if (filepathAgeMs > this.maxEditAgeMs) {
                        logInfo("Will purge entry", filepath, "over max age", 
                            filepathAgeMs * 1000, ">", this.maxEditAgeMs * 1000);
                        purge = true;
                    }
                    if (zipFileSize > this.maxEditHistoryFileSize) {
                        logInfo("Will purge entry", filepath, "over max size", 
                            zipFileSize, ">", this.maxEditHistoryFileSize);
                        // XXX Instead of just purging this could do something
                        //     smarter like merging entries which could also
                        //     decrease the history file size?
                        purge = true;
                        zipFileSize -= this.getEditCompressedSize(zip, filepath);
                    }
                    if (!purge) {
                        // Entries are purged from the end, loop can exit if
                        // this entry is not purged
                        break;
                    }
                    logInfo("Purging entry", filepath);
                    filepaths.pop();
                    zip.remove(filepath);
                }
                numEdits = filepaths.length;
                
                if (filepaths.length > 0) {
                    // Diff the latest stored edit against the incoming file
                    // data, if the zip file is empty just store the incoming
                    // file. If there are no stored edits, continue to store the
                    // incoming one fully

                    // Note it needs to store the incoming file in full and not
                    // the diff because otherwise there's no way to reconstruct
                    // the previous version to diff against (Obsidian calls
                    // "modify" after the file has been written)

                    // XXX Will this ever be used for binary files? Don't do
                    //     diffs on binary files/extensions and always store
                    //     fully? Show some binary diff in the modal? image
                    //     diff?
                    
                    let mostRecentFilename = filepaths[0];
                    let mostRecentFile = zip.file(mostRecentFilename);

                    if (this.getEditEpoch(mostRecentFilename) == this.getEditEpoch(newFilename)) {
                        // Don't allow changes done at the same epoch since it
                        // will get the same filename and overwrite the previous
                        // version, corrupting the history. With the current
                        // epoch granularity this essentially means that changes
                        // have to be at least one second apart, which is almost
                        // always the case unless there's a forced save.
                        // XXX This could just remove the last change and update
                        //     to this one?
                        logInfo("Delaying entry due to colliding epochs");
                        return;
                    }
                    
                    logInfo("unpacking " + mostRecentFilename);
                    let prevFileData = await mostRecentFile.async("string");
                    // @ts-ignore: complains about missing opt_c, but
                    // passing only two arguments is actually allowed by the
                    // diff-match-patch API
                    let diffs = dmpobj.patch_make(fileData, prevFileData.toString());
                    if (diffs.length > 0) {
                        let patch = dmpobj.patch_toText(diffs);

                        // XXX Don't save the version if it has less than a
                        //     given size in bytes? (but it has already done the
                        //     work and the savings because of merging updates
                        //     may not be that big, although at the very least
                        //     it shouldn't save versions where most of it are
                        //     control chars?)
                        
                        // Don't bother replacing with the diffed version if
                        // the diff is larger than the original
                        if (patch.length < prevFileData.length) {
                            // Replace the previous version with a diff wrt the
                            // newest version — carry over its author so we
                            // don't rewrite history by replacing with the
                            // current author.
                            logInfo("Removing ", mostRecentFilename);
                            const prevAuthor = this.getEditAuthor(mostRecentFilename);
                            zip.remove(mostRecentFilename);
                            // Store as a diff
                            mostRecentFilename = this.buildEditFilename(
                                this.getEditEpoch(mostRecentFilename),
                                true,
                                prevAuthor
                            );
                            logInfo("Storing ", mostRecentFilename, " with date ", 
                                mostRecentFile.date, " timestamp ", mostRecentFile.extendedTimestamp);
                            // XXX Investigate why there's no need to undo
                            //     the UTC offset here: 
                            //     - Javascript UTC dates are stored as is
                            //       in the zip object metadata
                            //     - To prevent bad dates 
                            //
                            await zip.file(mostRecentFilename, patch,
                                { date: mostRecentFile.date, compression:"DEFLATE" });
                        }
                    } else {
                        logInfo("No changes detected, ignoring");
                        return;
                    }
                }  
            }

            // Store the newest version in full

            // jszip stores dates in UTC but the zip standard and zip tools
            // expect the date in local times (DOS times). Also, note that
            // dates in zip are only accurate to even seconds because DOS
            // times only use 16 bytes, which can only fit 5 bits for
            // seconds.

            // If we want tools (explorer, total commander...) to display
            // the right date, we could store the local date by providing
            // jszip with the UTC offset undone:
            //     dateWithOffset = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000);
            // But it has limited use since those tools won't show the right
            // date across timezones or DST changes, eg a file in a zip
            // saved before DST with time 10.30 will be displayed with time
            // 9.30 after DST. 

            // see https://github.com/Stuk/jszip/issues/369
            // see https://github.com/Stuk/jszip/blob/master/lib/reader/DataReader.js#L113
            // see https://opensource.apple.com/source/zip/zip-6/unzip/unzip/proginfo/extra.fld
            // see https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
            let dateWithOffset = new Date(file.stat.mtime - new Date().getTimezoneOffset() * 60000);
            logInfo("Storing", newFilename, " with date", dateWithOffset);
            zip.file(newFilename, fileData, { date: dateWithOffset, compression:"DEFLATE" });
            
            // Generate zip archive and save
            let newZipData = await zip.generateAsync({type: "arraybuffer", compression: "DEFLATE"});
            // Write the (possibly-new) zip via the adapter. This handles both
            // create and overwrite, and — critically — it works for files
            // inside dotfile folders where vault.createBinary returns null
            // despite succeeding. ensureParentFolder creates intermediate
            // directories when the mirrored root doesn't exist yet.
            await this.ensureParentFolder(zipFilepath);
            await this.app.vault.adapter.writeBinary(zipFilepath, newZipData);
            // XXX This needs to update when switching panes, etc, or set a timer
            this.statusBarItemEl.setText((numEdits + 1) + " edits");
        }));
        
        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            logInfo("vault rename path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            // Note if a folder is renamed each children will get a call here
            // with the new path
            if ((file instanceof TFolder) && (file.path == this.editHistoryRootFolder)) {
                // The history file root folder is being renamed, update in the
                // settings
                
                // XXX This may not work depending on the renaming of the
                //     history root folder and history files vs. original notes?
                //     But note the history edit file folder is set to "" for
                //     the time being, so this code won't run and this is not an
                //     issue yet
                logInfo("Renaming history folder, updating settings from", 
                    this.settings.editHistoryRootFolder, "to", file.path);
                this.settings.editHistoryRootFolder = file.path;
                this.saveSettings();
            } 

            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }


            // Since Obsidian will move the folder contents when a folder is
            // moved, only move the history file when the note is renamed or
            // moved to a different parent (or if history files are kept in
            // their own directory)
            // Otherwise, moving the edit history file would cause Obsidian to
            // throw a benign error when it tries to move the edit history file
            // and finds it's not there anymore.
            const oldFiledirs = oldPath.split("/");
            const oldFilename = oldFiledirs.pop();
            const oldParentFolder = (oldFiledirs.length > 0) ? oldFiledirs.pop() : "";
            const filedirs = file.path.split("/");
            const filename = filedirs.pop();
            const parentFolder = (filedirs.length > 0) ? filedirs.pop() : "";
            if ((this.settings.editHistoryRootFolder == "") && 
                ((oldParentFolder == parentFolder) && (oldFilename == filename))) {
                logDbg("Not moving edit history, expected to be moved later alongside parent folder");
                return;
            }

            // Rename the edit history file if any (adapter-based so it works
            // regardless of whether the .edtz is inside a dotfile folder).
            void this.renameEditHistory(oldPath, file.path).catch(e => {
                logWarn("Failed to rename edit history file", oldPath, "->", file.path, e);
            });
        }));

        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            logInfo("vault delete path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }
            // Delete the edit history file if any (adapter-based so it works
            // regardless of whether the .edtz is inside a dotfile folder).
            const zipFilepath = this.getEditHistoryFilepath(file.path);
            void this.deleteEditHistory(file.path).catch(e => {
                logWarn("Failed to delete edit history file", zipFilepath, e);
            });
        }));

        // XXX Use notices for some information/error messages

        // The ribbon can be disabled from Obsidian UI, no need to check for a
        // specific disable here
        const ribbonIconEl = this.addRibbonIcon("clock", "Open edit history", (evt: MouseEvent) => {
            if (this.keepEditHistoryForActiveFile()) {
                new EditHistoryModal(this).open();
            }
        });

        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText("? edits");
        // Add the highlight on hover of other status bar items
        statusBarItemEl.addClass("mod-clickable");
        this.statusBarItemEl = statusBarItemEl;
        const plugin = this;
        statusBarItemEl.onclick = function () {
            if (plugin.keepEditHistoryForActiveFile()) {
                new EditHistoryModal(plugin).open();
            }
        }; 
        
        this.statusBarItemEl.toggle(this.settings.showOnStatusBar);
        
        this.addCommand({
            id: "open-edit-history",
            name: "Open edit history for this file",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        new EditHistoryModal(this).open();
                    }
                    return true;
                } 
                return false;
            }
        });

        this.addCommand({
            id: "save-edit-history",
            name: "Save current edit in the edit history",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        logInfo("Forcing storing edit");
                        this.app.vault.trigger("modify", this.app.workspace.getActiveFile(), true);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: "set-active-author",
            name: "Set active author (overrides setting for new edits)",
            callback: async () => {
                const current = await this.getCurrentAuthor();
                new AuthorPromptModal(this, current, async (value) => {
                    const overridePath = normalizePath(
                        `${this.app.vault.configDir}/plugins/${this.manifest.id}/${AUTHOR_OVERRIDE_FILE}`
                    );
                    const trimmed = value.trim();
                    if (trimmed.length === 0) {
                        if (await this.app.vault.adapter.exists(overridePath)) {
                            await this.app.vault.adapter.remove(overridePath);
                        }
                        new Notice("Edit History: active author cleared (using fallback)");
                    } else {
                        await this.app.vault.adapter.write(overridePath, trimmed);
                        new Notice(`Edit History: active author set to "${trimmed}"`);
                    }
                }).open();
            }
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!(file instanceof TFile)) return;
                if (!this.keepEditHistoryForFile(file)) return;
                menu.addItem((item) => {
                    item
                        .setTitle("Show edit history")
                        .setIcon("clock")
                        .onClick(async () => {
                            const leaf = this.app.workspace.getLeaf(false);
                            await leaf.openFile(file);
                            new EditHistoryModal(this).open();
                        });
                });
            })
        );

        // Decorate the file explorer: hide *.edtz rows, mark files that have a
        // matching history with a small clock badge. The "has history" check
        // uses a pre-built Set of note paths rather than per-item
        // vault.getAbstractFileByPath(), because in mirrored storage mode the
        // .edtz files live under a dotfile folder (`.edtz/`) that Obsidian's
        // vault tree may not expose.
        const runRefresh = () => { void this.refreshFileExplorer(); };
        this.app.workspace.onLayoutReady(runRefresh);
        this.registerEvent(this.app.workspace.on("layout-change", runRefresh));
        this.registerEvent(this.app.workspace.on("active-leaf-change", runRefresh));
        this.registerEvent(this.app.vault.on("create", runRefresh));
        this.registerEvent(this.app.vault.on("delete", runRefresh));
        this.registerEvent(this.app.vault.on("rename", runRefresh));

        // Mark "a human just typed here" so the modify handler below can
        // distinguish UI saves from external-agent writes. editor-change
        // only fires for edits made through Obsidian's editor — external
        // file writes go straight through the vault modify event without
        // firing this one.
        this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
            const file = (info as { file?: TFile | null } | undefined)?.file;
            if (file) this.lastUiEditByPath.set(file.path, Date.now());
        }));

        // "Changes since your last visit" blame overlay in the editor.
        this.registerEditorExtension([blameField]);
        this.registerEvent(this.app.workspace.on("file-open", (file) => {
            if (file) this.applyBlameToFile(file);
        }));
        this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
            // When the user leaves a MarkdownView, bump its lastViewed bookmark
            // so that next time they open it, blame reflects changes made
            // while they were away. We do this here (on leave) rather than on
            // open so the user still sees highlights during the session.
            if (!leaf) return;
            const prev = this.lastActiveFilePath;
            const currentFile = (leaf.view instanceof MarkdownView) ? leaf.view.file?.path : undefined;
            if (prev && prev !== currentFile) {
                setLastViewed(prev, Date.now());
            }
            this.lastActiveFilePath = currentFile ?? null;
        }));

        this.addCommand({
            id: "mark-file-as-read",
            name: "Mark current file as read (clear change highlights)",
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view?.file) return false;
                if (!checking) {
                    setLastViewed(view.file.path, Date.now());
                    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
                    cm?.dispatch({ effects: clearAllBlameEffect.of(null) });
                    new Notice("Edit History: change highlights cleared");
                }
                return true;
            }
        });


        this.addSettingTab(new EditHistorySettingTab(this.app, this));
    }

    lastActiveFilePath: string | null = null;

    // Timestamp (ms) of the most recent editor-change event per file path.
    // Used to distinguish saves triggered by the Obsidian UI (you typing)
    // from saves triggered by external writes (an AI agent rewriting the
    // .md file directly). External writes never fire editor-change, so a
    // save without a recent UI timestamp is attributed via the override
    // file chain; a save WITH a recent UI timestamp is attributed via the
    // setting directly, skipping the override so agents can't hijack your
    // manual typing when they forgot to clear their override.
    lastUiEditByPath: Map<string, number> = new Map();
    static UI_EDIT_WINDOW_MS = 5000;

    isRecentUiEdit(filePath: string): boolean {
        const ts = this.lastUiEditByPath.get(filePath);
        if (!ts) return false;
        return (Date.now() - ts) < EditHistory.UI_EDIT_WINDOW_MS;
    }

    /**
     * Resolve the author to tag on a UI edit. Skips the override file on
     * purpose — overrides are for external processes. Priority:
     *   deviceAuthors[hostname] > settings.authorName > hostname > "unknown".
     */
    getUiAuthor(): string {
        const deviceAuthor = this.resolveDeviceAuthor();
        if (deviceAuthor) return deviceAuthor;
        if (this.settings.authorName && this.settings.authorName.trim().length > 0) {
            return this.settings.authorName.trim();
        }
        const host = this.getDeviceHostname();
        if (host) return host;
        return "unknown";
    }

    /**
     * For each line in `file`'s current content, attribute it to the author
     * of the most recent edit (newer than lastViewed) that introduced a line
     * with matching text. Blank/very short lines are filtered out.
     *
     * MVP blame: matches by line TEXT, not by tracking positions through
     * patches. Limitation: if two different edits added identical lines, the
     * more recent author wins. Good enough for markdown notes where duplicate
     * non-trivial lines are rare.
     */
    async computeBlameForFile(file: TFile): Promise<BlameLineSpec[]> {
        if (!this.keepEditHistoryForFile(file)) return [];

        const lastViewed = getLastViewed(file.path);
        if (lastViewed === null) {
            // First time we've seen this file on this device — establish the
            // baseline and show no highlights. Subsequent visits will show
            // changes made after this moment.
            setLastViewed(file.path, Date.now());
            return [];
        }

        const zipData = await this.readEditHistoryBinary(file.path);
        if (!zipData) return [];

        const zip = new JSZip();
        await zip.loadAsync(zipData);
        const filepaths: string[] = [];
        zip.forEach((rel: string) => filepaths.push(rel));
        if (filepaths.length === 0) return [];
        this.sortEdits(filepaths);

        const dmp = new DiffMatchPatch();

        // Reconstruct historical states newest-first. states[i] = file content
        // after the edit at filepaths[i] (i.e., the content that user saved).
        let data = await this.app.vault.read(file);
        const states: string[] = [];
        for (const fp of filepaths) {
            const raw = await zip.file(fp).async("string");
            if (this.getEditIsDiff(fp)) {
                const patches = dmp.patch_fromText(raw);
                data = dmp.patch_apply(patches, data)[0];
            } else {
                data = raw;
            }
            states.push(data);
        }

        // Collect (added line text → most recent author) across edits whose
        // epoch is after lastViewed. Skip edits authored by the current user
        // since highlighting your own changes is noise.
        const currentAuthor = await this.getCurrentAuthor();
        const addedLines = new Map<string, { author: string; epoch: number }>();
        for (let i = 0; i < filepaths.length; i++) {
            const fp = filepaths[i];
            const epoch = this.getEditEpoch(fp);
            if (epoch <= lastViewed) break;  // edits are sorted newest-first
            const author = this.getEditAuthor(fp) ?? "unknown";
            if (author === currentAuthor) continue;

            const newer = states[i];
            const older = (i + 1 < states.length) ? states[i + 1] : "";
            // Line-mode diff keeps memory bounded for large files and is
            // exactly what we want for per-line blame.
            const lineDiff = (dmp as any).diff_linesToChars_(older, newer);
            const charDiffs = dmp.diff_main(lineDiff.chars1, lineDiff.chars2, false);
            (dmp as any).diff_charsToLines_(charDiffs, lineDiff.lineArray);

            for (const [op, segment] of charDiffs) {
                if ((op as number) !== DiffOp.Insert) continue;
                for (const line of segment.split("\n")) {
                    if (line.trim().length < BLAME_MIN_LINE_LEN) continue;
                    const existing = addedLines.get(line);
                    if (!existing || existing.epoch < epoch) {
                        addedLines.set(line, { author, epoch });
                    }
                }
            }
        }

        if (addedLines.size === 0) return [];

        const currentContent = await this.app.vault.read(file);
        const currentLines = currentContent.split("\n");
        const blame: BlameLineSpec[] = [];
        for (let i = 0; i < currentLines.length; i++) {
            const line = currentLines[i];
            if (line.trim().length < BLAME_MIN_LINE_LEN) continue;
            const match = addedLines.get(line);
            if (!match) continue;
            blame.push({
                line: i + 1,
                author: match.author,
                color: getAuthorColor(match.author)
            });
        }
        return blame;
    }

    async applyBlameToFile(file: TFile): Promise<void> {
        let specs: BlameLineSpec[];
        try {
            specs = await this.computeBlameForFile(file);
        } catch (e) {
            logWarn("Failed to compute blame", e);
            specs = [];
        }
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof MarkdownView)) return;
            if (leaf.view.file?.path !== file.path) return;
            const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
            if (!cm) return;
            if (!cm.state.field(blameField, false)) {
                // The editor extension isn't active on this view yet (this
                // happens for already-open leaves when the plugin just
                // loaded). Skip; next file-open will catch it.
                return;
            }
            const decorations = buildBlameDecorations(cm, specs);
            cm.dispatch({ effects: replaceBlameDecorationsEffect.of(decorations) });
        });
    }

    onunload() {
        logInfo("unload");
    }
}

class AuthorPromptModal extends Modal {
    plugin: EditHistory;
    initialValue: string;
    onSubmit: (value: string) => void | Promise<void>;

    constructor(plugin: EditHistory, initialValue: string, onSubmit: (value: string) => void | Promise<void>) {
        super(plugin.app);
        this.plugin = plugin;
        this.initialValue = initialValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText("Set active author");
        contentEl.createEl("p", {
            text: "Name tagged onto new edits until cleared. Empty input falls back to the setting / device hostname."
        });

        const input = contentEl.createEl("input", { type: "text" });
        input.value = this.initialValue;
        input.style.width = "100%";
        input.style.marginBottom = "1em";
        input.focus();
        input.select();

        const submit = async () => {
            const value = input.value;
            this.close();
            await this.onSubmit(value);
        };

        input.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter") {
                evt.preventDefault();
                submit();
            }
        });

        const buttons = contentEl.createDiv({ cls: "modal-button-container" });
        const saveBtn = buttons.createEl("button", { text: "Save" });
        saveBtn.addClass("mod-cta");
        saveBtn.addEventListener("click", submit);
        const clearBtn = buttons.createEl("button", { text: "Clear" });
        clearBtn.addEventListener("click", async () => {
            input.value = "";
            await submit();
        });
        const cancelBtn = buttons.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class EditHistoryModal extends Modal {
    plugin: EditHistory;
    currentVersionData: string;
    curDiffIndex: number;
    diffElements: NodeListOf<HTMLElement>;
    // Dedicated Component for MarkdownRenderer's lifecycle (event listeners
    // attached by rendered links/embeds need somewhere to register so they can
    // be cleaned up when the modal closes).
    renderComponent: Component;

    constructor(plugin: EditHistory) {
        super(plugin.app);
        this.plugin = plugin;
        this.renderComponent = new Component();
    }

    renderCalendar(calendarDiv: HTMLElement, select: DropdownComponent, zipFileSize: number, zip: JSZip, filepaths: string[]) {
        // XXX Abstract this more? problems are revstats requiring the zip file
        //     or recalculate values outside. select should also be removed and
        //     take a cell onclick callback or do the cell onclick in the caller?

        // Display the list of changes for the currently selected year as a
        // table with one color-coded cell per day of the year, similar to
        // github commit activity: one cell per day, one row per day of the
        // week, one column per week, multiple columns per month.

        const selectedEdit = select.getValue();
        const year = this.plugin.getEditDate(selectedEdit).getFullYear();
        
        let calendarHtml = '<table class="calendar">';
        let fileTimeToEditCount = new Map<number, number>();
        let fileSize = 0;
        let numFiles = 0;

        // Collect the times of all edits in the given year, note it's possible
        // filepaths is empty when the file hasn't been saved yet. 
        // XXX Ideally this should also add the current time if note contents
        //     different from last stored, but this needs the cell clicking code
        //     to be able to respond to that date. Eventually this function
        //     should just take a list of days and shades, or the shade and
        //     clicking done in the caller after calendar building? 
        for (let fp of filepaths) {
            // XXX filepaths are sorted by decreasing date, could binary search
            //     to the selected year, probably overkill?
            let d = this.plugin.getEditDate(fp);
            if (d.getFullYear() == year) {
                const t = this.plugin.getEditFileTime(fp);
                const count = fileTimeToEditCount.get(t) || 0;
                fileTimeToEditCount.set(t, count + 1);
                fileSize += this.plugin.getEditCompressedSize(zip, fp);
                numFiles++;
            } else if (d.getFullYear() < year) {
                // filepaths are sorted newest first, exit when switching
                // to a previous year
                break;
            }
        }
        // Shade the days looking at how many edits there were for the given day
        // Note this doesn't count diffs inside an edit, but edits in a day,
        // since counting diffs would require uncompressing and parsing all
        // edits in the day, which is expensive
        const editCounts = Array.from(fileTimeToEditCount.values());
        const maxFileEditCount = Math.max(...editCounts);
        const minFileEditCount = Math.min(...editCounts);
        const editCountRange = maxFileEditCount - minFileEditCount;
        const maxShade = 5; // From 0 to maxShade shade levels
        const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
        const firstDayOfYear = new Date(year, 0, 1);
        const startDate = new Date(year, 0, 1 - firstDayOfYear.getDay());
        // one row per day of the week
        const numRows = 7;
        // Check if the last day of February is 29 by setting the day of the
        // March (0-based) to 0, which typescript adjusts to the last day of the
        // previous month
        const leapDelta =  new Date(year, 2, 0).getDate() - 28;
        // need to show at least 365 days plus padding for previous year
        // plus leap
        const numCols = Math.round((365 + firstDayOfYear.getDay() + leapDelta) / numRows);
        
        let month = 0;
        let monthColStart = 0;
        calendarHtml += `<thead><tr><th>${year}</th>`;
        
        // Generate the HTML for the month column headers, each month is a
        // variable number of columns depending on the day of the week the first
        // day of the month falls in and the length of the month in days
        
        // set d at the bottom row, will indicate when the current column spills
        // to the next month and a new column header is needed
        let d = new Date(startDate);
        d.setDate(d.getDate() + 6);
        for (let col = 0; col < numCols; ++col) {
            // Spill the previous month if this column ends in a new month, this
            // is done after the fact since that's when colspan is known, so it
            // also needs to spill if the last column
            if ((month != d.getMonth()) || (col == numCols - 1)) {
                const dd = new Date(d.getFullYear(), month, 1);
                calendarHtml += `<th colspan="${(col - monthColStart)}">${dd.toLocaleDateString(undefined, { month: 'short' })}</th>`;
                monthColStart = col;
                month = d.getMonth();
            }
            d.setDate(d.getDate() + 7);
        }
        calendarHtml += "</tr></thead><tbody>";

        // Generate HTML for the day cells, one cell per day, one day of the
        // week per row, one week per column
        for (let row = 0; row < numRows; ++row) {
            let d =  new Date(startDate);
            // It's okay to overflow days in setDate, Typescript does carry over
            d.setDate(d.getDate() + row);
            calendarHtml += `<tr><th>${d.toLocaleDateString(undefined, { weekday: 'short' })}</th>`;
            for (let col = 0; col < numCols; ++col) {
                const t = d.getTime();
                const count = fileTimeToEditCount.get(t) || 0;
                // Note month is 0-based
                let styleClass = "calendar-empty-"  +  ((d.getMonth() & 1) ? "odd" : "even");
                let tooltip = d.toLocaleDateString();
                if (d.getFullYear() != year) {
                    // Note count is zero in this case, since only times in the
                    // current year are counted
                    styleClass = "calendar-black";
                } else if (count > 0) {
                    const shadeLevel = (editCountRange == 0) ? maxShade : Math.round(((count-minFileEditCount) * maxShade) / editCountRange);
                    if (t == selectedFileTime) {
                        styleClass = "calendar-selected ";
                    } else {
                        styleClass = "calendar-level ";
                    }
                    styleClass += "clickable level-" + shadeLevel;
                    tooltip += ` (${count} edits)`;
                } 
                calendarHtml += `<td id="calendar-${t}" class="${styleClass}" title="${tooltip}"></td>`;
                d.setDate(d.getDate()+7);
            }
            calendarHtml += "</tr>";
        }
        calendarHtml += "</tbody></table>";
        calendarDiv.innerHTML = calendarHtml;
        const calendarTable = calendarDiv.querySelector("table") as HTMLElement;
        // Hook on cell click to change the cell selection and the drop down (on
        // unselected but also on selected cells, since cell selection can be
        // toggled without regenerating the whole calendar)
        const cells = calendarTable.querySelectorAll('td.calendar-level, td.calendar-selected');
        cells.forEach(cell => {
            // Set the onclick handler
            cell.addEventListener('click', () => {
                // Select the first date that matches in the drop down (since
                // this is a date without time, there can be multiple matching
                // diffs in the same day). No need to toggle the cell selection
                // itself since the dropdown change handler takes care of that
                logDbg('Cell clicked:', cell);
                const cellFileTime = parseInt(cell.id.slice(cell.id.indexOf("-")+1));
                // XXX store data-filetime in the option and do this search with
                //     queryselector?
                //     document.querySelector(`[data-filetime="${cellFileTime}"]`);
                const selectEl = select.selectEl;
                const options = selectEl.options;
                for (let i = 0; i < options.length; i++) {
                    let d = this.plugin.getEditDate(options[i].value);
                    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    const optionFileTime = d.getTime();
                    if (optionFileTime == cellFileTime) {
                        if (i != selectEl.selectedIndex) {
                            selectEl.selectedIndex = i;
                            selectEl.trigger("change");
                        }
                        break;
                    }
                }
            });
        });
        let revStats = calendarDiv.createEl("small");
        // Fill in the stats now that all the information is available
        // XXX Use human friendly units (KB, MB, GB, etc)
        revStats.setText(
            `${numFiles}/${filepaths.length} edit${(filepaths.length > 1) ? "s " : " "}` +
            `${fileSize}/${zipFileSize} bytes compressed, ${this.app.workspace.getActiveFile()?.stat.size} note bytes`
        );
    }

    async renderDiffsTimeline(zip: JSZip, dmpobj: DiffMatchPatch, filepaths: string[], selectedEdit: string, latestData: string, showWhitespace: boolean): Promise<string> {
        
        let annots : string[] = [];
        let lineToRefLine : number[] = [];
        let lines : string[] = [];
        let annotate = false;
        let remainingAnnots = 0;
        let data = latestData;
        let newerData = latestData;
        let prevFileDateStr = "";
        
        let notice = null;

        let nextReportPct = 0;
        const reportIntervalPct = 5;
        const startTime = Date.now();
        for (const [ifp, filepath] of filepaths.entries()) {
            // Timeline can take a long time with lots of edits, report, but
            // only every few iterations to avoid unnecessary overhead
            // XXX Find a way to allow cancel?
            // XXX Decrease execution time by doing coarse timeline that only
            //     shows per day diffs? (merge all edits done the same day,
            //     rebuilding the diff in a single call and pointing the click
            //     to the first or last edit of that day)
            const pct = Math.round((100*ifp)/filepaths.length);
            if (pct >= nextReportPct) {
                if (nextReportPct == reportIntervalPct) {
                    // On the first progress report, check if the estimate of
                    // the whole work will be over a given threshold (this
                    // prevents the notice quickly flashing with files with few
                    // edits) and report if so
                    const currentTime = Date.now();
                    if (((currentTime - startTime) * 100 / nextReportPct) > 1000) {
                        // Create a notice to report progress, set duration to
                        // zero to prevent the notice from disappearing while
                        // still working, hide explicitly below when done.
                        notice = new Notice("", 0);
                    }
                }
                // Note this may not reach 100% if the loop early exists below,
                // but it's very unlikely
                notice?.setMessage(`Computing timeline ${pct}%`);
                nextReportPct += reportIntervalPct;
            }
            // Loop over filepaths,
            // - first rebuilding the file contents for the selectedEdit
            // - once found, keep rebuilding versions and also store the time
            //   annotation for each line (ie time of the edit that most
            //   recently modified that line)
            const diff = await zip.file(filepath).async("string");
            newerData = data;
            if (this.plugin.getEditIsDiff(filepath)) {
                // Rebuild the data from the diff applied to the current data
                const patch = dmpobj.patch_fromText(diff);
                data = dmpobj.patch_apply(patch, data)[0];
            } else {
                // The full file was stored, there's no diff
                data = diff;
            }
            if (!annotate && (selectedEdit == filepath)) {
                // Note split returns 2 for a string with a single \n, no need
                // to +1
                lines = data.split("\n");
                const numLines = lines.length;
                annots = new Array(numLines).fill("");
                // lineToRefLine[i] : for line i of the current data, what is
                // the line of the reference filepath. Could be -1 if the
                // reference filepath doesn't contain that line and could have
                // less than the reference lines if the current filepath doesn't
                // contain that line
                lineToRefLine = Array.from({ length: numLines + 1 }, (_, i) => i);
                annotate = true;
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);  
                remainingAnnots = annots.length;
            } else if (annotate) {
                // Get the diff to go from the newer version to the older
                // version (backwards diff), so newer lines appear as deletions
                // and viceversa (this allows to replace the line diff with with
                // the stored diffs in the future, which also store a backwards
                // diff)
                // Use linemode since we are interested in full line changes,
                // but note that line diffs still include carriage returns
                // inside so they need to be looped over below
                // XXX This should use the patch and not recreate the diff, but
                //     patches are contextless and require tracking how lines
                //     are inserted or deleted as if the patch were applied
                const diffs = dmpobj.diff_lineMode(newerData, data);
                let line = 0;
                for (const [op, diffData] of diffs) {
                    // Counting diffs and diff_linemode above are by far the
                    // hotspots of this function (eg 280ms and 170ms each).
                    // For counting lines .split().length is 270ms vs.
                    // .match().length 346ms
                    const numLines = diffData.split("\n").length-1;
                    for (let i=0; i < numLines; ++i) {
                        const refLine = lineToRefLine[line];
                        switch (op as number) {
                            case DiffOp.Delete:
                                // If the old file doesn't have this line, it
                                // means the new file inserted the line, annotate
                                // as such unless it's already annotated
                                lineToRefLine.splice(line, 1);
                                if ((refLine != -1) && (annots[refLine] == "")) {
                                    annots[refLine] = prevFileDateStr;
                                    remainingAnnots--;
                                }
                            break;
                            case DiffOp.Insert:
                                // The new file doesn't have this line, it means
                                // the new file deleted it, nothing to annotate,
                                // but tag this line as not present 
                                lineToRefLine.splice(line, 0, -1);
                                line++;
                            break;
                            case DiffOp.Equal:
                                line++;
                            break;
                        }
                        // Early exit if all the lines have annotations. This is
                        // unlikely to hit unless at some point the whole file
                        // was rewritten
                        if (remainingAnnots == 0) {
                            break;
                        }
                    }
                    if (remainingAnnots == 0) {
                        break;
                    }
                }
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);
            }
        }

        // Generate a table with the annotated file, time annotations on the
        // left column and text lines on the right
        let diffHtml: string = "<table>";
        const fileDateStr = this.plugin.getEditLocalDateStr(selectedEdit);
        for (let i=0; i < lines.length; ++i) {
            const hdata1 = htmlEncode(annots[i], false);
            const hdata2 = htmlEncode(lines[i], showWhitespace);

            if (annots[i] == fileDateStr) {
                // If the annotation date is the selectedEdit, tag as diff-line
                // so it gets highlighted and can be navigated and counted as
                // diff for stats display (but can only tag insertions,
                // deletions are missing by definition of the timeline view)
                
                // XXX This causes the scroll to move when navigating by
                //     clicking the time because the first diff-line is focused
                //     when the select changes, which may undesirable since the
                //     clicked time line may be scrolled out, fix?
                diffHtml += `<tr class="diff-line"><td class="clickable diff-time">${hdata1}</td><td class="mod-right">${hdata2}</td></tr>`;
            } else {
                diffHtml += `<tr><td class="clickable diff-time ${(annots[i] == fileDateStr) ? "diff-line" : ""}">${hdata1}</td><td>${hdata2}</td></tr>`;
            }
        }
        diffHtml += "</table>";

        notice?.hide();

        return diffHtml;
    }

    renderDiffsInline(diffs: Diff[], showWhitespace: boolean): string {
        let diffHtml = "";
        // This is equivalent to diff_prettyHtml, but that one inserts
        // hard-coded background colors, use styles instead. See
        // https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
        for (const [op, data] of diffs) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            if (data == "") {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            switch (op as number) {
                case  DiffOp.Delete:
                    diffHtml += `<del class="diff-line mod-left">${hdata}</del>`;
                break;
                case DiffOp.Insert: 
                    diffHtml += `<ins class="diff-line mod-right">${hdata}</ins>`;
                break;
                case DiffOp.Equal:
                    diffHtml += `<span>${hdata}</span>`;
                break;
            }
        }
        return diffHtml;
    }

    renderDiffsSideOrTop(diffs: Diff[], sideBySide: boolean, showWhitespace: boolean): string {
        // Group the diffs by carriage-terminated blocks of lines,
        // display them in a table side by side or top by bottom

        // For every diff, 
        // - if it's an equal diff
        //   - Append the first line to the current right and left
        //     blocks, flush the blocks
        //   - Initialize left and right to the last line
        //   - Flush any in between lines as non-diff right and left
        //     blocks
        // - if it's a delete diff, accumulate into the left block
        // - if it's an insertion diff, accumulate into right block and
        //   flush if it ends in carriage return
        
        let left = "";
        let right = "";
        let diffHtml = '<table width="100%"><tbody>';
        // Append a dummy terminator to detect the loop end and flush
        for (const [op, data] of [...diffs, [DiffOp.Equal as number, ""] as Diff]) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            // (don't remove empty Equal since it's used loop as
            // terminator below)
            if ((data == "") && ((op as number) != DiffOp.Equal)) {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            // XXX Hack to guarantee a flush at the end, do it elsewhere
            //     since it will add an spurious (but invisible in html)
            //     carriage return
            if (hdata == "") {
                hdata = "\n";
            }
            switch (op as number) {
                case DiffOp.Delete:
                    left += `<del>${hdata}</del>`;
                    // Don't flush even if it ends in a carriage return,
                    // the right side is the one that tracks returns.
                    // This will pair the deletion to the next insertion
                    // or equal block (empirically looks like deletions
                    // always appear before insertions, so this seems to
                    // work fine).
                    
                    // XXX This could also assign deletions to the wrong
                    //     block, but it's not deterministic what the
                    //     proper block is anyway.
                break;
                case DiffOp.Insert:
                    right += `<ins>${hdata}</ins>`;
                    // Flush left and right if right ends in carriage
                    // return, otherwise wait for a carriage return
                    // either in an Insert or in an Equal diff. No need
                    // to flush each line individually since it's
                    // desirable to group the whole insertion in the
                    // same block
                    if (hdata.endsWith("\n")) {
                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td class="mod-left">${left}</td><td class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                break;
                case DiffOp.Equal:
                    let i;
                    // Flush any pending left & right blocks upto the
                    // first carriage return in the equal data,
                    // inclusive
                    i = hdata.indexOf("\n");
                    if ((i != -1) && ((left != "") || (right != ""))) {
                        let end = hdata.slice(0, i+1);
                        left += end;
                        right += end;
                        hdata = hdata.slice(i+1);

                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td width="50%" class="mod-left">${left}</td><td width="50%" class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</div></td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                    // Flush all the equal data upto the last carriage
                    // return, inclusive
                    i = hdata.lastIndexOf("\n");
                    if (i != -1) {
                        let start = hdata.slice(0, i+1);
                        if (sideBySide) {
                            diffHtml += `<tr><td>${start}</td><td>${start}</td></tr>`;
                        } else {
                            diffHtml += `<tr><td>${start}</td></tr>`;
                        }
                        hdata = hdata.slice(i+1);
                    }
                    // Append to left and right the equal data from the
                    // last carriage return, exclusive 
                    right += hdata;
                    left += hdata;
                break;
            }
        }
        diffHtml += "</tbody></table>";
        
        return diffHtml;
    }

    async onOpen() {
        const file = this.app.workspace.getActiveFile();

        this.titleEl.setText("Edits for ");
        this.titleEl.createEl("i", { text: file?.name });
        this.titleEl.createEl("span", { text: " " });

        const calendarIcon = this.titleEl.createEl("span")
        // XXX This icon is not visible on mobile on some older versions,
        //     find out which version and increase the required version?
        setIcon(calendarIcon, "calendar-plus-2");
        
        this.modalEl.addClass("edit-history-modal");

        const {contentEl} = this;        
        contentEl.addClass("edit-history-modal-content");

        if ((file == null) || (!this.plugin.keepEditHistoryForFile(file))) {
            // XXX This should never happen since callers don't fire the modal?
            logWarn("Edit history not allowed for active file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        // Note this may differ from the last edit stored in the zip since not
        // all edits are stored in the file depending on the value of
        // this.minMsBetweenEdits
        const latestData = await this.app.vault.read(file);
    
        // Create or open the zip with the edit history of this file.
        // Uses the adapter, not vault.getAbstractFileByPath, because
        // mirrored storage puts .edtz inside `.edtz/` which Obsidian's
        // vault tree does not reliably expose.
        // XXX Review perf notes at https://stuk.github.io/jszip/documentation/limitations.html
        const zip: JSZip = new JSZip();
        const zipFilepath = this.plugin.getEditHistoryFilepath(file.path);
        logInfo("Opening zip file ", zipFilepath);
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(zipFilepath))) {
            logWarn("No history file", zipFilepath);
            contentEl.createEl("p", { text: "No edit history file"});
            return;
        }
        const zipStat = await adapter.stat(zipFilepath);
        const zipFileSize = zipStat?.size ?? 0;
        const zipData = await adapter.readBinary(zipFilepath);
        if (zipData == null) {
            logWarn("Unable to read history file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        await zip.loadAsync(zipData);

        const filepaths:string[] = [];
        zip.forEach(function (relativePath:string) {
            filepaths.push(relativePath);
        });
        if (filepaths.length == 0) {
            logWarn("Empty edit history file");
            contentEl.createEl("p", { text: "Empty edit history"});
            return;
        }
        // Sort most recent first (although probably unnecessary since the zip
        // seems to list in creation order already)
        this.plugin.sortEdits(filepaths);

        const dmpobj = new DiffMatchPatch();
        
        // XXX Allow searching in the diff text rendering

        const calendarDiv = contentEl.createDiv();
        // The calendar is too tall for mobile, allow collapsing/expanding
        calendarIcon.addEventListener('click', () => {
            if (calendarDiv.style.display === "none") {
                calendarDiv.style.display = "block";
                setIcon(calendarIcon, "calendar-minus-2");
            } else {
                calendarDiv.style.display = "none";
                setIcon(calendarIcon, "calendar-plus-2");
            }
        });

        // OneNote-style two-column layout: left rail of versions, right column
        // with controls + content. The <select> stays wired up (hidden) so the
        // existing keyboard navigation (Ctrl+Shift+ArrowUp/Down, etc.) keeps
        // working without being rewritten around the list.
        const bodyDiv = contentEl.createDiv("edit-history-body");
        const versionListDiv = bodyDiv.createDiv("edit-history-version-list");
        const rightCol = bodyDiv.createDiv("edit-history-right-col");

        const control = rightCol.createDiv("setting-item-control");
        control.style.justifyContent = "flex-start";
        const select = new DropdownComponent(control);
        select.selectEl.addClass("edit-history-hidden-select");

        const diffDisplaySelect = new DropdownComponent(control)
            .addOptions(diffDisplayFormatToString)
            .setValue(this.plugin.settings.diffDisplayFormat)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        const diffInfo: HTMLElement = control.createEl("span");

        // XXX With the new buttons, this is too tall and too wide on mobile,
        //     reorganize/resize/downscale font?
        const copyButton = new ButtonComponent(control)
            .setButtonText("Copy")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Copied to clipboard");
                navigator.clipboard.writeText(this.currentVersionData);
            });

        const prevButton = new ButtonComponent(control)
            .setButtonText("Previous")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Prev diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on start instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + this.diffElements.length - 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        const nextButton = new ButtonComponent(control)
            .setButtonText("Next")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Next diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on end instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        control.createEl("span").setText("Whitespace");
        const whitespaceCheckbox = new ToggleComponent(control) 
            .setValue(this.plugin.settings.showWhitespace)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        // Set tabindex to 0 so it can receive key events
        contentEl.setAttr("tabindex", 0);
        contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
            // Hook on ctrl+arrow up/down and p/n for prev/next diff (don't use
            // alt+up/down since it's used to unfold dropdowns)
            logDbg("key", event);
            const navigateDiff = event.ctrlKey && !event.shiftKey;
            const navigateDate = event.ctrlKey && event.shiftKey;
            if ((event.key === "p") || (navigateDiff && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                prevButton.buttonEl.trigger("click");
            } else if ((event.key === "P") || (navigateDate && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex - 1;
                if (nextIndex >= 0) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "n")  || (navigateDiff && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                nextButton.buttonEl.trigger("click");
            } else if ((event.key === "N") || (navigateDate && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex + 1;
                if (nextIndex < select.selectEl.options.length) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "c") && event.ctrlKey) {
                event.preventDefault();
                copyButton.buttonEl.trigger("click");
            }
        });
        
        // Change summary banner sits above the diff/page pane and shows how
        // many lines were added/removed vs. the previous version (OneNote-ish
        // "something changed here" affordance without requiring per-line
        // highlights in the rendered page).
        const changeSummaryDiv = rightCol.createDiv("edit-history-change-summary");
        const diffDiv = rightCol.createDiv("diff-div");
        let selectedDayCell : HTMLElement|null = null;
        select.onChange( async () => {
            // This is called implicitly from the event dispatcher but also
            // explicitly via .trigger()
            // XXX Abstract out instead?
            const selectedEdit = select.getValue();

            // Update the selected cell or the whole calendar if the cell is not
            // found (ie calendar not rendered yet or year changed)
            const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
            const dayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            if (dayCell) {
                // Calendar already generated, highlight the new cell and
                // lowlight the old one
                if (selectedDayCell) {
                    selectedDayCell.addClass("calendar-level");
                    selectedDayCell.removeClass("calendar-selected");
                }
                selectedDayCell = dayCell;
                selectedDayCell.addClass("calendar-selected");
                selectedDayCell.removeClass("calendar-level");
            } else {
                this.renderCalendar(calendarDiv, select, zipFileSize, zip, filepaths);
                selectedDayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            }

            // Rebuild the file data of the given edit by applying the patches
            // in reverse, if one of the edits is stored fully, discard the
            // accumulated patched data and use the full data
            let data = latestData;
            let currentData = latestData;
            let currentDiff = null;

            // XXX This should cache currentData so sequentially traversing
            //     filepaths doesn't need to recreate this, and even if it's not
            //     sequential going to an earlier date can be done faster by
            //     using a non-current previousData. Only do it for the lifetime
            //     of the modal, so no need to keep one per each edited file.
            let found = false;
            let previousFound = false;
            for (let filepath of filepaths) {
                // filepath contains the negative backward diff to go from the
                // immediately newer date to filepath's date, need to
                // reconstruct the data upto the selected filepath and also the
                // immediately older one so the positive forward diff from older
                // to selected can be displayed
                let diff = await zip.file(filepath).async("string");
                
                if (this.plugin.getEditIsDiff(filepath)) {
                    // Rebuild the data from the diff applied to the current
                    // data
                    let patch = dmpobj.patch_fromText(diff);
                    // XXX This could collect patches and apply them in a
                    //     single call after the loop, not clear it's faster
                    data = dmpobj.patch_apply(patch, data)[0];
                } else {
                    // The full file was stored, there's no diff
                    data = diff;
                }

                if (found) {
                    previousFound = true;
                    break;
                }
                found = (selectedEdit == filepath);

                currentDiff = diff;
                currentData = data;
            }
            
            // If selectedEdit is the oldest edit, it won't find a previous one
            // to diff against, assume the previous is the empty file and diff
            // against that (this will be incorrect if the plugin wasn't enabled
            // when this file was created and already contained text, but
            // there's nothing that can be done in that case)
            if (!previousFound) {
                data = "";
            }

            // Display the diff against the latest edit
            // XXX Have an option to diff against an arbitrary non-sequential edit?
            // XXX This redoes the diff which shouldn't be necessary since
            //     we have all the patches, but it's not clear how to
            //     convert from patch to diff, looks like patch.diff is the
            //     set of diffs for a given patch? (but will still need to 
            //     re-diff when the whole file is saved instead of the diff)
            // XXX Add fold/unfold before/after context lines to the UI like
            //     file recovery does
            let diffHtml = "";
            // Store the currently selected version so it can be copied to
            // clipboard from the copy button handler
            this.currentVersionData = currentData;
            const showWhitespace = whitespaceCheckbox.getValue();
            // For side by side, getting line diffs via diff_lineMode could be
            // used instead which would avoid having to find line breaks below,
            // but using diff_main allows highlighting char-level diffs inside
            // each line 
            const diffs = dmpobj.diff_main(data, currentData);
            dmpobj.diff_cleanupSemantic(diffs);

            // Count added/removed lines for the summary banner. This is
            // intentionally coarse — just the count of "\n" inside inserted and
            // deleted segments — but good enough to tell the user at a glance
            // that something changed in this version.
            let addedLines = 0;
            let removedLines = 0;
            for (const [op, segment] of diffs) {
                if (segment.length === 0) continue;
                const lineCount = (segment.match(/\n/g)?.length ?? 0) || 1;
                if ((op as number) === DiffOp.Insert) addedLines += lineCount;
                else if ((op as number) === DiffOp.Delete) removedLines += lineCount;
            }
            changeSummaryDiv.empty();
            if (addedLines > 0 || removedLines > 0) {
                changeSummaryDiv.createEl("span", {
                    cls: "edit-history-change-summary-added",
                    text: `+${addedLines}`
                });
                changeSummaryDiv.createEl("span", { text: " / " });
                changeSummaryDiv.createEl("span", {
                    cls: "edit-history-change-summary-removed",
                    text: `-${removedLines}`
                });
                changeSummaryDiv.createEl("span", {
                    cls: "edit-history-change-summary-note",
                    text: " lines changed vs previous version"
                });
            } else {
                changeSummaryDiv.createEl("span", {
                    cls: "edit-history-change-summary-note",
                    text: "No changes vs previous version"
                });
            }

            // Highlight the active version in the left rail.
            versionListDiv.querySelectorAll(".edit-history-version-item.selected")
                .forEach(el => el.removeClass("selected"));
            const activeItem = versionListDiv.querySelector(
                `.edit-history-version-item[data-filepath="${CSS.escape(selectedEdit)}"]`
            );
            activeItem?.addClass("selected");
            activeItem?.scrollIntoView({ block: "nearest" });

            const diffDisplayFormat = diffDisplaySelect.getValue() as DiffDisplayFormat;

            // Page mode: render the selected version as live markdown via
            // Obsidian's MarkdownRenderer. Skip the char-level diff pipeline
            // below — the change summary banner already tells the reader
            // what's different, and this pane is meant to look like OneNote's
            // "view page as it was at this version".
            if (diffDisplayFormat === DiffDisplayFormat.Page) {
                diffDiv.empty();
                const pageView = diffDiv.createDiv("edit-history-page-view markdown-rendered");
                // Reset the render lifecycle between version switches so
                // listeners from the previous render get cleaned up.
                this.renderComponent.unload();
                this.renderComponent = new Component();
                this.renderComponent.load();
                await MarkdownRenderer.render(
                    this.app,
                    currentData,
                    pageView,
                    file.path,
                    this.renderComponent
                );
                this.currentVersionData = currentData;
                this.diffElements = diffDiv.querySelectorAll<HTMLElement>(".no-diff-elements-in-page-mode");
                this.curDiffIndex = 0;
                diffInfo.setText("page view");
                return;
            }

            switch (diffDisplayFormat) {
                case DiffDisplayFormat.Raw:
                    // XXX Missing setting the 1/n diffcount that is displayed
                    //     by the dropdowns (maybe by counting @@ and dividing
                    //     by 2?), but it's currently extracted from
                    //     diffElements.length, so that needs changing

                    // Note raw display of the diff looks counter-intuitive
                    // because the diff stores the difference between the
                    // version newer than filepath and filepath, which is a
                    // "negative forward" diff. Arguably it should show the
                    // "positive backward" diff between filepath and the version
                    // previous to filepath, but then it's not "raw"
                    let hdata = htmlEncode(currentDiff, showWhitespace);
                    diffHtml = "<tt>" + hdata + "</tt>";
                break;
                case DiffDisplayFormat.Timeline:
                    diffHtml = await this.renderDiffsTimeline(zip, dmpobj, filepaths, selectedEdit, latestData, showWhitespace);
                break;
                case DiffDisplayFormat.Inline:
                    diffHtml = this.renderDiffsInline(diffs, showWhitespace);
                break;
                default:
                    const sideBySide = (diffDisplayFormat == DiffDisplayFormat.Horizontal);
                    diffHtml = this.renderDiffsSideOrTop(diffs, sideBySide, showWhitespace);
                break;
            }
            // Remove carriage returns since <br> have been added in htmlEncode
            // XXX Do this in htmlEncode but \n can't be removed right away
            //     since it's used to detect end of line in side by side
            //     displays above
            // XXX Removing carriage returns seems to be needed because in
            //     styles.css .diff-div uses pre-wrap instead of just wrap in
            //     order to preserve spaces/tabs so diff of a space is still
            //     visible, but don't want to show carriage returns since
            //     htmlEncode has converted them to <br>\n. Convert spaces/tabs
            //     to nbsp in htmlEncode? Don't convert to <br> in htmlEncode?
            diffHtml = diffHtml.replace(/\n/g, "");
            
            // XXX Make colors configurable, in modal setting or per theme
            //     light/dark
            //     See https://github.com/friebetill/obsidian-file-diff/issues/1#issuecomment-1425157959
            // XXX Have a button to roll back to version
            // XXX innerHTML is discouraged for security reasons, change?
            //     (note this is safe because diffHtml is escaped)
            //     See https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md#avoid-innerhtml-outerhtml-and-insertadjacenthtml
            // XXX This is a performance hotspot, calls the internal parseHtml,
            //     not clear this can be done faster by creating nodes manually
            //     instead (chatgpt actually says parsing is faster). Creating
            //     nodes and storing them would also also avoid calling
            //     querySelectorAll below which is also a hotspot
            diffDiv.innerHTML = diffHtml;
            // Diffs are spans of <ins> or <del> tags, scroll to the first one
            this.curDiffIndex = 0;
            // diffElements is used for navigating prev/next diffs in all diff
            // displays but Raw. diff-line marks added/deleted lines in side by
            // side/top by bottom, individual changes in inline, and added lines
            // in timeline
            const diffElements = diffDiv.querySelectorAll<HTMLElement>(".diff-line");
            this.diffElements = diffElements;
            this.diffElements[this.curDiffIndex]?.scrollIntoView({block: "center"});
            this.diffElements[this.curDiffIndex]?.addClass("current");
            // XXX Number of diffs is ok for navigating but not a great
            //     statistic, this could also show chars added/chars deleted?
            diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
            // Navigate edits on click in the timeline view
            // XXX Clicking navigates the timeline "backwards", have a way of
            //     navigating forwards?
            const table = diffDiv.querySelector("table");
            const cells = table?.querySelectorAll("td.diff-time");
            cells?.forEach(cell => {
                // Set the onclick handler
                cell.addEventListener('click', () => {
                    logDbg('Cell clicked:', cell);
                    // cell contents are in the same format as the drop down
                    const text = cell.textContent as string;
                    // Select the first date that matches in the drop down
                    // (since this is a date without time, there can be multiple
                    // matching diffs in the same day)
                    const selectEl = select.selectEl;
                    const options = selectEl.options;
                    for (let i = 0; i < options.length; i++) {
                        if (options[i].text == text) {
                            if (i != selectEl.selectedIndex) {
                                selectEl.selectedIndex = i;
                                selectEl.trigger("change");
                            }
                            break;
                        }
                    }
                });
            });
        });

        // Create option entries (both the hidden <select> for keyboard nav and
        // the visible left-rail list).
        for (let i = 0; i < filepaths.length; i++) {
            const filepath = filepaths[i];
            // XXX The drop down displays the changes between the selected
            //     date and the immediately older date
            //     This means that:
            //      -  the first entry should be a dummy entry with the current
            //         contents date that displays the diff from the current
            //         contents to the first file in the history (probably no
            //         changes if a revision was recently saved)
            //      - the last entry is a diff from that entry's date to the
            //        empty file
            //     Missing setting the first dummy entry
            select.addOption(filepath, this.plugin.getEditLocalDateStr(filepath));

            const author = this.plugin.getEditAuthor(filepath) ?? "unknown";
            const dateStr = this.plugin.getEditDate(filepath).toLocaleString();
            const itemEl = versionListDiv.createDiv({
                cls: "edit-history-version-item",
                attr: { "data-filepath": filepath }
            });
            itemEl.createEl("div", { cls: "edit-history-version-date", text: dateStr });
            itemEl.createEl("div", { cls: "edit-history-version-author", text: author });
            const itemIndex = i;
            itemEl.addEventListener("click", () => {
                if (select.selectEl.selectedIndex === itemIndex) return;
                select.selectEl.selectedIndex = itemIndex;
                select.selectEl.trigger("change");
            });
        }
        // Force initialization done inside onChange
        select.selectEl.trigger("change");
        
        // Update the status bar
        // XXX This shouldn't be here, but this is the best until it's done when
        //     switching panes, etc (or use a timer?)
        this.plugin.statusBarItemEl.setText(filepaths.length + " edits");
    }

    onClose() {
        logInfo("onClose");
        this.renderComponent.unload();
        const {contentEl} = this;
        contentEl.empty();
    }
}

class EditHistorySettingTab extends PluginSettingTab { plugin:
    EditHistory;

    constructor(app: App, plugin: EditHistory) {
        super(app, plugin);
        this.plugin = plugin;
    }
    hide(): any {
        logInfo("hide");
        super.hide();
    }
    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        containerEl.createEl("small", { text: "Created by "})
            .appendChild(createEl("a", { text: "Antonio Tejada", href:"https://github.com/antoniotejada/"}));

        // h2 is abnormally small in settings, start with h3 which has the right
        // size (other plugins do the same)
        containerEl.createEl("h3", {text: "General"});

        new Setting(containerEl)
            .setName("Minimum seconds between edits")
            .setDesc("Minimum number of seconds that must pass from the previous edit to store a new edit, set to 0 to disable. Modifications done between those seconds will be merged into the next edit, reducing the edit history file size at the expense of less history granularity.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.minSecondsBetweenEdits)
                .setValue(this.plugin.settings.minSecondsBetweenEdits)
                .onChange(async (value) => {
                    logInfo("Minimum seconds between edits: " + value);
                    this.plugin.settings.minSecondsBetweenEdits = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
                .setName("Maximum number of edits")
                .setDesc("Maximum number of edits to keep, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.maxEdits)
                    .setValue(this.plugin.settings.maxEdits)
                    .onChange(async (value) => {
                        logInfo("Maximum number of edits: " + value);
                        this.plugin.settings.maxEdits = value;
                        await this.plugin.saveSettings();
                    }));

        new Setting(containerEl)
            .setName("Maximum age of edits")
            .setDesc("Oldest edit to keep in seconds, eg set to 3600 to delete edits that are more than one hour old, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxEditAge)
                .setValue(this.plugin.settings.maxEditAge)
                .onChange(async (value) => {
                    logInfo("Maximum age of edits: " + value);
                    this.plugin.settings.maxEditAge = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Maximum size of the history file (KB)")
            .setDesc("Maximum size of the history file in kilobytes, set to 0 for no limit. When over the size, edits will be deleted from the history in the next update, older edits first, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxHistoryFileSizeKB)
                .setValue(this.plugin.settings.maxHistoryFileSizeKB)
                .onChange(async (value) => {
                    logInfo("Maximum history file size: " + value);
                    this.plugin.settings.maxHistoryFileSizeKB = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("File extension whitelist")
            .setDesc("Comma separated list of file extensions to store edits for (case insensitive). Empty to store edits for all files.\nNote if an extension is removed, old edit history files will need to be removed manually.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.extensionWhitelist)
                .setValue(this.plugin.settings.extensionWhitelist)
                .onChange(async (value) => {
                    logInfo("File extension whitelist: " + value);
                    this.plugin.settings.extensionWhitelist = value;
                    await this.plugin.saveSettings();
                }));
                
        new Setting(containerEl)
                .setName("Filepath substring blacklist")
                .setDesc("Comma separated list of substrings of note filepaths to not store edits for (case insensitive). Empty to store edits for all files.\nUse forward slashes as folder separator\nNote if a substring is added, old edit history files will need to be removed manually.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.substringBlacklist)
                    .setValue(this.plugin.settings.substringBlacklist)
                    .onChange(async (value) => {
                        logInfo("File substring blacklist: '" + value + "'");
                        this.plugin.settings.substringBlacklist = value;
                        await this.plugin.saveSettings();
                    }));

        // Storage layout: sibling (.edtz next to each note) vs. mirrored (all
        // .edtz under a hidden .edtz/ root mirroring the vault's folder
        // structure). Toggling migrates existing files to match the new
        // layout so the user doesn't end up with a mixed state.
        new Setting(containerEl)
            .setName("Store history in hidden folder")
            .setDesc(`When off (default), each note's .edtz sits beside it (e.g. "Notes/foo.md.edtz"). When on, all history files move to a hidden "${MIRRORED_STORAGE_ROOT}/" folder that mirrors your vault layout (e.g. "${MIRRORED_STORAGE_ROOT}/Notes/foo.md.edtz") — Obsidian hides dotfile folders by default, so it keeps the tree clean. Toggling this moves all existing .edtz files to match.`)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useMirroredStorage)
                .onChange(async (value) => {
                    logInfo("Storage mode changing to", value ? "mirrored" : "sibling");
                    this.plugin.settings.useMirroredStorage = value;
                    await this.plugin.saveSettings();
                    const progressNotice = new Notice(
                        `Edit History: moving history files to ${value ? "mirrored" : "sibling"} layout…`,
                        0
                    );
                    try {
                        const result = await this.plugin.migrateEditHistoryFiles(value);
                        progressNotice.hide();
                        new Notice(
                            `Edit History: moved ${result.moved}, skipped ${result.skipped}` +
                            (result.errors > 0 ? `, ${result.errors} errors (see console)` : "")
                        );
                        // Force an explicit refresh: rename events during the
                        // migration may not fire reliably for files crossing
                        // into / out of a dotfile folder.
                        await this.plugin.refreshFileExplorer();
                    } catch (e) {
                        progressNotice.hide();
                        logWarn("Migration failed", e);
                        new Notice("Edit History: migration failed — see console");
                    }
                }));

        new Setting(containerEl)
            .setName("Author name")
            .setDesc(`Vault-wide fallback name tagged onto new edits. Overridden per-device by the "Per-device authors" map below — set that map in a multi-device, multi-human vault. External processes (AI agents writing files directly) can override both by writing their name into '${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/${AUTHOR_OVERRIDE_FILE}' (delete the file to clear, or let it auto-expire via the timeout below). Saves triggered by you typing in Obsidian use the per-device map first, then this Author name, and ignore the override — agents can't hijack your manual edits. Empty here falls back to the device hostname. Old edits without an author will show "unknown".`)
            .addText(text => text
                .setPlaceholder("e.g. Mark Volders")
                .setValue(this.plugin.settings.authorName)
                .onChange(async (value) => {
                    logInfo("Author name: " + value);
                    this.plugin.settings.authorName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Author override timeout (minutes)")
            .setDesc("If the author override file hasn't been touched within this many minutes, it's auto-deleted and future edits fall back to the Author name above. Default 10. Set to 0 to disable auto-cleanup (overrides stay until cleared manually). This prevents an AI agent's transient author from sticking around on subsequent manual edits.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.authorOverrideTimeoutMinutes)
                .setValue(this.plugin.settings.authorOverrideTimeoutMinutes)
                .onChange(async (value) => {
                    logInfo("Author override timeout: " + value);
                    this.plugin.settings.authorOverrideTimeoutMinutes = value;
                    await this.plugin.saveSettings();
                }));

        // Show the currently-effective author so the user can see at a glance
        // whether a stale override file is hijacking their edits.
        const effectiveRow = new Setting(containerEl)
            .setName("Currently tagging edits as")
            .setDesc("Resolved right now from: override file > per-device map > Author name > device hostname.");
        const effectiveText = effectiveRow.controlEl.createEl("code", { text: "…" });
        effectiveText.style.userSelect = "text";
        const refreshEffective = async () => {
            const name = await this.plugin.getCurrentAuthor();
            effectiveText.setText(name);
            const overrideExists = await this.plugin.app.vault.adapter.exists(
                this.plugin.getAuthorOverridePath()
            );
            effectiveText.style.color = overrideExists
                ? "var(--color-orange)"
                : "var(--text-normal)";
        };
        refreshEffective();
        effectiveRow.addExtraButton(btn => btn
            .setIcon("refresh-cw")
            .setTooltip("Refresh")
            .onClick(() => refreshEffective()));
        effectiveRow.addExtraButton(btn => btn
            .setIcon("trash-2")
            .setTooltip("Delete override file now")
            .onClick(async () => {
                const p = this.plugin.getAuthorOverridePath();
                if (await this.plugin.app.vault.adapter.exists(p)) {
                    await this.plugin.app.vault.adapter.remove(p);
                    new Notice("Author override cleared");
                } else {
                    new Notice("No override file to clear");
                }
                refreshEffective();
            }));

        containerEl.createEl("h3", {text: "Per-device authors"});

        const deviceAuthorsDescEl = containerEl.createEl("div", {cls: "setting-item-description"});
        deviceAuthorsDescEl.style.marginBottom = "0.75em";
        deviceAuthorsDescEl.setText(
            "Vault-shared map of device hostname \u2192 author name. When set, each " +
            "device automatically tags new edits with the mapped author \u2014 no " +
            "per-device setup needed beyond adding the row here. The map is " +
            "stored in this plugin's data.json and synced with the vault, so " +
            "adding e.g. 'Crest \u2192 Raf Peeters' on any machine takes effect on " +
            "Crest immediately. Mobile devices have no hostname and fall back " +
            "to the Author name above."
        );

        const thisHost = this.plugin.getDeviceHostname();
        const thisHostRow = new Setting(containerEl)
            .setName("This device's hostname")
            .setDesc("Use this exact value as the key when mapping this device.");
        const thisHostCode = thisHostRow.controlEl.createEl("code", {
            text: thisHost || "(unavailable on this device)"
        });
        thisHostCode.style.userSelect = "text";

        const mapRowsContainer = containerEl.createDiv();

        const renderMapRows = () => {
            mapRowsContainer.empty();
            const map = this.plugin.settings.deviceAuthors || {};
            const hosts = Object.keys(map).sort();
            if (hosts.length === 0) {
                const empty = mapRowsContainer.createEl("div", {cls: "setting-item-description"});
                empty.style.fontStyle = "italic";
                empty.style.padding = "0.25em 0 0.5em 0";
                empty.setText("No mappings yet. Use the buttons below to add one.");
                return;
            }
            for (const host of hosts) {
                const row = new Setting(mapRowsContainer).setName(host);
                row.addText(text => text
                    .setPlaceholder("Author name for this device")
                    .setValue(map[host])
                    .onChange(async (value) => {
                        this.plugin.settings.deviceAuthors[host] = value;
                        await this.plugin.saveSettings();
                        refreshEffective();
                    }));
                row.addExtraButton(btn => btn
                    .setIcon("trash-2")
                    .setTooltip("Remove this mapping")
                    .onClick(async () => {
                        delete this.plugin.settings.deviceAuthors[host];
                        await this.plugin.saveSettings();
                        refreshEffective();
                        renderMapRows();
                    }));
            }
        };
        renderMapRows();

        const addThisDeviceRow = new Setting(containerEl)
            .setName("Add this device")
            .setDesc(thisHost
                ? `Adds a row keyed on '${thisHost}' (this device).`
                : "Hostname unavailable \u2014 likely Obsidian Mobile. Add manually below.");
        addThisDeviceRow.addButton(btn => btn
            .setButtonText("Add")
            .setCta()
            .setDisabled(!thisHost)
            .onClick(async () => {
                if (thisHost && this.plugin.settings.deviceAuthors[thisHost] === undefined) {
                    this.plugin.settings.deviceAuthors[thisHost] = "";
                    await this.plugin.saveSettings();
                    renderMapRows();
                } else if (thisHost) {
                    new Notice(`'${thisHost}' is already in the map`);
                }
            }));

        let pendingHost = "";
        const addOtherRow = new Setting(containerEl)
            .setName("Add another device")
            .setDesc("Type the hostname of a device you're not currently using.");
        addOtherRow.addText(text => text
            .setPlaceholder("hostname")
            .onChange(value => { pendingHost = value.trim(); }));
        addOtherRow.addButton(btn => btn
            .setButtonText("Add")
            .onClick(async () => {
                if (!pendingHost) {
                    new Notice("Type a hostname first");
                    return;
                }
                if (this.plugin.settings.deviceAuthors[pendingHost] !== undefined) {
                    new Notice(`'${pendingHost}' is already in the map`);
                    return;
                }
                this.plugin.settings.deviceAuthors[pendingHost] = "";
                await this.plugin.saveSettings();
                pendingHost = "";
                renderMapRows();
                this.display();
            }));

        containerEl.createEl("h3", {text: "Appearance"});
        new Setting(containerEl)
            .setName("Show on status bar")
            .setDesc("Show edit history file information on the status bar. Click the status bar to show the edit history for the current file.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showOnStatusBar)
                .onChange(async (value) => {
                    logInfo("Show edits on status bar: " + value);
                    this.plugin.settings.showOnStatusBar = value;
                    await this.plugin.saveSettings();
                    this.plugin.statusBarItemEl.toggle(this.plugin.settings.showOnStatusBar);
            }));

        new Setting(containerEl)
            .setName("Diff display type")
            .setDesc("In the diff view, display the diff raw, timeline, inline, horizontally (side by side), or vertically (top by bottom).")
            .addDropdown(dropdown => dropdown
                .addOptions(diffDisplayFormatToString)
                .setValue(this.plugin.settings.diffDisplayFormat)
                .onChange(async (value) => {
                    logInfo("Diff display position: " + value);
                    this.plugin.settings.diffDisplayFormat = value;
                    await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Show whitespace")
            .setDesc("Show whitespace in the diff view.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showWhitespace)
                .onChange(async (value) => {
                    logInfo("Show whitespace: " + value);
                    this.plugin.settings.showWhitespace = value;
                    await this.plugin.saveSettings();
            }));

        containerEl.createEl("h3", {text: "Debugging"});
        new Setting(containerEl)
            .setName("Debug level")
            .setDesc("Messages to show in the javascript console.")
            .addDropdown(dropdown => dropdown
                .addOption("error", "Errors")
                .addOption("warn", "Warnings")
                .addOption("info", "Information")
                .addOption("debug", "Verbose")
                .setValue(this.plugin.settings.debugLevel)
                .onChange(async (value) => {
                    logInfo("Debug level: " + value);
                    this.plugin.settings.debugLevel = value;
                    await this.plugin.saveSettings();
                }));


        /* XXX Issues with allowing a user-configured history folder: 
            - any history folder will mimic the the structure of the note
              directory (alternatively history files could be on a flat
              directory with the name coming from a hash of the full path, but
              that makes renaming more involved, and fishing for history files
              less intuitive)

            - due to an Obsidian design decision, folders cannot start with "."
              so the user-defined history folder be visible in the file explorer
                - Note this limitation is not consistently enforced through the
                    API:
                    - Obsidian does allow createBinary on a path starting with a
                      dot and it successfully creates the file
                    - Unfortunately getAbstractFileFromPath on a path starting
                      with a dot fails so the file can be created (which only
                      requires the path) but not modified (which requires a
                      TAbstractFile)

            - because it's visible, the user can rename the edit history folder
              from the obsidian UI,
                - renaming the topmost directory could be supported since the
                  only thing needed would be to update the internal variable.
                  Obisidan API notifies of the top level rename and each
                  children, which can be ignored. This will need care depending
                  on the reporting order of root vs. children and the update of
                  the internal variable.
                - if the user renames a non-top level directory then all
                  children history files would go out of sync, so this is a
                  problem.

            - the Obsidian setting onChange gets called on every keystroke, so
               configuring the edit history folder in settings would cause a
               rename on each keystroke. There doesn't seem to be a final
               changed(), hide() is not called either

            - it's not clear whether the folder should be deleted if empty

            - it's not clear if it's safe to just copy all the files found with
              whatever extension new Setting(containerEl) .setName('Edits
              folder') .setDesc('Folder to store the edit history file. Empty to
              store the edit file in the same directory alongside the original
              file. Due to Obsidian limitations this must start with a character
              other than "."') .addText(text => text .setPlaceholder('Enter the
              folder name')
              .setValue(this.plugin.settings.editHistoryRootFolder)
              .onChange(async (value) => { logInfo("onChange"); logInfo('Edits
              folder: ' + value); // Only allow top level folders

                    this.plugin.settings.editHistoryRootFolder = value;


            XXX Can the folder just be renamed via the file explorer
            interface? 

            XXX Check no dir component starts with "." 

            XXX Delete edits? copy them to new folder? trash them? 

            XXX Ask the user to delete folder? 

            XXX Ask for confirmation? 

            XXX Use private apis to store in some hidden folder? 

            XXX This could use the adapter apis instead of the vault apis //
            be able to access the .obsidian dir? (or any other?)

            XXX The directory doesn't need to be created on every keystroke,
            it could have a create/commit button?
        */


}
}
