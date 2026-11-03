// src/client.ts
var S1_ORIGIN = "https://api.search1api.com";
/** Tells Search1API which integration a request came from. */
var USER_AGENT = `search1api-buzz/0.3.0`;
var S1Error = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.name = "S1Error";
		this.kind = kind;
	}
};
/**
* Calls to Search1API through the host's declared-origin HTTP client. The key is read when a
* call starts and goes nowhere but the Authorization header: not in a URL, an error message
* or a log line.
*/
function createClient(transport, readKey) {
	async function call(path, init, candidate) {
		const key = candidate ?? await readKey();
		if (!key) throw new S1Error("no-key", "No Search1API key is saved in this app yet. Ask the owner to add one in Settings → Plugins → Search1API.");
		let response;
		try {
			response = await transport({
				url: `${S1_ORIGIN}${path}`,
				method: init.method,
				headers: {
					authorization: `Bearer ${key}`,
					accept: "application/json",
					"user-agent": USER_AGENT,
					...init.body === void 0 ? {} : { "content-type": "application/json" }
				},
				...init.body === void 0 ? {} : { body: JSON.stringify(init.body) },
				...init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}
			});
		} catch {
			throw new S1Error("network", "Could not reach Search1API.");
		}
		return parse(response);
	}
	return {
		/** Checks a key (the saved one, or `candidate`) without spending credits. */
		usage: async (candidate) => {
			const body = await call("/usage", { method: "GET" }, candidate);
			return { credits: typeof body.usage === "number" && Number.isFinite(body.usage) ? body.usage : null };
		},
		post: (path, body, timeoutMs) => call(path, {
			method: "POST",
			body,
			...timeoutMs ? { timeoutMs } : {}
		})
	};
}
/** Search1API's own message for a refused request. It never repeats the key; it is still cut short. */
function apiMessage(body) {
	const text = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : void 0;
	return text ? text.replace(/\s+/g, " ").trim().slice(0, 300) : void 0;
}
function parse(response) {
	let body;
	try {
		body = JSON.parse(response.body);
	} catch {
		body = void 0;
	}
	const errorBody = body && typeof body === "object" ? body : void 0;
	const { status } = response;
	if (status === 401) throw new S1Error("auth", "Search1API did not accept the API key.");
	if (status === 402) throw new S1Error("credits", `${apiMessage(errorBody) ?? "This Search1API account is out of credits."} Top up at https://s1.dev/pricing.`);
	if (status === 403) throw new S1Error("auth", apiMessage(errorBody) ?? "Search1API refused this key.");
	if (status === 429) throw new S1Error("rate-limited", "Search1API is rate limiting this key. Try again in a moment.");
	if (status >= 500) throw new S1Error("server", `Search1API is having trouble right now (${status}).`);
	if (status < 200 || status >= 300) throw new S1Error("rejected", apiMessage(errorBody) ?? `Search1API refused the request (${status}).`);
	if (!errorBody) throw new S1Error("server", "Search1API answered with an unexpected response.");
	return body;
}
// src/keys.ts
var KEY = "search1api.buzz.api-key.v1";
/** How each store is driven, and what a save that is not confirmed means there. */
var STORES = {
	keychain: {
		read: "keychain-read",
		save: "keychain-save",
		delete: "keychain-delete",
		input: (value) => `${value}\n${value}\n`,
		plainFallback: false
	},
	"secret-service": {
		read: "secret-read",
		save: "secret-save",
		delete: "secret-delete",
		input: (value) => value,
		plainFallback: true
	}
};
/** What the card calls each store. */
var STORE_NAME = {
	keychain: "your Keychain",
	"secret-service": "the system secret store (Secret Service)"
};
/** Which store this system has, from what the page says it runs on. */
function detectStore(platform, userAgent) {
	const [p, ua] = [platform ?? "", userAgent ?? ""];
	if (/^Mac/i.test(p) || /Macintosh/.test(ua)) return "keychain";
	if ((/^Linux/i.test(p) || /Linux/.test(ua)) && !/Android/i.test(ua)) return "secret-service";
}
var withoutLineBreak = (text) => text?.replace(/\r?\n$/, "");
function createKeyStore(storage, { run, store } = {}) {
	const listeners = /* @__PURE__ */ new Set();
	let version = 0;
	const notify = (restart) => {
		if (restart) version += 1;
		listeners.forEach((listener) => listener());
	};
	const kind = run !== void 0 ? store : void 0;
	const driver = kind ? STORES[kind] : void 0;
	const secret = (command, input) => run ? run(command, input).catch(() => null) : Promise.resolve(null);
	const profileCopy = () => {
		try {
			return storage.getItem(KEY) || void 0;
		} catch {
			return;
		}
	};
	const dropProfileCopy = () => {
		try {
			storage.removeItem(KEY);
		} catch {}
	};
	let key;
	let place;
	let tail = Promise.resolve();
	const serial = (task) => {
		const next = tail.then(task, task);
		tail = next.catch(() => void 0);
		return next;
	};
	const readStore = async () => driver ? withoutLineBreak(await secret(driver.read)) || void 0 : void 0;
	/** Puts a key in the store and reads it back to be sure: the program's own exit status is not trusted to say. */
	async function toStore(value) {
		if (!driver) return false;
		await secret(driver.save, driver.input(value));
		if (await readStore() !== value) return false;
		dropProfileCopy();
		return true;
	}
	/**
	* Looks for the key: the store first, then the profile. A key in the profile where there is a store is moved to it. When both
	* hold a key and they differ, which is newer depends on the system. Where a key that the store would not take is kept in the
	* profile (Linux: `plainFallback`), the profile's is the newer one, written while the store could not be reached, so it is moved
	* over the store's with the same read-back, the older key staying in the store until the read-back says the newer one is there.
	* Where nothing is ever kept in the profile (a Mac), a copy there is always an older one, from an earlier version or from a move
	* that did not work, and the key the person put in the store since wins, whatever tool put it there; the old plain copy goes.
	*/
	async function load(initial) {
		const [before, placeBefore] = [key, place];
		const kept = await readStore();
		const plain = profileCopy();
		const profileIsNewer = driver?.plainFallback === true;
		if (kept && (plain === void 0 || plain === kept || !profileIsNewer)) {
			[key, place] = [kept, kind];
			if (plain !== void 0) dropProfileCopy();
		} else if (plain !== void 0) {
			[key, place] = [plain, "profile"];
			if (driver && await toStore(plain)) place = kind;
		} else [key, place] = [void 0, void 0];
		if (initial || key !== before || place !== placeBefore) notify(!initial && key !== before);
	}
	let started;
	const begin = () => started ??= serial(() => load(true));
	return {
		/** Changes whenever the key is another one, for effects that must start over. */
		version: () => version,
		/** Settles when the first look for the key (and the move out of the profile) is over; asking for it makes the look. */
		get ready() {
			return begin();
		},
		/** Looks again (the store may have been given the key from outside). */
		reload: () => {
			begin();
			return serial(() => load(false));
		},
		/** The saved key, for the client only. Nothing else should hold on to it. */
		read: () => key,
		has: () => key !== void 0,
		place: () => place,
		/** The store this system has and the plugin can drive, if any. */
		store: () => kind,
		/**
		* Keeps a key, in the store where there is one, otherwise in the profile as plain text. When the store does not confirm it:
		* on a Mac nothing is kept (`kept: false`, a saved key unchanged); on Linux the key goes to the profile, labelled
		* (`degraded: true`), unless the store already holds a key, which a plain copy would only shadow (`kept: false`).
		*/
		save: (value) => {
			begin();
			return serial(async () => {
				let degraded = false;
				if (driver) {
					if (await toStore(value)) [key, place] = [value, kind];
					else if (driver.plainFallback && place !== kind) {
						storage.setItem(KEY, value);
						[key, place] = [value, "profile"];
						degraded = true;
					} else return {
						kept: false,
						degraded: false
					};
				} else {
					storage.setItem(KEY, value);
					[key, place] = [value, "profile"];
				}
				notify(true);
				return {
					kept: true,
					degraded
				};
			});
		},
		/** Moves a key kept in the profile to the store; false when it would not take it and the key stays where it was. */
		moveToStore: () => {
			begin();
			return serial(async () => {
				if (key === void 0 || place !== "profile" || !await toStore(key)) return false;
				place = kind;
				notify(false);
				return true;
			});
		},
		/** Removes the key from the store and the profile. False when one still has it afterwards (it then stays in use). */
		clear: () => {
			begin();
			return serial(async () => {
				dropProfileCopy();
				let left = profileCopy();
				let where = left === void 0 ? void 0 : "profile";
				if (driver) {
					await secret(driver.delete);
					const kept = await readStore();
					if (kept) [left, where] = [kept, kind];
				}
				[key, place] = [left, where];
				notify(true);
				return left === void 0;
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
/**
* What to do with a pasted key once Search1API has been asked about it. A key Search1API refuses is never saved. A key it
* could not be asked about (unreachable, down, rate limiting) replaces nothing: when a key is already saved it stays and
* the user is told to try again; only when there is no key yet is the new one saved, and the message says it was not checked.
* `message` is the whole text to show, or null to show the client's own text.
*/
function judgeKey(verdict, hadKey, clientText) {
	if (verdict === "ok" || verdict === "credits") return {
		save: true,
		message: null
	};
	if (verdict === "auth" || verdict === "rejected") return {
		save: false,
		message: null
	};
	if (!hadKey) return {
		save: true,
		message: `${clientText} The key was saved without being checked; test it again in a moment.`
	};
	return {
		save: false,
		message: `${verdict === "network" ? "Couldn't reach Search1API to check the new key." : verdict === "rate-limited" ? "Search1API is rate limiting requests, so the new key could not be checked." : "Search1API is having trouble right now, so the new key could not be checked."} Your saved key is unchanged; try again${verdict === "rate-limited" ? " in a minute" : ""}.`
	};
}
/** What was pasted, made safe to put in a header: no `Bearer`, no spaces or line breaks. */
function checkKey(pasted) {
	const key = pasted.trim().replace(/^bearer\s+/i, "");
	if (!key) return {
		ok: false,
		message: "Paste your Search1API key."
	};
	if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) return {
		ok: false,
		message: "That does not look like a Search1API key."
	};
	return {
		ok: true,
		key
	};
}
// src/react.ts
var React;
function provideReact(react) {
	React = react;
}
// src/settings.tsx
/** Where a new user gets a key. The tag tells Search1API the visit came from this plugin. */
var GET_KEY_URL = "https://app.s1.dev/?utm_source=buzz&utm_medium=plugin";
var credits = (n) => n === null ? "The key works." : `The key works. ${n.toLocaleString("en-US")} credits available.`;
function createSettingsCard({ keys, client }) {
	return function Search1APISettings() {
		const hasKey = () => keys.has();
		const keyPlace = () => keys.place();
		const saved = React.useSyncExternalStore(keys.subscribe, hasKey, hasKey);
		const place = React.useSyncExternalStore(keys.subscribe, keyPlace, keyPlace);
		const store = keys.store();
		const [draft, setDraft] = React.useState("");
		const [replacing, setReplacing] = React.useState(false);
		const [saving, setSaving] = React.useState(false);
		const [status, setStatus] = React.useState({ kind: "idle" });
		const [byHand, setByHand] = React.useState(false);
		const alive = React.useRef(true);
		React.useEffect(() => {
			keys.ready;
		}, []);
		React.useEffect(() => {
			alive.current = true;
			return () => {
				alive.current = false;
			};
		}, []);
		/** Asks Search1API about a key (`candidate`, or the saved one). Free: `/usage` spends no credits. */
		const ask = async (candidate) => {
			setStatus({ kind: "checking" });
			try {
				return {
					kind: "ok",
					text: credits((await client.usage(candidate)).credits)
				};
			} catch (error) {
				return error instanceof S1Error ? {
					kind: error.kind,
					text: error.message
				} : {
					kind: "server",
					text: "Something went wrong talking to Search1API."
				};
			}
		};
		const show = (verdict, text = verdict.text) => {
			if (alive.current) setStatus({
				kind: verdict.kind === "ok" ? "ok" : "error",
				text
			});
		};
		const keep = async (key) => {
			await keys.ready;
			setByHand(false);
			const verdict = await ask(key);
			const ruling = judgeKey(verdict.kind, keys.has(), verdict.text);
			show(verdict, ruling.message ?? verdict.text);
			if (!ruling.save) return;
			let result;
			try {
				result = await keys.save(key);
			} catch {
				if (alive.current) setStatus({
					kind: "error",
					text: "This app could not store the key."
				});
				return;
			}
			if (!result.kept) {
				if (!alive.current) return;
				if (store === "keychain") {
					setByHand(true);
					setStatus({
						kind: "error",
						text: `The Keychain would not take the key from here, and it has not been kept anywhere.${keys.has() ? " Your saved key is unchanged." : ""}`
					});
				} else setStatus({
					kind: "error",
					text: "The system secret store would not take the new key, so your saved key is unchanged."
				});
				return;
			}
			if (result.degraded && alive.current) setStatus({
				kind: "error",
				text: "The system secret store (Secret Service) did not take the key from here, so it is kept in this app's profile, as plain text: any other plugin you install could read it. Is a Secret Service such as gnome-keyring running and unlocked? Buzz tries again each time it starts, or press Move to secret store."
			});
			setDraft("");
			setReplacing(false);
		};
		const save = async (event) => {
			event.preventDefault();
			const checked = checkKey(draft);
			if (!checked.ok) {
				setStatus({
					kind: "error",
					text: checked.message
				});
				return;
			}
			setSaving(true);
			try {
				await keep(checked.key);
			} finally {
				if (alive.current) setSaving(false);
			}
		};
		const cancel = () => {
			setReplacing(false);
			setDraft("");
			setByHand(false);
			setStatus({ kind: "idle" });
		};
		const checkKeychain = async () => {
			await keys.reload();
			if (!alive.current) return;
			if (keys.place() === "keychain") {
				setByHand(false);
				setReplacing(false);
				setStatus({
					kind: "ok",
					text: "Found the key in your Keychain."
				});
			} else setStatus({
				kind: "error",
				text: "Nothing in the Keychain yet. Run the command in Terminal, paste the key at the prompt, then check again."
			});
		};
		const move = async () => {
			setStatus({ kind: "checking" });
			const moved = await keys.moveToStore();
			if (!alive.current) return;
			if (moved) {
				setByHand(false);
				setStatus({
					kind: "ok",
					text: `Moved to ${store ? STORE_NAME[store] : "the store"}. The copy in this app's profile is gone.`
				});
			} else {
				setByHand(store === "keychain");
				setStatus({
					kind: "error",
					text: `${store === "keychain" ? "The Keychain" : "The system secret store"} would not take the key from here. It is still in this app's profile, as plain text.`
				});
			}
		};
		const remove = async () => {
			const gone = await keys.clear();
			if (!alive.current) return;
			setStatus(gone ? { kind: "idle" } : {
				kind: "error",
				text: keys.place() === "keychain" ? "The Keychain would not give the key up. Remove it in Keychain Access (search for buzz-search1api)." : keys.place() === "secret-service" ? "The system secret store would not give the key up. Remove it with `secret-tool clear service buzz-search1api account search1api`, or in your keyring's own app." : "This app could not remove the key from its profile."
			});
			setReplacing(false);
			setByHand(false);
			setDraft("");
		};
		const showInput = !saved || replacing;
		return /* @__PURE__ */ React.createElement("section", {
			className: "s1b-root",
			"aria-label": "Search1API"
		}, /* @__PURE__ */ React.createElement("p", null, "Gives every agent in this app Search1API tools: ", /* @__PURE__ */ React.createElement("code", null, "search1api_search"), " to search the live web,", " ", /* @__PURE__ */ React.createElement("code", null, "search1api_news"), " for recent news, ", /* @__PURE__ */ React.createElement("code", null, "search1api_crawl"), " to read a page in full, and", " ", /* @__PURE__ */ React.createElement("code", null, "search1api_maps"), " to find places and businesses on Google Maps. With", " ", /* @__PURE__ */ React.createElement("code", null, "search1api_render_results"), " they can show what they found as cards in their reply. The tools use your own Search1API key, which is kept on this computer and sent only to Search1API."), saved && !replacing && /* @__PURE__ */ React.createElement("p", {
			className: "s1b-saved",
			"data-place": place
		}, /* @__PURE__ */ React.createElement("strong", null, "Key saved."), " ", place === "keychain" || place === "secret-service" ? `It is kept in ${STORE_NAME[place]}. It is not shown again.` : store ? `It is in this app's profile, as plain text, because ${store === "keychain" ? "the Keychain" : "the system secret store (Secret Service)"} would not take it yet (it is tried again each time Buzz starts). Any other plugin you install could read it. It is not shown again.` : "It is in this app's profile, as plain text, because this system has no secret store the plugin can use: any other plugin you install could read it. It is not shown again."), showInput && /* @__PURE__ */ React.createElement("form", {
			onSubmit: save,
			className: "s1b-form"
		}, /* @__PURE__ */ React.createElement("label", { htmlFor: "s1b-key" }, "API key"), /* @__PURE__ */ React.createElement("input", {
			id: "s1b-key",
			type: "password",
			autoComplete: "off",
			autoCorrect: "off",
			autoCapitalize: "off",
			spellCheck: false,
			value: draft,
			placeholder: "Paste your Search1API key",
			onChange: (event) => setDraft(event.target.value)
		}), /* @__PURE__ */ React.createElement("div", { className: "s1b-actions" }, /* @__PURE__ */ React.createElement("button", {
			type: "submit",
			className: "s1b-button",
			"data-primary": true,
			disabled: status.kind === "checking" || saving
		}, "Save key"), replacing && /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			disabled: saving,
			onClick: cancel
		}, "Cancel"))), byHand && /* @__PURE__ */ React.createElement("div", {
			role: "group",
			"aria-label": "Save the key in the Keychain by hand",
			className: "s1b-form"
		}, /* @__PURE__ */ React.createElement("p", null, "To put it in the Keychain yourself, run this in Terminal. It asks for the key (twice, showing nothing as you type), so the key is not in the command:"), /* @__PURE__ */ React.createElement("code", { className: "s1b-code" }, "security add-generic-password -U -s buzz-search1api -a search1api -w"), /* @__PURE__ */ React.createElement("div", { className: "s1b-actions" }, /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			onClick: () => void checkKeychain()
		}, "Check Keychain"))), saved && !replacing && /* @__PURE__ */ React.createElement("div", { className: "s1b-actions" }, /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			disabled: status.kind === "checking",
			onClick: async () => show(await ask())
		}, "Test key"), store && place === "profile" && /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			"data-primary": true,
			disabled: status.kind === "checking",
			onClick: () => void move()
		}, store === "keychain" ? "Move to Keychain" : "Move to secret store"), /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			onClick: () => setReplacing(true)
		}, "Replace key"), /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "s1b-button",
			onClick: () => void remove()
		}, "Remove key")), status.kind !== "idle" && /* @__PURE__ */ React.createElement("p", {
			role: status.kind === "error" ? "alert" : "status",
			"data-tone": status.kind === "error" ? "error" : "ok"
		}, status.kind === "checking" ? "Checking with Search1API…" : status.text), /* @__PURE__ */ React.createElement("p", { className: "s1b-muted" }, "No key yet?", " ", /* @__PURE__ */ React.createElement("a", {
			href: GET_KEY_URL,
			target: "_blank",
			rel: "noopener noreferrer"
		}, "Get one at app.s1.dev"), " ", "and start with 100 free credits, no credit card required. A search, a news search or a page read costs 1 credit, and each search result read in full costs 1 more. A page of up to 20 places from Maps costs 3 credits."), store === "keychain" ? /* @__PURE__ */ React.createElement("p", { className: "s1b-muted" }, "On a Mac the key is kept in your Keychain, in an item named buzz-search1api. Buzz plugins are not sandboxed: a plugin that declares the", " ", /* @__PURE__ */ React.createElement("code", null, "security"), " program could read it too, and its install review lists that. Install only plugins you trust.") : store === "secret-service" ? /* @__PURE__ */ React.createElement("p", { className: "s1b-muted" }, "On Linux the key is kept in the system secret store (gnome-keyring, KWallet or another), in an item with the attributes service buzz-search1api and account search1api. If no Secret Service is running, it is kept in this app's profile as plain text instead, and this card says so. Install only plugins you trust.") : /* @__PURE__ */ React.createElement("p", { className: "s1b-muted" }, "On this system the key is kept in this app's profile, as plain text. Buzz plugins are not sandboxed, so any other plugin you install could read it: install only plugins you trust."));
	};
}
// src/styles.ts
var CSS = `
.s1b-root {
  --s1b-ink: var(--text-standard, #e9eef4);
  --s1b-muted: var(--text-metadata, #8290a0);
  --s1b-card: var(--surface-panel, #12161c);
  --s1b-line: var(--border-standard, #2b333d);
  --s1b-hover: var(--affordance-row-hover, rgba(128, 140, 160, 0.14));
  --s1b-accent: var(--accent-9, #0a7cff);
  --s1b-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  display: flex; flex-direction: column; gap: 12px; max-width: 640px; color: var(--s1b-ink); line-height: 1.5;
}
.s1b-root p { margin: 0; }
.s1b-root code { font-family: var(--s1b-mono); font-size: 0.92em; }
.s1b-root a { color: var(--s1b-accent); text-decoration: none; }
.s1b-root a:hover { text-decoration: underline; }
.s1b-root :focus-visible { outline: 2px solid var(--border-focus, var(--s1b-accent)); outline-offset: 2px; }
.s1b-muted { color: var(--s1b-muted); }
.s1b-form { display: flex; flex-direction: column; gap: 8px; }
.s1b-form label { font-weight: 500; }
.s1b-form input { height: 30px; padding: 0 8px; border: 1px solid var(--s1b-line); border-radius: 6px;
  background: var(--s1b-card); color: var(--s1b-ink); font: inherit; color-scheme: inherit; }
.s1b-form input:hover { border-color: color-mix(in srgb, var(--s1b-accent) 50%, var(--s1b-line)); }
.s1b-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.s1b-button { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border: 1px solid var(--s1b-line);
  border-radius: 6px; background: transparent; color: var(--s1b-ink); font: inherit; font-weight: 500; cursor: pointer; }
.s1b-button:hover:not(:disabled) { background: var(--s1b-hover); }
.s1b-button[data-primary] { border-color: var(--s1b-accent); background: var(--s1b-accent); color: var(--accent-contrast, #fff); }
.s1b-button[data-primary]:hover:not(:disabled) { background: color-mix(in srgb, var(--s1b-accent) 85%, #000); }
.s1b-button:disabled { opacity: 0.5; cursor: default; }
.s1b-code { display: block; padding: 8px 10px; border: 1px solid var(--s1b-line); border-radius: 6px; background: var(--s1b-card);
  overflow-x: auto; white-space: pre; }
.s1b-root [data-tone="error"] { color: var(--red-11, #ff6369); }
.s1b-root [data-tone="ok"] { color: var(--green-11, #3dd68c); }

/* result cards, drawn in place of a search1api-results code block */
.s1b-results { gap: 8px; max-width: 760px; }
.s1b-results-title { font-weight: 600; }
.s1b-cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.s1b-card { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 10px 12px; border: 1px solid var(--s1b-line);
  border-radius: 8px; background: var(--s1b-card); }
.s1b-card:hover { border-color: color-mix(in srgb, var(--s1b-accent) 45%, var(--s1b-line)); }
.s1b-card-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.s1b-index { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; background: color-mix(in srgb, var(--s1b-accent) 16%, transparent); color: var(--s1b-accent); font-size: 11px; font-weight: 600; }
.s1b-root .s1b-title { color: var(--s1b-ink); font-weight: 600; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; }
.s1b-root .s1b-title:hover { color: var(--s1b-accent); }
.s1b-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font-size: 12.5px; }
.s1b-site { flex-wrap: nowrap; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s1b-dim { color: var(--s1b-muted); }
.s1b-rating { color: var(--s1b-ink); }
.s1b-rating [aria-hidden] { color: var(--amber-9, #f5a524); }
.s1b-text { margin: 0; font-size: 12.5px; color: var(--s1b-muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.s1b-links a { font-weight: 500; }
.s1b-results-foot { font-size: 11.5px; }
`;
// src/tools.ts
/** Longest page text handed to an agent from one read, in characters. */
var MAX_PAGE_CHARS = 6e4;
/** Longest full text kept per result when a search also reads its top results. */
var MAX_RESULT_CHARS = 12e3;
var SEARCH_SERVICES = [
	"google",
	"bing",
	"bingcn",
	"duckduckgo",
	"yahoo",
	"yandex",
	"x",
	"reddit",
	"github",
	"youtube",
	"arxiv",
	"wechat",
	"bilibili",
	"imdb",
	"wikipedia",
	"grokipedia"
];
var NEWS_SERVICES = [
	"google",
	"bing",
	"duckduckgo",
	"yahoo",
	"hackernews"
];
var TIME_RANGES = [
	"day",
	"week",
	"month",
	"year"
];
var text = (value) => typeof value === "string" ? value : void 0;
function cut(value, limit) {
	return value.length > limit ? {
		text: value.slice(0, limit),
		truncated: true
	} : {
		text: value,
		truncated: false
	};
}
/** One result as the agent gets it: what it needs to answer and cite, nothing else. */
function shapeResult(result) {
	const url = text(result.link);
	if (!url) return void 0;
	const content = text(result.content);
	const page = content ? cut(content, MAX_RESULT_CHARS) : void 0;
	return {
		title: text(result.title) ?? url,
		url,
		...text(result.snippet) ? { snippet: text(result.snippet) } : {},
		...text(result.published_date) ? { published_date: text(result.published_date) } : {},
		...page ? {
			content: page.text,
			...page.truncated ? { content_truncated: true } : {}
		} : {}
	};
}
function requireString(args, name, max = 1e3) {
	const value = args[name];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	if (value.length > max) throw new Error(`${name} must be at most ${max} characters`);
	return value.trim();
}
function optionalInt(args, name, min, max) {
	const value = args[name];
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
	return value;
}
function optionalEnum(args, name, allowed) {
	const value = args[name];
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	return value;
}
function optionalSites(args, name) {
	const value = args[name];
	if (value === void 0 || value === null) return void 0;
	if (!Array.isArray(value) || value.length > 20 || !value.every((site) => typeof site === "string" && site.trim() && site.length <= 253)) throw new Error(`${name} must be a list of up to 20 domains, such as ["github.com"]`);
	return value.map((site) => site.trim());
}
function requireHttpUrl(args, name) {
	const raw = requireString(args, name, 4096);
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} must be a full http(s) address, such as https://example.com/page`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must start with http:// or https://`);
	return url.toString();
}
function optionalLocation(value) {
	if (value === void 0 || value === null) return void 0;
	const v = value;
	const number = (n, min, max) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
	if (typeof value !== "object" || !number(v.latitude, -90, 90) || !number(v.longitude, -180, 180) || v.zoom !== void 0 && !number(v.zoom, 3, 30)) throw new Error("location must be {latitude: -90..90, longitude: -180..180, zoom?: 3..30}");
	return defined({
		latitude: v.latitude,
		longitude: v.longitude,
		zoom: v.zoom
	});
}
var defined = (entries) => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== void 0));
var sitesSchema = (description) => ({
	type: "array",
	items: { type: "string" },
	maxItems: 20,
	description
});
function createTools(client) {
	return [
		{
			name: "search1api_search",
			description: "Search the live web with Search1API when the answer needs current information or sources. Returns JSON results with title, url, snippet and, when known, published_date. Pick search_service only when the user's intent matches a source (github, reddit, x, youtube, arxiv, wikipedia, wechat, bilibili and more); the default is google. Set crawl_results to also read the top results in full. Read any other result with search1api_crawl. Cite the urls you use.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Short, focused search query"
					},
					max_results: {
						type: "integer",
						minimum: 1,
						maximum: 50,
						description: "How many results the answer needs; default 10"
					},
					search_service: {
						type: "string",
						enum: [...SEARCH_SERVICES],
						description: "Engine or source to search; default google"
					},
					crawl_results: {
						type: "integer",
						minimum: 0,
						maximum: 10,
						description: "How many top results to also read in full; each page read costs 1 more credit. Default 0"
					},
					include_sites: sitesSchema("Only search these domains, when the user scopes the search"),
					exclude_sites: sitesSchema("Leave these domains out"),
					time_range: {
						type: "string",
						enum: [...TIME_RANGES],
						description: "Only results from this recent window; leave unset for evergreen topics"
					}
				},
				required: ["query"],
				additionalProperties: false
			},
			async call(_client, _context, args) {
				const request = defined({
					query: requireString(args, "query"),
					max_results: optionalInt(args, "max_results", 1, 50),
					search_service: optionalEnum(args, "search_service", SEARCH_SERVICES),
					crawl_results: optionalInt(args, "crawl_results", 0, 10),
					include_sites: optionalSites(args, "include_sites"),
					exclude_sites: optionalSites(args, "exclude_sites"),
					time_range: optionalEnum(args, "time_range", TIME_RANGES)
				});
				const crawling = typeof request.crawl_results === "number" && request.crawl_results > 0;
				const results = ((await client.post("/search", request, crawling ? 9e4 : 3e4)).results ?? []).map(shapeResult).filter((r) => r !== void 0);
				return JSON.stringify({
					query: request.query,
					results
				}, null, 1);
			}
		},
		{
			name: "search1api_news",
			description: "Search recent news with Search1API when the user asks about recent events, announcements or coverage. Returns JSON articles with title, url, snippet and published_date when known. Use time_range day for breaking news. search_service hackernews returns Hacker News discussions instead of publisher articles. Cite the urls you use.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Short, focused news query"
					},
					max_results: {
						type: "integer",
						minimum: 1,
						maximum: 50,
						description: "How many articles the answer needs; default 10"
					},
					search_service: {
						type: "string",
						enum: [...NEWS_SERVICES],
						description: "News engine; default bing"
					},
					include_sites: sitesSchema("Only these news domains"),
					exclude_sites: sitesSchema("Leave these news domains out"),
					time_range: {
						type: "string",
						enum: [...TIME_RANGES],
						description: "Only articles from this window"
					}
				},
				required: ["query"],
				additionalProperties: false
			},
			async call(_client, _context, args) {
				const request = defined({
					query: requireString(args, "query"),
					max_results: optionalInt(args, "max_results", 1, 50),
					search_service: optionalEnum(args, "search_service", NEWS_SERVICES),
					include_sites: optionalSites(args, "include_sites"),
					exclude_sites: optionalSites(args, "exclude_sites"),
					time_range: optionalEnum(args, "time_range", TIME_RANGES)
				});
				const results = ((await client.post("/news", request, 3e4)).results ?? []).map(shapeResult).filter((r) => r !== void 0);
				return JSON.stringify({
					query: request.query,
					results
				}, null, 1);
			}
		},
		{
			name: "search1api_crawl",
			description: "Read a public web page with Search1API: a link the user shared or a url from search1api_search. Returns JSON with the page's title, url and main content as text, so the answer can rest on the whole page instead of a snippet. Very long pages are cut short and marked truncated.",
			inputSchema: {
				type: "object",
				properties: { url: {
					type: "string",
					description: "The page's full http(s) address"
				} },
				required: ["url"],
				additionalProperties: false
			},
			async call(_client, _context, args) {
				const url = requireHttpUrl(args, "url");
				const page = (await client.post("/crawl", { url }, 9e4)).results;
				const content = text(page?.content);
				if (!content) throw new Error(`Search1API could not read any text from ${url}`);
				const { text: kept, truncated } = cut(content, MAX_PAGE_CHARS);
				return JSON.stringify({
					title: text(page?.title) ?? url,
					url: text(page?.link) ?? url,
					content: kept,
					...truncated ? {
						truncated: true,
						total_chars: content.length
					} : {}
				}, null, 1);
			}
		},
		{
			name: "search1api_maps",
			description: "Find local businesses and places on Google Maps with Search1API, when the user asks where something is, wants nearby options, or needs a list of businesses with contact details. Returns JSON with one page of up to 20 places: name and Google Maps link, plus address, phone, website, category, rating, review count, coordinates and opening hours when known. Costs 3 credits per page however many places it holds. Use search1api_search for web pages and search1api_crawl to read a business's website.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						maxLength: 1e3,
						description: "What to look for, such as \"coffee shops\" or \"dentists in Austin\"; a place name in the query sets the area when no location is given"
					},
					country: {
						type: "string",
						pattern: "^[a-zA-Z]{2}$",
						description: "Two-letter country code for local results; default us"
					},
					language: {
						type: "string",
						description: "Result language, such as en, de or zh-CN; default en"
					},
					location: {
						type: "object",
						description: "Search around this point instead of letting the query decide the area; required for page 2 and later",
						properties: {
							latitude: {
								type: "number",
								minimum: -90,
								maximum: 90
							},
							longitude: {
								type: "number",
								minimum: -180,
								maximum: 180
							},
							zoom: {
								type: "number",
								minimum: 3,
								maximum: 30,
								description: "Map zoom, higher is a smaller area; default 14"
							}
						},
						required: ["latitude", "longitude"],
						additionalProperties: false
					},
					page: {
						type: "integer",
						minimum: 1,
						maximum: 6,
						description: "Page to fetch; each page is a separate 3-credit call and pages after the first need location"
					},
					max_results: {
						type: "integer",
						minimum: 1,
						maximum: 20,
						description: "How many places the answer needs; fewer places do not lower the price"
					}
				},
				required: ["query"],
				additionalProperties: false
			},
			async call(_client, _context, args) {
				const country = args.country;
				if (country !== void 0 && (typeof country !== "string" || !/^[a-zA-Z]{2}$/.test(country))) throw new Error("country must be a two-letter country code, such as us or de");
				const language = args.language;
				if (language !== void 0 && (typeof language !== "string" || !/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(language))) throw new Error("language must be a language code, such as en, de or zh-CN");
				const location = optionalLocation(args.location);
				const page = optionalInt(args, "page", 1, 6);
				if (page !== void 0 && page > 1 && !location) throw new Error("location is required for page 2 and later");
				const request = defined({
					query: requireString(args, "query"),
					country,
					language,
					location,
					page,
					max_results: optionalInt(args, "max_results", 1, 20)
				});
				const places = ((await client.post("/maps", request, 45e3)).results ?? []).filter((place) => typeof place.name === "string" && typeof place.maps_url === "string").map(({ thumbnail: _thumbnail, ...place }) => place);
				return JSON.stringify({
					query: request.query,
					places
				}, null, 1);
			}
		}
	];
}
// src/render.ts
var BLOCK_LANGUAGE = "search1api-results";
var MAX_TITLE = 300;
var MAX_TEXT = 400;
var MAX_HEADING = 120;
var STRING_META = [
	"published_date",
	"source",
	"category",
	"address",
	"open_state",
	"phone",
	"price"
];
/** An http(s) address without credentials, or nothing. */
function safeUrl(value) {
	if (typeof value !== "string" || value.length > 2048) return void 0;
	let url;
	try {
		url = new URL(value);
	} catch {
		return;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) return void 0;
	return url.toString();
}
var clean = (value, max) => {
	if (typeof value !== "string") return void 0;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return void 0;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
/** One card from what an agent passed, or from a block read back; `undefined` when it has no title or usable link. */
function toCard(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const item = raw;
	const title = clean(item.title ?? item.name, MAX_TITLE);
	const url = safeUrl(item.url ?? item.maps_url);
	if (!title || !url) return void 0;
	const meta = {
		...item.metadata && typeof item.metadata === "object" ? item.metadata : {},
		...item
	};
	const card = {
		title,
		url
	};
	const text = clean(item.text ?? item.snippet ?? item.description, MAX_TEXT);
	if (text) card.text = text;
	for (const key of STRING_META) {
		const value = clean(meta[key], 200);
		if (value) card[key] = value;
	}
	if (typeof meta.rating === "number" && Number.isFinite(meta.rating) && meta.rating >= 0 && meta.rating <= 5) card.rating = meta.rating;
	if (typeof meta.review_count === "number" && Number.isInteger(meta.review_count) && meta.review_count >= 0) card.review_count = meta.review_count;
	const website = safeUrl(meta.website);
	if (website) card.website = website;
	return card;
}
/** Reads a block back. Throws on anything that is not one, so Buzz shows the plain block instead. */
function parseBlock(code) {
	const data = JSON.parse(code);
	if (!data || typeof data !== "object" || data.v !== 1 || !Array.isArray(data.results)) throw new Error("Not a Search1API results block");
	const results = data.results.slice(0, 50).map(toCard).filter((card) => card !== void 0);
	if (results.length === 0) throw new Error("No results to show");
	const title = clean(data.title, MAX_HEADING);
	return {
		v: 1,
		...title ? { title } : {},
		results
	};
}
function buildBlock(cards) {
	return `\`\`\`${BLOCK_LANGUAGE}\n${JSON.stringify(cards, null, 1)}\n\`\`\``;
}
function createRenderTool() {
	return {
		name: "search1api_render_results",
		description: "Show results you already have from search1api_search, search1api_news or search1api_maps as cards in your Buzz reply. Pass them in the order to show; never invent titles or links. It returns a fenced code block: put that block in your message exactly as given, where the cards should appear, and keep writing your answer around it. It does not search or fetch anything and costs no credits. Use it when the user wants to browse sources or a list of places; skip it when a plain answer is enough.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					maxLength: MAX_HEADING,
					description: "Heading above the cards, such as the topic"
				},
				results: {
					type: "array",
					minItems: 1,
					maxItems: 50,
					description: "Results as the Search1API tools returned them, in display order. Places from search1api_maps can be passed as they are.",
					items: {
						type: "object",
						properties: {
							title: {
								type: "string",
								description: "Title as returned (or `name` for a place)"
							},
							url: {
								type: "string",
								description: "Link as returned (or `maps_url` for a place)"
							},
							text: {
								type: "string",
								description: "The snippet, or a faithful excerpt; not your own summary"
							},
							published_date: { type: "string" },
							rating: { type: "number" },
							review_count: { type: "integer" },
							category: { type: "string" },
							address: { type: "string" },
							open_state: { type: "string" },
							phone: { type: "string" },
							website: { type: "string" },
							price: { type: "string" }
						}
					}
				}
			},
			required: ["results"],
			additionalProperties: false
		},
		async call(_client, _context, args) {
			if (!Array.isArray(args.results) || args.results.length === 0) throw new Error("results must be a non-empty list of results you already have");
			if (args.results.length > 50) throw new Error(`results can hold at most 50 items`);
			const results = args.results.map(toCard).filter((card) => card !== void 0);
			const dropped = args.results.length - results.length;
			if (results.length === 0) throw new Error("None of the results had a title and an http(s) link");
			const title = clean(args.title, MAX_HEADING);
			const block = buildBlock({
				v: 1,
				...title ? { title } : {},
				results
			});
			return [
				`Put this block in your reply exactly as it is, where the cards should appear${dropped ? ` (${dropped} result${dropped === 1 ? "" : "s"} without a title or http(s) link left out)` : ""}:`,
				"",
				block
			].join("\n");
		}
	};
}
// src/cards.tsx
function host(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}
function date(value) {
	if (!value) return void 0;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(void 0, {
		year: "numeric",
		month: "short",
		day: "numeric"
	});
}
var isPlace = (card) => card.rating !== void 0 || card.review_count !== void 0 || card.address !== void 0 || card.open_state !== void 0;
function Stars({ rating, reviews }) {
	if (rating === void 0 && reviews === void 0) return null;
	return /* @__PURE__ */ React.createElement("span", { className: "s1b-rating" }, rating !== void 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, "★"), " ", /* @__PURE__ */ React.createElement("strong", null, rating.toFixed(1))), reviews !== void 0 && /* @__PURE__ */ React.createElement("span", { className: "s1b-dim" }, " (", reviews.toLocaleString("en-US"), " reviews)"));
}
function PlaceCard({ card, index }) {
	return /* @__PURE__ */ React.createElement("li", {
		className: "s1b-card",
		"data-kind": "place"
	}, /* @__PURE__ */ React.createElement("div", { className: "s1b-card-head" }, /* @__PURE__ */ React.createElement("span", { className: "s1b-index" }, index + 1), /* @__PURE__ */ React.createElement("a", {
		className: "s1b-title",
		href: card.url,
		target: "_blank",
		rel: "noopener noreferrer"
	}, card.title)), /* @__PURE__ */ React.createElement("div", { className: "s1b-line" }, /* @__PURE__ */ React.createElement(Stars, {
		rating: card.rating,
		reviews: card.review_count
	}), card.category && /* @__PURE__ */ React.createElement("span", { className: "s1b-dim" }, card.category), card.price && /* @__PURE__ */ React.createElement("span", { className: "s1b-dim" }, card.price)), card.address && /* @__PURE__ */ React.createElement("div", { className: "s1b-line s1b-dim" }, card.address), card.open_state && /* @__PURE__ */ React.createElement("div", { className: "s1b-line s1b-dim" }, card.open_state), card.text && /* @__PURE__ */ React.createElement("p", { className: "s1b-text" }, card.text), (card.website || card.phone) && /* @__PURE__ */ React.createElement("div", { className: "s1b-line s1b-links" }, card.website && /* @__PURE__ */ React.createElement("a", {
		href: card.website,
		target: "_blank",
		rel: "noopener noreferrer"
	}, host(card.website)), card.phone && /* @__PURE__ */ React.createElement("span", { className: "s1b-dim" }, card.phone)));
}
function SourceCard({ card, index }) {
	const when = date(card.published_date);
	return /* @__PURE__ */ React.createElement("li", {
		className: "s1b-card",
		"data-kind": "source"
	}, /* @__PURE__ */ React.createElement("div", { className: "s1b-line s1b-dim s1b-site" }, /* @__PURE__ */ React.createElement("span", { className: "s1b-index" }, index + 1), /* @__PURE__ */ React.createElement("span", null, card.source ?? host(card.url)), when && /* @__PURE__ */ React.createElement("span", null, "· ", when)), /* @__PURE__ */ React.createElement("a", {
		className: "s1b-title",
		href: card.url,
		target: "_blank",
		rel: "noopener noreferrer"
	}, card.title), card.text && /* @__PURE__ */ React.createElement("p", { className: "s1b-text" }, card.text));
}
function ResultCards({ code }) {
	const cards = React.useMemo(() => parseBlock(code), [code]);
	return /* @__PURE__ */ React.createElement("section", {
		className: "s1b-root s1b-results",
		"aria-label": cards.title ?? "Search results"
	}, cards.title && /* @__PURE__ */ React.createElement("div", { className: "s1b-results-title" }, cards.title), /* @__PURE__ */ React.createElement("ol", { className: "s1b-cards" }, cards.results.map((card, index) => isPlace(card) ? /* @__PURE__ */ React.createElement(PlaceCard, {
		key: index,
		card,
		index
	}) : /* @__PURE__ */ React.createElement(SourceCard, {
		key: index,
		card,
		index
	}))), /* @__PURE__ */ React.createElement("div", { className: "s1b-results-foot s1b-dim" }, cards.results.length, " result", cards.results.length === 1 ? "" : "s", " · via Search1API"));
}
// src/index.tsx
var inject = [
	"react",
	"settingsCards",
	"agents",
	"host"
];
function apply(ctx) {
	provideReact(ctx.react);
	const keys = createKeyStore(window.localStorage, {
		store: detectStore(navigator.platform, navigator.userAgent),
		run: (command, input) => ctx.host.runCommand(command, input)
	});
	const client = createClient((request) => ctx.host.request(request), async () => {
		await keys.ready;
		return keys.read();
	});
	ctx.effect(() => {
		const style = document.createElement("style");
		style.dataset.search1apiBuzz = "";
		style.textContent = CSS;
		document.head.append(style);
		return () => style.remove();
	});
	for (const tool of [...createTools(client), createRenderTool()]) ctx.agents.addTool(tool);
	ctx.inject(["conversation"], (scope) => {
		scope.conversation.registerCodeBlock({
			id: "results",
			title: "Search1API results",
			matches: (language) => language.trim().toLowerCase() === BLOCK_LANGUAGE,
			component: ResultCards
		});
	});
	ctx.settingsCards.register({
		id: "settings",
		title: "Search1API",
		group: "Plugins",
		component: createSettingsCard({
			keys,
			client
		})
	});
}
export { apply, inject };
