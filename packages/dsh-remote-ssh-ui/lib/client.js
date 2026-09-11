window.__ModuleLoader__.load({
	id: "dsh-remote-ssh-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/**
		 * Browser half of the remote-workspace plugin.
		 *
		 * It contributes three things and owns no state of its own beyond the
		 * dialog it renders:
		 *
		 *  - an occupant of ui-workspace's two directory-flow holes, offering the
		 *    local machine (through the composed native/browse chooser's own
		 *    `pick` verb, so the platform picker is preserved) beside a remote
		 *    SSH browser;
		 *  - a launcher button in `sidebar.footer.action`, which stays reachable
		 *    even when the shipped occupant wins the single-occupancy hole;
		 *  - the Settings -> Plugins card for the `remote-ssh` namespace.
		 *
		 * Host calls go through the raw connection carrier at
		 * `<namespace>/<method>`: the plugin ships no generated Typert artifacts,
		 * so the Gateway resolves each endpoint through its source-mode discovery.
		 */
		const NAMESPACE = "sshWorkspace";
		/** Locale namespace for every string this plugin shows. */
		const NS = "dsh-remote-ssh-ui";

		/**
		 * Display text, in the three locales the harness resolves from the
		 * browser's language. Keys are flat and the values take `{name}`-style
		 * placeholders, which is the shape ctx.locale expects.
		 */
		const dictionaries = {
			en: {
				"settings.work": "Remote work",
				"settings.workEmpty": "Nothing running on a server.",
				"settings.workKeeps": "Work started here runs on the server and keeps running after you close the harness.",
				"action.stop": "Stop",
				"action.refresh": "Refresh",
				"action.forgetFinished": "Forget finished",
				"state.running": "running",
				"state.exited": "finished",
				"state.gone": "gone",
				"state.unknown": "unknown",
				"settings.tailscale": "Tailscale",
				"settings.tailscaleMissing": "not installed — install it, then press Re-check",
				"settings.tailscaleAvailable": "available",
				"action.recheck": "Re-check",
				"state.checking": "Checking…",
				"settings.tailscaleHint": "Tailscale was not found on PATH. Install it and press Re-check; the plugin adopts it without reinstalling.",
				"settings.tailscaleNote": "A Tailscale client installed later is picked up here.",
				"dialog.title": "Add a workspace",
				"tab.local": "This computer",
				"tab.remote": "Remote server (SSH)",
				"launcher.label": "Remote server",
				"action.close": "Close",
				"action.cancel": "Cancel",
				"action.use": "Use this folder",
				"action.adding": "Adding…",
				"action.connect": "Connect",
				"action.connecting": "Connecting…",
				"action.addServer": "+ Server",
				"action.systemPicker": "System picker…",
				"action.chooseFolder": "Choose a folder…",
				"action.newFolder": "+ New folder",
				"action.create": "Create",
				"action.forget": "Forget",
				"state.loading": "Loading…",
				"state.emptyFolder": "(empty folder)",
				"field.label": "Name (optional)",
				"field.host": "Host",
				"field.port": "Port",
				"field.user": "User",
				"field.key": "Private key (local path)",
				"field.password": "Password (optional)",
				"field.transport": "Transport",
				"placeholder.label": "prod",
				"placeholder.host": "10.0.0.4, node.tailnet.ts.net",
				"placeholder.user": "root",
				"placeholder.key": "~/.ssh/id_ed25519",
				"placeholder.folderName": "folder-name",
				"error.hostRequired": "The host is required.",
				"error.refused": "connection refused",
				"tailnet.peers": "From Tailscale ({n} peers, MagicDNS)",
				"tailnet.legend": "● online · ○ offline · ⚡ Tailscale SSH available",
				"transport.opensshHint": "Plain ssh. On a MagicDNS name or a 100.x address the traffic already goes over WireGuard.",
				"transport.tailscaleHint": "Goes through the Tailscale client: MagicDNS resolution, access governed by tailnet ACLs, host key verified against the coordination server.",
				"transport.openssh": "OpenSSH",
				"transport.tailscale": "Tailscale SSH",
				"connect.note": "Key authentication uses your SSH agent and ~/.ssh/config. A password needs sshpass and is stored only in $DSH_HOME/remotes.json (chmod 600).",
				"local.systemChooser": "This deployment uses the system folder chooser.",
				"local.browseHint": "or pick from the tree below",
				"footer.remoteFolder": "Remote folder: {path}",
				"footer.localFolder": "Local folder: {path}",
				"mirror.local": "Local mirror: {path}",
				"disabled.notice": "Remote SSH is switched off. Enable it in Settings → Plugins → “remote-ssh”.",
				"settings.title": "Remote workspaces (SSH)",
				"settings.description": "Connect servers, pick a remote folder, and work in it with every tool.",
				"settings.enabled": "Enabled",
				"settings.disabled": "Disabled",
				"settings.empty": "No server connected yet."
			},
			fr: {
				"settings.work": "Travaux distants",
				"settings.workEmpty": "Rien ne tourne sur un serveur.",
				"settings.workKeeps": "Un travail lancé ici s'exécute sur le serveur et continue après la fermeture du harness.",
				"action.stop": "Arrêter",
				"action.refresh": "Rafraîchir",
				"action.forgetFinished": "Oublier les terminés",
				"state.running": "en cours",
				"state.exited": "terminé",
				"state.gone": "disparu",
				"state.unknown": "inconnu",
				"settings.tailscale": "Tailscale",
				"settings.tailscaleMissing": "non installé — installez-le puis cliquez sur Revérifier",
				"settings.tailscaleAvailable": "disponible",
				"action.recheck": "Revérifier",
				"state.checking": "Vérification…",
				"settings.tailscaleHint": "Tailscale est introuvable dans le PATH. Installez-le puis cliquez sur Revérifier ; le plugin l'adopte sans réinstallation.",
				"settings.tailscaleNote": "Un client Tailscale installé plus tard est détecté ici.",
				"dialog.title": "Ajouter un workspace",
				"tab.local": "Cet ordinateur",
				"tab.remote": "Serveur distant (SSH)",
				"launcher.label": "Serveur distant",
				"action.close": "Fermer",
				"action.cancel": "Annuler",
				"action.use": "Utiliser ce dossier",
				"action.adding": "Ajout…",
				"action.connect": "Se connecter",
				"action.connecting": "Connexion…",
				"action.addServer": "＋ Serveur",
				"action.systemPicker": "Sélecteur du système…",
				"action.chooseFolder": "Choisir un dossier…",
				"action.newFolder": "＋ Nouveau dossier",
				"action.create": "Créer",
				"action.forget": "Oublier",
				"state.loading": "Chargement…",
				"state.emptyFolder": "(dossier vide)",
				"field.label": "Nom (optionnel)",
				"field.host": "Hôte",
				"field.port": "Port",
				"field.user": "Utilisateur",
				"field.key": "Clé privée (chemin local)",
				"field.password": "Mot de passe (optionnel)",
				"field.transport": "Transport",
				"placeholder.label": "prod",
				"placeholder.host": "10.0.0.4, node.tailnet.ts.net",
				"placeholder.user": "root",
				"placeholder.key": "~/.ssh/id_ed25519",
				"placeholder.folderName": "nom-du-dossier",
				"error.hostRequired": "L'hôte est obligatoire.",
				"error.refused": "connexion refusée",
				"tailnet.peers": "Depuis Tailscale ({n} pairs, MagicDNS)",
				"tailnet.legend": "● en ligne · ○ hors ligne · ⚡ Tailscale SSH disponible",
				"transport.opensshHint": "ssh classique. Sur un nom MagicDNS ou une adresse 100.x, le trafic passe déjà par WireGuard.",
				"transport.tailscaleHint": "Passe par le client Tailscale : résolution MagicDNS, accès par les ACL du tailnet, clé d'hôte vérifiée auprès du serveur de coordination.",
				"transport.openssh": "OpenSSH",
				"transport.tailscale": "Tailscale SSH",
				"connect.note": "L'authentification par clé utilise votre agent SSH et votre ~/.ssh/config. Le mot de passe nécessite sshpass et n'est stocké que dans $DSH_HOME/remotes.json (chmod 600).",
				"local.systemChooser": "Ce déploiement utilise le sélecteur de dossiers du système.",
				"local.browseHint": "ou choisissez dans l'arborescence ci-dessous",
				"footer.remoteFolder": "Dossier distant : {path}",
				"footer.localFolder": "Dossier local : {path}",
				"mirror.local": "Miroir local : {path}",
				"disabled.notice": "Le module SSH distant est désactivé. Activez-le dans Paramètres → Plugins → « remote-ssh ».",
				"settings.title": "Workspaces distants (SSH)",
				"settings.description": "Connectez des serveurs, choisissez un dossier distant et travaillez dedans avec tous les outils.",
				"settings.enabled": "Activé",
				"settings.disabled": "Désactivé",
				"settings.empty": "Aucun serveur connecté pour l'instant."
			},
			zh: {
				"settings.work": "远程任务",
				"settings.workEmpty": "服务器上暂无运行中的任务。",
				"settings.workKeeps": "在这里启动的任务在服务器上运行，关闭 harness 后仍会继续。",
				"action.stop": "停止",
				"action.refresh": "刷新",
				"action.forgetFinished": "清除已结束",
				"state.running": "运行中",
				"state.exited": "已完成",
				"state.gone": "已消失",
				"state.unknown": "未知",
				"settings.tailscale": "Tailscale",
				"settings.tailscaleMissing": "未安装 — 安装后点击“重新检测”",
				"settings.tailscaleAvailable": "可用",
				"action.recheck": "重新检测",
				"state.checking": "检测中…",
				"settings.tailscaleHint": "PATH 中未找到 Tailscale。安装后点击“重新检测”，插件无需重装即可使用。",
				"settings.tailscaleNote": "之后安装的 Tailscale 客户端会在这里被检测到。",
				"dialog.title": "添加工作区",
				"tab.local": "本机",
				"tab.remote": "远程服务器（SSH）",
				"launcher.label": "远程服务器",
				"action.close": "关闭",
				"action.cancel": "取消",
				"action.use": "使用此文件夹",
				"action.adding": "添加中…",
				"action.connect": "连接",
				"action.connecting": "连接中…",
				"action.addServer": "＋ 服务器",
				"action.systemPicker": "系统选择器…",
				"action.chooseFolder": "选择文件夹…",
				"action.newFolder": "＋ 新建文件夹",
				"action.create": "创建",
				"action.forget": "移除",
				"state.loading": "加载中…",
				"state.emptyFolder": "（空文件夹）",
				"field.label": "名称（可选）",
				"field.host": "主机",
				"field.port": "端口",
				"field.user": "用户",
				"field.key": "私钥（本地路径）",
				"field.password": "密码（可选）",
				"field.transport": "传输方式",
				"placeholder.label": "prod",
				"placeholder.host": "10.0.0.4, node.tailnet.ts.net",
				"placeholder.user": "root",
				"placeholder.key": "~/.ssh/id_ed25519",
				"placeholder.folderName": "文件夹名称",
				"error.hostRequired": "必须填写主机。",
				"error.refused": "连接被拒绝",
				"tailnet.peers": "来自 Tailscale（{n} 个节点，MagicDNS）",
				"tailnet.legend": "● 在线 · ○ 离线 · ⚡ 可用 Tailscale SSH",
				"transport.opensshHint": "普通 ssh。使用 MagicDNS 名称或 100.x 地址时，流量已经过 WireGuard。",
				"transport.tailscaleHint": "经由 Tailscale 客户端：解析 MagicDNS、由 tailnet ACL 控制访问、并通过协调服务器校验主机密钥。",
				"transport.openssh": "OpenSSH",
				"transport.tailscale": "Tailscale SSH",
				"connect.note": "密钥认证使用你的 SSH agent 与 ~/.ssh/config。密码需要 sshpass，且仅保存在 $DSH_HOME/remotes.json（chmod 600）。",
				"local.systemChooser": "此部署使用系统文件夹选择器。",
				"local.browseHint": "或在下方目录树中选择",
				"footer.remoteFolder": "远程文件夹：{path}",
				"footer.localFolder": "本地文件夹：{path}",
				"mirror.local": "本地镜像：{path}",
				"disabled.notice": "远程 SSH 已关闭。请在 设置 → 插件 → “remote-ssh” 中启用。",
				"settings.title": "远程工作区（SSH）",
				"settings.description": "连接服务器、选择一个远程文件夹，并用全部工具在其中工作。",
				"settings.enabled": "已启用",
				"settings.disabled": "已禁用",
				"settings.empty": "尚未连接任何服务器。"
			}
		};

		/**
		 * Locale-bound translator.
		 *
		 * Slot components are plain functions the shell renders, not closures over
		 * apply(), so the binding lives at module scope and apply() sets it once.
		 * Until then the key itself is returned, which keeps a stray call visible
		 * rather than blank.
		 */
		let translate = (key) => key;
		const T = (key, params) => translate(key, params);
		const SETTINGS_NS = "remote-ssh";

		const FONT = "var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)";
		const C = {
			text: "var(--dsw-alias-label-primary, #e8e8e8)",
			dim: "var(--dsw-alias-label-secondary, #a0a0a0)",
			faint: "var(--dsw-alias-label-tertiary, #808080)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))",
			border: "var(--dsw-alias-border-l4, rgba(128,128,128,.28))",
			panel: "var(--dsw-alias-button-elevated-fill, #2a2a2c)",
			backdrop: "var(--dsw-alias-bg-mask, rgba(0,0,0,.45))",
			accent: "var(--dsw-alias-state-business-primary, #4c8dff)",
			danger: "var(--dsw-alias-state-error-primary, #ff6b6b)",
			ok: "var(--dsw-alias-state-success-primary, #3fb950)"
		};

		const styles = {
			overlay: {
				position: "fixed", inset: 0, zIndex: 4000, display: "flex",
				alignItems: "center", justifyContent: "center", background: C.backdrop
			},
			dialog: {
				width: "min(680px, calc(100vw - 48px))", maxHeight: "min(620px, calc(100vh - 64px))",
				display: "flex", flexDirection: "column", background: C.panel, color: C.text,
				border: `0.5px solid ${C.border}`, borderRadius: 14, fontFamily: FONT,
				boxShadow: "0 24px 64px rgba(0,0,0,.35)", overflow: "hidden"
			},
			head: { display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderBottom: `0.5px solid ${C.border}` },
			title: { flex: 1, fontSize: 15, fontWeight: 600 },
			tabs: { display: "flex", gap: 4, padding: "10px 12px 0" },
			tab: (active) => ({
				cursor: "pointer", border: "none", borderRadius: 8, padding: "7px 12px", fontSize: 13,
				fontFamily: FONT, color: active ? C.text : C.dim,
				background: active ? C.hover : "transparent"
			}),
			body: { flex: 1, minHeight: 180, overflowY: "auto", padding: 16 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			chip: (active) => ({
				cursor: "pointer", border: `0.5px solid ${active ? C.accent : C.border}`, borderRadius: 999,
				padding: "4px 10px", fontSize: 12, fontFamily: FONT, background: "transparent",
				color: active ? C.text : C.dim
			}),
			list: { marginTop: 10, border: `0.5px solid ${C.border}`, borderRadius: 10, overflow: "hidden" },
			item: (isDir) => ({
				display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
				padding: "8px 12px", fontSize: 13, fontFamily: FONT, color: isDir ? C.text : C.faint,
				background: "transparent", border: "none", cursor: isDir ? "pointer" : "default"
			}),
			crumbs: { display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", fontSize: 12, color: C.dim, minHeight: 22 },
			crumb: { cursor: "pointer", background: "transparent", border: "none", color: C.accent, fontFamily: FONT, fontSize: 12, padding: "2px 4px" },
			input: {
				width: "100%", boxSizing: "border-box", background: "transparent", color: C.text,
				border: `0.5px solid ${C.border}`, borderRadius: 8, padding: "7px 10px",
				fontSize: 13, fontFamily: FONT, outline: "none"
			},
			label: { fontSize: 12, color: C.dim, marginBottom: 4, display: "block" },
			field: { flex: "1 1 180px", minWidth: 140 },
			foot: { display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: `0.5px solid ${C.border}` },
			button: (primary, disabled) => ({
				cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
				border: primary ? "none" : `0.5px solid ${C.border}`, borderRadius: 8, padding: "8px 14px",
				fontSize: 13, fontFamily: FONT, background: primary ? C.accent : "transparent",
				color: primary ? "#fff" : C.text
			}),
			note: { fontSize: 12, color: C.faint, lineHeight: "18px" },
			error: { fontSize: 12, color: C.danger, marginTop: 8, whiteSpace: "pre-wrap" },
			status: (ok) => ({ fontSize: 12, color: ok ? C.ok : C.faint, marginLeft: 6 }),
			icon: { width: 16, display: "inline-block", textAlign: "center" }
		};

		/** Run one host Remote call and unwrap its result envelope. */
		function callHost(ctx, method, args, signal) {
			return ctx.connection.rpc.call("/api", `${NAMESPACE}/${method}`, { args: args ?? {} }, signal).then((result) => {
				if (result === undefined || result === null) return undefined;
				if (result.ok === false) {
					const failure = result.error ?? {};
					const error = new Error(failure.message ?? `${method} failed`);
					error.code = failure.code;
					throw error;
				}
				return result.ok === true ? result.value : result;
			});
		}

		/** A single-line text field with a caption. */
		function Field(props) {
			return h("label", { style: styles.field },
				h("span", { style: styles.label }, props.label),
				h("input", {
					style: styles.input,
					type: props.type ?? "text",
					value: props.value ?? "",
					placeholder: props.placeholder ?? "",
					spellCheck: false,
					onChange: (event) => props.onChange(event.target.value)
				})
			);
		}

		/** The connect form shown when no profile exists yet or one is being added. */
		function ConnectForm(props) {
			const [draft, setDraft] = react.useState({ label: "", host: "", port: "22", user: "", identityFile: "", password: "", transport: "openssh" });
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(undefined);
			const set = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }));
			const tailnet = props.tailnet;
			const peers = tailnet !== undefined && tailnet.available === true ? tailnet.peers : [];

			// Picking a peer fills the fields rather than hiding them: MagicDNS names
			// and the tailnet user are a starting point a person still has to confirm.
			const usePeer = (peer) => setDraft((previous) => ({
				...previous,
				host: peer.dnsName !== "" ? peer.dnsName : peer.address,
				user: peer.user === undefined ? previous.user : String(peer.user).split("@")[0],
				label: previous.label === "" ? peer.hostName : previous.label,
				transport: peer.tailscaleSsh ? "tailscale" : "openssh"
			}));

			const submit = () => {
				if (draft.host.trim() === "") { setError(T("error.hostRequired")); return; }
				setBusy(true); setError(undefined);
				props.onConnect({ ...draft, port: Number(draft.port) || 22 })
					.then(() => setBusy(false))
					.catch((reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};

			const peerList = peers.length === 0 ? null : h("div", { style: { marginBottom: 12 } },
				h("div", { style: styles.label }, T("tailnet.peers", { n: peers.length })),
				h("div", { style: { ...styles.row, gap: 6 } },
					peers.slice(0, 8).map((peer) => h("button", {
						key: peer.id,
						title: `${peer.hostName} — ${peer.os}${peer.online ? "" : " (hors ligne)"}${peer.tailscaleSsh ? " — Tailscale SSH" : ""}`,
						style: styles.chip(peer.online === true),
						onClick: () => usePeer(peer)
					}, peer.online === true ? "● " : "○ ", peer.hostName, peer.tailscaleSsh ? " ⚡" : ""))
				),
				h("div", { style: { ...styles.note, marginTop: 4 } }, T("tailnet.legend"))
			);

			const transportPicker = h("div", { style: { ...styles.row, marginBottom: 10 } },
				h("span", { style: { ...styles.label, margin: 0 } }, T("field.transport")),
				["openssh", "tailscale"].map((value) => h("button", {
					key: value,
					style: styles.chip(draft.transport === value),
					onClick: () => set("transport")(value)
				}, value === "openssh" ? T("transport.openssh") : T("transport.tailscale"))),
				h("span", { style: { ...styles.note, flex: "1 1 220px" } },
					draft.transport === "tailscale" ? T("transport.tailscaleHint") : T("transport.opensshHint"))
			);

			return h("div", null,
				peerList,
				transportPicker,
				h("div", { style: { ...styles.row, marginBottom: 10, alignItems: "flex-end" } },
					h(Field, { label: T("field.label"), value: draft.label, onChange: set("label"), placeholder: T("placeholder.label") }),
					h(Field, { label: T("field.host"), value: draft.host, onChange: set("host"), placeholder: T("placeholder.host") }),
					h("div", { style: { flex: "0 0 90px" } }, h(Field, { label: T("field.port"), value: draft.port, onChange: set("port") }))
				),
				h("div", { style: { ...styles.row, marginBottom: 10, alignItems: "flex-end" } },
					h(Field, { label: T("field.user"), value: draft.user, onChange: set("user"), placeholder: T("placeholder.user") }),
					h(Field, { label: T("field.key"), value: draft.identityFile, onChange: set("identityFile"), placeholder: T("placeholder.key") }),
					h(Field, { label: T("field.password"), value: draft.password, onChange: set("password"), type: "password" })
				),
				h("div", { style: styles.row },
					h("button", { style: styles.button(true, busy), onClick: submit, disabled: busy }, busy ? T("action.connecting") : T("action.connect")),
					props.onCancel === undefined ? null : h("button", { style: styles.button(false, false), onClick: props.onCancel }, T("action.cancel"))
				),
				error === undefined ? null : h("div", { style: styles.error }, error),
				h("div", { style: { ...styles.note, marginTop: 10 } }, T("connect.note"))
			);
		}

		/**
		 * The local directory browser.
		 *
		 * Occupying the workspace hole means owning the whole flow, so the local
		 * half is this plugin's responsibility too. It talks to whichever
		 * directory-picking backend the deployment composed: `list` and
		 * `createDirectory` come from the in-app browser, `pick` from the OS
		 * chooser, and a deployment offers one or the other.
		 */
		function LocalBrowser(props) {
			const ctx = props.ctx;
			const [state, setState] = react.useState({ loading: false, error: undefined, path: undefined, entries: [], home: undefined, browsable: true });
			const abort = react.useRef(undefined);

			const load = react.useCallback((path) => {
				abort.current?.abort();
				const controller = new AbortController();
				abort.current = controller;
				setState((previous) => ({ ...previous, loading: true, error: undefined }));
				ctx.remote.directoryPicker.list(path, controller.signal).then((listing) => {
					setState({ loading: false, error: undefined, path: listing.path, entries: listing.entries, home: listing.home, browsable: true });
					props.onPathChange(listing.path);
				}).catch((reason) => {
					if (controller.signal.aborted) return;
					// No in-app browser in this deployment: the OS chooser is the only
					// local affordance, and saying so beats an empty list.
					setState({ loading: false, error: undefined, path: undefined, entries: [], home: undefined, browsable: false });
					void reason;
				});
			}, [ctx]);

			react.useEffect(() => { load(undefined); return () => abort.current?.abort(); }, [load]);

			const parentOf = (path) => {
				if (path === undefined || path === "/") return undefined;
				const cut = path.slice(0, path.lastIndexOf("/"));
				return cut === "" ? "/" : cut;
			};
			const createFolder = () => {
				const name = props.newFolder;
				props.onNewFolder(undefined);
				if (name === undefined || name.trim() === "") return;
				ctx.remote.directoryPicker.createDirectory(state.path, name).then(() => load(state.path))
					.catch((reason) => setState((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : String(reason) })));
			};

			if (state.browsable !== true) {
				return h("div", null,
					h("div", { style: styles.note }, T("local.systemChooser")),
					h("div", { style: { marginTop: 12 } }, h("button", { style: styles.button(true, props.busy), onClick: props.onPickSystem, disabled: props.busy }, T("action.chooseFolder")))
				);
			}

			const rows = [];
			if (state.path !== undefined && state.path !== "/") {
				rows.push(h("button", { key: "..", style: styles.item(true), onClick: () => load(parentOf(state.path)) }, h("span", { style: styles.icon }, "↰"), h("span", null, "..")));
			}
			for (const entry of state.entries) {
				const isDir = entry.type === "directory";
				rows.push(h("button", {
					key: entry.path,
					style: styles.item(isDir),
					disabled: !isDir,
					onClick: () => (isDir ? load(entry.path) : undefined)
				}, h("span", { style: styles.icon }, isDir ? "📁" : "📄"), h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.name)));
			}

			return h("div", null,
				h("div", { style: styles.crumbs },
					state.path === undefined ? null : h("button", { style: styles.crumb, onClick: () => load(undefined) }, state.home ?? "/"),
					state.loading ? h("span", { style: { marginLeft: 8 } }, "…") : null
				),
				h("div", { style: { ...styles.row, marginTop: 8 } },
					h("button", { style: styles.button(false, false), onClick: () => props.onNewFolder("") }, T("action.newFolder")),
					props.newFolder === undefined ? null : h("span", { style: { ...styles.row, flex: "1 1 220px" } },
						h("input", {
							autoFocus: true, style: { ...styles.input, flex: 1 }, value: props.newFolder, placeholder: T("placeholder.folderName"),
							onChange: (event) => props.onNewFolder(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") createFolder(); if (event.key === "Escape") props.onNewFolder(undefined); }
						}),
						h("button", { style: styles.button(true, false), onClick: createFolder }, T("action.create"))
					)
				),
				h("div", { style: styles.list }, rows.length === 0 ? h("div", { style: { ...styles.note, padding: 12 } }, state.loading ? T("state.loading") : T("state.emptyFolder")) : rows),
				state.error === undefined ? null : h("div", { style: styles.error }, state.error)
			);
		}

		/** The remote directory browser: profile chips, breadcrumbs, entries. */
		function RemoteBrowser(props) {
			const ctx = props.ctx;
			const [state, setState] = react.useState({ loading: false, error: undefined, path: undefined, entries: [], crumbs: [], home: undefined, localPath: undefined, selected: undefined });
			const [newFolder, setNewFolder] = react.useState(undefined);
			const abort = react.useRef(undefined);

			const load = react.useCallback((path) => {
				abort.current?.abort();
				const controller = new AbortController();
				abort.current = controller;
				setState((previous) => ({ ...previous, loading: true, error: undefined, selected: undefined }));
				callHost(ctx, "list", { id: props.profileId, path }, controller.signal)
					.then((listing) => setState({ loading: false, error: undefined, path: listing.path, entries: listing.entries, crumbs: listing.crumbs, home: listing.home, localPath: listing.localPath, selected: undefined }))
					.catch((reason) => {
						if (controller.signal.aborted) return;
						setState((previous) => ({ ...previous, loading: false, error: reason instanceof Error ? reason.message : String(reason) }));
					});
			}, [ctx, props.profileId]);

			react.useEffect(() => { load(undefined); return () => abort.current?.abort(); }, [load]);
			react.useEffect(() => { props.onPathChange(state.path); }, [state.path]);

			const parentOf = (path) => {
				if (path === undefined || path === "/") return undefined;
				const cut = path.slice(0, path.lastIndexOf("/"));
				return cut === "" ? "/" : cut;
			};

			const createFolder = () => {
				const name = newFolder;
				setNewFolder(undefined);
				if (name === undefined || name.trim() === "") return;
				callHost(ctx, "makeDirectory", { id: props.profileId, path: state.path, name })
					.then(() => load(state.path))
					.catch((reason) => setState((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : String(reason) })));
			};

			const rows = [];
			if (state.path !== undefined && state.path !== "/") {
				rows.push(h("button", { key: "..", style: styles.item(true), onClick: () => load(parentOf(state.path)) },
					h("span", { style: styles.icon }, "↰"), h("span", null, "..")));
			}
			for (const entry of state.entries) {
				const isDir = entry.type === "directory";
				rows.push(h("button", {
					key: entry.path,
					style: { ...styles.item(isDir), background: state.selected === entry.path ? C.hover : "transparent" },
					disabled: !isDir,
					onClick: () => (isDir ? load(entry.path) : undefined)
				},
					h("span", { style: styles.icon }, isDir ? "📁" : "📄"),
					h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.name)
				));
			}

			return h("div", null,
				h("div", { style: { ...styles.row, marginBottom: 10 } },
					props.profiles.map((profile) => h("button", {
						key: profile.id,
						style: styles.chip(profile.id === props.profileId),
						title: `${profile.user === "" ? "" : `${profile.user}@`}${profile.host}:${profile.port}`,
						onClick: () => props.onSelectProfile(profile.id)
					}, profile.label, profile.transport === "tailscale" ? " ⚡" : (profile.tailnet === true ? " 🌐" : ""))),
					h("button", { style: styles.chip(false), onClick: props.onAddProfile }, T("action.addServer"))
				),
				h("div", { style: styles.crumbs },
					(state.crumbs ?? []).map((crumb, index) => h(react.Fragment, { key: crumb.path },
						index > 0 ? h("span", null, " / ") : null,
						h("button", { style: styles.crumb, onClick: () => load(crumb.path) }, crumb.name)
					)),
					state.loading ? h("span", { style: { marginLeft: 8 } }, "…") : null
				),
				h("div", { style: { ...styles.row, marginTop: 8 } },
					h("button", { style: styles.button(false, false), onClick: () => setNewFolder("") }, T("action.newFolder")),
					newFolder === undefined ? null : h("span", { style: { ...styles.row, flex: "1 1 220px" } },
						h("input", {
							autoFocus: true, style: { ...styles.input, flex: 1 }, value: newFolder, placeholder: T("placeholder.folderName"),
							onChange: (event) => setNewFolder(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") createFolder(); if (event.key === "Escape") setNewFolder(undefined); }
						}),
						h("button", { style: styles.button(true, false), onClick: createFolder }, T("action.create"))
					)
				),
				h("div", { style: styles.list }, rows.length === 0 ? h("div", { style: { ...styles.note, padding: 12 } }, state.loading ? T("state.loading") : T("state.emptyFolder")) : rows),
				state.error === undefined ? null : h("div", { style: styles.error }, state.error),
				state.localPath === undefined ? null : h("div", { style: { ...styles.note, marginTop: 8 } }, T("mirror.local", { path: state.localPath }))
			);
		}

		/**
		 * The directory-flow occupant. Renders the local/remote chooser inside the
		 * hole ui-workspace opens from its "Add workspace" affordance.
		 */
		function RemoteDirectoryFlow(props) {
			const ctx = props.ctx;
			const [tab, setTab] = react.useState("remote");
			const [status, setStatus] = react.useState(undefined);
			const [profileId, setProfileId] = react.useState(undefined);
			const [adding, setAdding] = react.useState(false);
			const [path, setPath] = react.useState(undefined);
			const [newFolder, setNewFolder] = react.useState(undefined);
			const [error, setError] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);

			const refresh = react.useCallback(() => {
				callHost(ctx, "status", {}).then((value) => {
					setStatus(value);
					setProfileId((current) => current ?? value.profiles[0]?.id);
				}).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
			}, [ctx]);

			react.useEffect(() => {
				if (props.open !== true) return undefined;
				setError(undefined); setAdding(false); setPath(undefined);
				refresh();
				return undefined;
			}, [props.open, refresh]);

			if (props.open !== true) return null;

			const profiles = status?.profiles ?? [];
			const close = () => props.onCancel();
			const pickLocal = () => {
				setBusy(true);
				ctx.uiWorkspace.pickDirectory().then((chosen) => {
					setBusy(false);
					if (chosen === null || chosen === undefined) return;
					props.onPicked(chosen);
				}).catch((reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};
			const adopt = () => {
				setBusy(true);
				callHost(ctx, "adopt", { id: profileId, path, title: undefined })
					.then((result) => { setBusy(false); props.onPicked(result.localPath); })
					.catch((reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};
			const connect = (draft) => callHost(ctx, "connect", { input: draft }).then((result) => {
				if (result.report !== undefined && result.report.ok !== true) throw new Error(result.report.error ?? T("error.refused"));
				setAdding(false);
				refresh();
				setProfileId(result.profile?.id);
			});

			const body = tab === "local"
				? h("div", null,
					h("div", { style: styles.row },
						h("button", { style: styles.button(false, busy), onClick: pickLocal, disabled: busy }, T("action.systemPicker")),
						h("span", { style: { ...styles.note, flex: "1 1 220px" } }, T("local.browseHint"))
					),
					error === undefined ? null : h("div", { style: { ...styles.error, marginTop: 8 } }, error),
					h("div", { style: { marginTop: 10 } }, h(LocalBrowser, {
						ctx,
						busy,
						newFolder,
						onNewFolder: setNewFolder,
						onPathChange: setPath,
						onPickSystem: pickLocal
					}))
				)
				: status?.enabled === false
					? h("div", { style: styles.note }, T("disabled.notice"))
					: adding || profiles.length === 0
						? h(ConnectForm, { onConnect: connect, onCancel: profiles.length === 0 ? undefined : () => setAdding(false), tailnet: status?.tailnet })
						: h(RemoteBrowser, {
							ctx,
							profileId,
							profiles,
							onSelectProfile: (id) => { setProfileId(id); setPath(undefined); },
							onAddProfile: () => setAdding(true),
							onPathChange: setPath
						});

			return h("div", { style: styles.overlay, onMouseDown: (event) => { if (event.target === event.currentTarget) close(); } },
				h("div", { style: styles.dialog },
					h("div", { style: styles.head },
						h("span", { style: styles.title }, T("dialog.title")),
						h("button", { style: styles.button(false, false), onClick: close }, "✕")
					),
					h("div", { style: styles.tabs },
						h("button", { style: styles.tab(tab === "local"), onClick: () => setTab("local") }, T("tab.local")),
						h("button", { style: styles.tab(tab === "remote"), onClick: () => setTab("remote") }, T("tab.remote"))
					),
					h("div", { style: styles.body }, body, error === undefined ? null : h("div", { style: styles.error }, error)),
					h("div", { style: styles.foot },
						h("span", { style: { flex: 1, ...styles.note } },
							path === undefined ? "" : tab === "remote" ? T("footer.remoteFolder", { path }) : T("footer.localFolder", { path })),
						tab === "remote" && profiles.length > 0 && !adding && status?.enabled !== false
							? h("button", { style: styles.button(true, busy || path === undefined), disabled: busy || path === undefined, onClick: adopt }, busy ? T("action.adding") : T("action.use"))
							: tab === "local" && path !== undefined
								? h("button", { style: styles.button(true, busy), disabled: busy, onClick: () => props.onPicked(path) }, T("action.use"))
								: null,
						h("button", { style: styles.button(false, false), onClick: close }, T("action.close"))
					)
				)
			);
		}

		/** The launcher button, always reachable from the sidebar foot. */
		function RemoteLauncher(props) {
			const ctx = props.ctx;
			const [open, setOpen] = react.useState(false);
			const openPanel = () => {
				props.onOpenPanel?.();
				setOpen(true);
			};
			return h(react.Fragment, null,
				h("button", {
					type: "button",
					title: T("tab.remote"),
					"aria-label": T("tab.remote"),
					onClick: openPanel,
					style: {
						cursor: "pointer", border: "none", background: "transparent", color: C.dim,
						display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 8px",
						borderRadius: 8, fontSize: 13, fontFamily: FONT
					}
				}, h("span", null, "🖥"), props.wide === true ? h("span", null, T("launcher.label")) : null),
				open ? h(RemoteDirectoryFlow, {
					ctx,
					open: true,
					busy: false,
					onPicked: (chosen) => { setOpen(false); props.onPickedWorkspace?.(chosen); },
					onCancel: () => setOpen(false),
					onError: (message) => { setOpen(false); props.onError?.(message); }
				}) : null
			);
		}

		/** Settings -> Plugins card for the `remote-ssh` namespace. */
		function SshSettingsCard(props) {
			const ctx = props.ctx;
			const [status, setStatus] = react.useState(undefined);
			const [error, setError] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const [checking, setChecking] = react.useState(false);
			const [work, setWork] = react.useState([]);
			const refreshWork = react.useCallback(() => {
				callHost(ctx, "work", {}).then((value) => setWork(value?.sessions ?? [])).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
			}, [ctx]);
			react.useEffect(() => { refreshWork(); }, [refreshWork]);
			const refresh = react.useCallback(() => {
				callHost(ctx, "status", {}).then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
			}, [ctx]);
			react.useEffect(() => { refresh(); }, [refresh]);
			// Tailscale is optional, and it may be installed long after the plugin
			// was. This re-reads the host environment on demand, so adopting it
			// never means reinstalling the plugin or restarting the harness.
			const recheck = () => {
				setChecking(true);
				setError(undefined);
				callHost(ctx, "status", {}).then((value) => { setStatus(value); setChecking(false); })
					.catch((reason) => { setChecking(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};
			const toggle = () => {
				setBusy(true);
				callHost(ctx, "setEnabled", { enabled: status?.enabled !== true }).then((value) => { setStatus(value); setBusy(false); })
					.catch((reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};
			const forget = (id) => {
				callHost(ctx, "disconnect", { id }).then(() => refresh()).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
			};
			return h("li", { style: { listStyle: "none", border: `0.5px solid ${C.border}`, borderRadius: 12, padding: 14, fontFamily: FONT, color: C.text } },
				h("div", { style: styles.row },
					h("div", { style: { flex: 1 } },
						h("div", { style: { fontSize: 14, fontWeight: 600 } }, T("settings.title")),
						h("div", { style: styles.note }, T("settings.description"))
					),
					h("button", { style: styles.button(status?.enabled === true, busy), onClick: toggle, disabled: busy },
						status?.enabled === true ? T("settings.enabled") : T("settings.disabled"))
				),
				h("div", { style: { ...styles.row, marginTop: 12, paddingTop: 10, borderTop: `0.5px solid ${C.border}` } },
					h("span", { style: { ...styles.note, flex: 1 } },
						T("settings.tailscale"),
						": ",
						status?.tailnet?.available === true
							? h("span", { style: styles.status(true) }, "● ", T("settings.tailscaleAvailable"), status.tailnet.version === undefined ? "" : ` ${status.tailnet.version}`)
							: h("span", { style: styles.status(false) }, "○ ", T("settings.tailscaleMissing"))
					),
					h("button", { style: styles.button(false, checking), onClick: recheck, disabled: checking },
						checking ? T("state.checking") : T("action.recheck"))
				),
				h("div", { style: { ...styles.note, marginTop: 4 } },
					status?.tailnet?.available === true ? T("settings.tailscaleNote") : T("settings.tailscaleHint")),
				h("div", { style: { marginTop: 12, paddingTop: 10, borderTop: `0.5px solid ${C.border}` } },
					h("div", { style: styles.row },
						h("span", { style: { ...styles.note, flex: 1 } }, h("strong", { style: { color: C.text } }, T("settings.work")),
							" ", dim(T("settings.workKeeps"))),
						h("button", { style: styles.button(false, checking), onClick: refreshWork, disabled: checking }, T("action.refresh")),
						work.length === 0 ? null : h("button", { style: styles.button(false, false), onClick: () => callHost(ctx, "workForget", { id: undefined, finishedOnly: true }).then(refreshWork) }, T("action.forgetFinished"))
					),
					work.length === 0 ? h("div", { style: { ...styles.note, marginTop: 6 } }, T("settings.workEmpty"))
						: h("ul", { style: { margin: "8px 0 0", padding: 0 } }, work.map((entry) => h("li", {
							key: entry.id,
							style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13, listStyle: "none" }
						},
							h("span", { style: styles.status(entry.state === "running") }, entry.state === "running" ? "●" : "○"),
							h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								entry.label,
								h("span", { style: styles.note }, `  ${T(STATE_LABEL[entry.state] ?? "state.unknown")}${entry.tail === undefined || entry.tail === "" ? "" : ` · ${entry.tail.slice(0, 60)}`}`)
							),
							entry.state === "running"
								? h("button", { style: styles.button(false, false), onClick: () => callHost(ctx, "workStop", { id: entry.id }).then(refreshWork) }, T("action.stop"))
								: null
						)))
				),
				status?.profiles?.length > 0 ? h("ul", { style: { margin: "12px 0 0", padding: 0 } },
					status.profiles.map((profile) => h("li", {
						key: profile.id,
						style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, listStyle: "none" }
					},
						h("span", { style: styles.status(profile.platform !== undefined) }, profile.platform !== undefined ? "●" : "○"),
						h("span", { style: { flex: 1 } }, profile.label, h("span", { style: styles.note }, `  ${profile.user === "" ? "" : `${profile.user}@`}${profile.host}:${profile.port}`)),
						h("button", { style: styles.button(false, false), onClick: () => forget(profile.id) }, T("action.forget"))
					))
				) : h("div", { style: { ...styles.note, marginTop: 8 } }, T("settings.empty")),
				error === undefined ? null : h("div", { style: styles.error }, error)
			);
		}

		/**
		 * A session state to its locale key.
		 *
		 * Spelled out rather than composed from the state name: a key built at
		 * runtime is invisible to the gate that proves every locale carries every
		 * string, which is the check that keeps a translation from silently
		 * disappearing.
		 */
		const STATE_LABEL = { running: "state.running", exited: "state.exited", gone: "state.gone", unknown: "state.unknown" };

		/** Cordis plugin body: register the occupant, the launcher, and the card. */
		/**
		 * Priority for the two workspace-hole occupants.
		 *
		 * A `single` slot refuses two registrations at the SAME priority — it throws
		 * rather than shadowing — and the LOWEST priority renders. The shipped
		 * directory picker registers at the default 0, so the plugin's chooser asks
		 * for -1 and wins, which is what makes "local machine or SSH" one dialog.
		 * Without it the plugin failed to load entirely, and the whole UI went with
		 * it.
		 */
		const DIRECTORY_FLOW_PRIORITY = -1;

		/**
		 * Register without letting one refused slot take the plugin down.
		 *
		 * The launcher and the Settings card are the fallbacks: if a hole is
		 * occupied at a priority this plugin did not expect, the remote feature
		 * stays reachable from the sidebar instead of disappearing behind a
		 * "Failed to load plugins" page.
		 */
		function registerSafely(ctx, options, Component) {
			try {
				return ctx.slots.register(options, Component);
			} catch (error) {
				console.warn(`[dsh-remote-ssh] ${options.name} was not registered: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		}

		/** Cordis plugin body: the chooser, the launcher, and the Settings card. */
		function apply(ctx) {
			// Register first, then bind: the dictionaries are what `translate`
			// resolves against, and the shell may render a slot synchronously as
			// soon as it is registered below.
			ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-remote-ssh: locale dictionaries");
			translate = ctx.locale.bind(NS);

			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				const injected = () => ({ ctx });
				yield registerSafely(ctx, { name: "conversation.hero.workspace.directoryFlow", priority: DIRECTORY_FLOW_PRIORITY, inject: injected }, RemoteDirectoryFlow);
				yield registerSafely(ctx, { name: "sidebar.workspaces.directoryFlow", priority: DIRECTORY_FLOW_PRIORITY, inject: injected }, RemoteDirectoryFlow);
			}));
			ctx.slots.inject("sidebar.footer.action", () => registerSafely(ctx, {
				name: "sidebar.footer.action",
				inject: () => ({ ctx })
			}, RemoteLauncher));
			ctx.slots.inject("settings.plugin.item", () => registerSafely(ctx, {
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				inject: () => ({ ctx })
			}, SshSettingsCard));
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection", "locale", "uiWorkspace", "remote.directoryPicker"];
		return module.exports;
	}
});
