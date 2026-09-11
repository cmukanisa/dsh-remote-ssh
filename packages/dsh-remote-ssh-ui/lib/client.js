window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-remote-ssh-ui",
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
			const [draft, setDraft] = react.useState({ label: "", host: "", port: "22", user: "", identityFile: "", password: "" });
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(undefined);
			const set = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }));
			const submit = () => {
				if (draft.host.trim() === "") { setError("L'hôte est obligatoire."); return; }
				setBusy(true); setError(undefined);
				props.onConnect({ ...draft, port: Number(draft.port) || 22 })
					.then(() => setBusy(false))
					.catch((reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
			};
			return h("div", null,
				h("div", { style: { ...styles.row, marginBottom: 10, alignItems: "flex-end" } },
					h(Field, { label: "Nom (optionnel)", value: draft.label, onChange: set("label"), placeholder: "prod" }),
					h(Field, { label: "Hôte", value: draft.host, onChange: set("host"), placeholder: "10.0.0.4 ou mon-serveur" }),
					h("div", { style: { flex: "0 0 90px" } }, h(Field, { label: "Port", value: draft.port, onChange: set("port") }))
				),
				h("div", { style: { ...styles.row, marginBottom: 10, alignItems: "flex-end" } },
					h(Field, { label: "Utilisateur", value: draft.user, onChange: set("user"), placeholder: "root" }),
					h(Field, { label: "Clé privée (chemin local)", value: draft.identityFile, onChange: set("identityFile"), placeholder: "~/.ssh/id_ed25519" }),
					h(Field, { label: "Mot de passe (optionnel)", value: draft.password, onChange: set("password"), type: "password" })
				),
				h("div", { style: styles.row },
					h("button", { style: styles.button(true, busy), onClick: submit, disabled: busy }, busy ? "Connexion…" : "Se connecter"),
					props.onCancel === undefined ? null : h("button", { style: styles.button(false, false), onClick: props.onCancel }, "Annuler")
				),
				error === undefined ? null : h("div", { style: styles.error }, error),
				h("div", { style: { ...styles.note, marginTop: 10 } },
					"L'authentification par clé utilise votre agent SSH et votre ~/.ssh/config. Le mot de passe nécessite ",
					h("code", null, "sshpass"), " sur cette machine et n'est stocké que dans $DSH_HOME/remotes.json (chmod 600)."
				)
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
					}, profile.label)),
					h("button", { style: styles.chip(false), onClick: props.onAddProfile }, "＋ Serveur")
				),
				h("div", { style: styles.crumbs },
					(state.crumbs ?? []).map((crumb, index) => h(react.Fragment, { key: crumb.path },
						index > 0 ? h("span", null, " / ") : null,
						h("button", { style: styles.crumb, onClick: () => load(crumb.path) }, crumb.name)
					)),
					state.loading ? h("span", { style: { marginLeft: 8 } }, "…") : null
				),
				h("div", { style: { ...styles.row, marginTop: 8 } },
					h("button", { style: styles.button(false, false), onClick: () => setNewFolder("") }, "＋ Nouveau dossier"),
					newFolder === undefined ? null : h("span", { style: { ...styles.row, flex: "1 1 220px" } },
						h("input", {
							autoFocus: true, style: { ...styles.input, flex: 1 }, value: newFolder, placeholder: "nom-du-dossier",
							onChange: (event) => setNewFolder(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") createFolder(); if (event.key === "Escape") setNewFolder(undefined); }
						}),
						h("button", { style: styles.button(true, false), onClick: createFolder }, "Créer")
					)
				),
				h("div", { style: styles.list }, rows.length === 0 ? h("div", { style: { ...styles.note, padding: 12 } }, state.loading ? "Chargement…" : "(dossier vide)") : rows),
				state.error === undefined ? null : h("div", { style: styles.error }, state.error),
				state.localPath === undefined ? null : h("div", { style: { ...styles.note, marginTop: 8 } }, "Miroir local : ", h("code", null, state.localPath))
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
				if (result.report !== undefined && result.report.ok !== true) throw new Error(result.report.error ?? "connexion refusée");
				setAdding(false);
				refresh();
				setProfileId(result.profile?.id);
			});

			const body = tab === "local"
				? h("div", null,
					h("div", { style: styles.note }, "Ouvre le sélecteur de dossiers de votre machine. Le dossier choisi devient un workspace local."),
					h("div", { style: { marginTop: 12 } }, h("button", { style: styles.button(true, busy), onClick: pickLocal, disabled: busy }, "Choisir un dossier local…"))
				)
				: status?.enabled === false
					? h("div", { style: styles.note }, "Le module SSH distant est désactivé. Activez-le dans Paramètres → Plugins → « remote-ssh ».")
					: adding || profiles.length === 0
						? h(ConnectForm, { onConnect: connect, onCancel: profiles.length === 0 ? undefined : () => setAdding(false) })
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
						h("span", { style: styles.title }, "Ajouter un workspace"),
						h("button", { style: styles.button(false, false), onClick: close }, "✕")
					),
					h("div", { style: styles.tabs },
						h("button", { style: styles.tab(tab === "local"), onClick: () => setTab("local") }, "Cet ordinateur"),
						h("button", { style: styles.tab(tab === "remote"), onClick: () => setTab("remote") }, "Serveur distant (SSH)")
					),
					h("div", { style: styles.body }, body, error === undefined ? null : h("div", { style: styles.error }, error)),
					h("div", { style: styles.foot },
						h("span", { style: { flex: 1, ...styles.note } },
							tab === "remote" && path !== undefined ? `Dossier distant : ${path}` : ""),
						tab === "remote" && profiles.length > 0 && !adding && status?.enabled !== false
							? h("button", { style: styles.button(true, busy || path === undefined), disabled: busy || path === undefined, onClick: adopt }, busy ? "Ajout…" : "Utiliser ce dossier")
							: null,
						h("button", { style: styles.button(false, false), onClick: close }, "Fermer")
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
					title: "Serveur distant (SSH)",
					"aria-label": "Serveur distant (SSH)",
					onClick: openPanel,
					style: {
						cursor: "pointer", border: "none", background: "transparent", color: C.dim,
						display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 8px",
						borderRadius: 8, fontSize: 13, fontFamily: FONT
					}
				}, h("span", null, "🖥"), props.wide === true ? h("span", null, "Serveur distant") : null),
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
			const refresh = react.useCallback(() => {
				callHost(ctx, "status", {}).then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
			}, [ctx]);
			react.useEffect(() => { refresh(); }, [refresh]);
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
						h("div", { style: { fontSize: 14, fontWeight: 600 } }, "Workspaces distants (SSH)"),
						h("div", { style: styles.note }, "Connectez des serveurs, choisissez un dossier distant et travaillez dedans avec tous les outils.")
					),
					h("button", { style: styles.button(status?.enabled === true, busy), onClick: toggle, disabled: busy },
						status?.enabled === true ? "Activé" : "Désactivé")
				),
				status?.profiles?.length > 0 ? h("ul", { style: { margin: "12px 0 0", padding: 0 } },
					status.profiles.map((profile) => h("li", {
						key: profile.id,
						style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, listStyle: "none" }
					},
						h("span", { style: styles.status(profile.platform !== undefined) }, profile.platform !== undefined ? "●" : "○"),
						h("span", { style: { flex: 1 } }, profile.label, h("span", { style: styles.note }, `  ${profile.user === "" ? "" : `${profile.user}@`}${profile.host}:${profile.port}`)),
						h("button", { style: styles.button(false, false), onClick: () => forget(profile.id) }, "Oublier")
					))
				) : h("div", { style: { ...styles.note, marginTop: 8 } }, "Aucun serveur connecté pour l'instant."),
				error === undefined ? null : h("div", { style: styles.error }, error)
			);
		}

		/** Cordis plugin body: register the occupant, the launcher, and the card. */
		function apply(ctx) {
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				const injected = () => ({ ctx });
				yield ctx.slots.register({ name: "conversation.hero.workspace.directoryFlow", inject: injected }, RemoteDirectoryFlow);
				yield ctx.slots.register({ name: "sidebar.workspaces.directoryFlow", inject: injected }, RemoteDirectoryFlow);
			}));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				inject: () => ({ ctx })
			}, RemoteLauncher));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				inject: () => ({ ctx })
			}, SshSettingsCard));
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection", "uiWorkspace"];
		return module.exports;
	}
});
