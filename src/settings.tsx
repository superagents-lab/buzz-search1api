// The settings card: paste a key, see that it works, replace or remove it.
// The flow follows the Linear plugin in github.com/0xnfrith/buzz-plugins (Apache License 2.0).
import { React } from "./react";
import { S1Error, type S1Client } from "./client";
import { KEYCHAIN_TERMINAL_COMMAND, STORE_NAME, checkKey, judgeKey, type KeyStore } from "./keys";

/** Where a new user gets a key. The tag tells Search1API the visit came from this plugin. */
export const GET_KEY_URL = "https://app.s1.dev/?utm_source=buzz&utm_medium=plugin";

type Status = { kind: "idle" } | { kind: "checking" } | { kind: "ok"; text: string } | { kind: "error"; text: string };
type Verdict = { kind: S1Error["kind"] | "ok"; text: string };

const credits = (n: number | null) =>
  n === null ? "The key works." : `The key works. ${n.toLocaleString("en-US")} credits available.`;

export function createSettingsCard({ keys, client }: { keys: KeyStore; client: S1Client }) {
  return function Search1APISettings() {
    const hasKey = () => keys.has();
    const keyPlace = () => keys.place();
    const saved = React.useSyncExternalStore(keys.subscribe, hasKey, hasKey);
    const place = React.useSyncExternalStore(keys.subscribe, keyPlace, keyPlace);
    const store = keys.store();
    const [draft, setDraft] = React.useState("");
    const [replacing, setReplacing] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [status, setStatus] = React.useState<Status>({ kind: "idle" });
    // The Keychain would not take a key (on a Mac): nothing was kept, and the card says how to put it there by hand.
    const [byHand, setByHand] = React.useState(false);
    const alive = React.useRef(true);
    // Opening the card is what makes the first look at where the key is kept.
    React.useEffect(() => {
      void keys.ready;
    }, []);
    React.useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);

    /** Asks Search1API about a key (`candidate`, or the saved one). Free: `/usage` spends no credits. */
    const ask = async (candidate?: string): Promise<Verdict> => {
      setStatus({ kind: "checking" });
      try {
        return { kind: "ok", text: credits((await client.usage(candidate)).credits) };
      } catch (error) {
        return error instanceof S1Error
          ? { kind: error.kind, text: error.message }
          : { kind: "server", text: "Something went wrong talking to Search1API." };
      }
    };

    const show = (verdict: Verdict, text: string = verdict.text) => {
      if (alive.current) setStatus({ kind: verdict.kind === "ok" ? "ok" : "error", text });
    };

    const keep = async (key: string) => {
      await keys.ready;
      setByHand(false);
      // Search1API is asked first, so a mistyped replacement never costs the key that works.
      const verdict = await ask(key);
      const ruling = judgeKey(verdict.kind, keys.has(), verdict.text);
      show(verdict, ruling.message ?? verdict.text);
      if (!ruling.save) return;
      let result: { kept: boolean; degraded: boolean };
      try {
        result = await keys.save(key);
      } catch {
        if (alive.current) setStatus({ kind: "error", text: "This app could not store the key." });
        return;
      }
      if (!result.kept) {
        if (!alive.current) return;
        if (store === "keychain") {
          setByHand(true);
          setStatus({
            kind: "error",
            text: `The Keychain would not take the key from here, and it has not been kept anywhere.${keys.has() ? " Your saved key is unchanged." : ""}`,
          });
        } else {
          setStatus({ kind: "error", text: "The system secret store would not take the new key, so your saved key is unchanged." });
        }
        return;
      }
      if (result.degraded && alive.current) {
        setStatus({
          kind: "error",
          text: "The system secret store (Secret Service) did not take the key from here, so it is kept in this app's profile, as plain text: any other plugin you install could read it. Is a Secret Service such as gnome-keyring running and unlocked? Buzz tries again each time it starts, or press Move to secret store.",
        });
      }
      setDraft("");
      setReplacing(false);
    };

    const save = async (event: React.FormEvent) => {
      event.preventDefault();
      const checked = checkKey(draft);
      if (!checked.ok) {
        setStatus({ kind: "error", text: checked.message });
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
        setStatus({ kind: "ok", text: "Found the key in your Keychain." });
      } else
        setStatus({ kind: "error", text: "Nothing in the Keychain yet. Run the command in Terminal, paste the key at the prompt, then check again." });
    };

    const move = async () => {
      setStatus({ kind: "checking" });
      const moved = await keys.moveToStore();
      if (!alive.current) return;
      if (moved) {
        setByHand(false);
        setStatus({ kind: "ok", text: `Moved to ${store ? STORE_NAME[store] : "the store"}. The copy in this app's profile is gone.` });
      } else {
        setByHand(store === "keychain");
        setStatus({
          kind: "error",
          text: `${store === "keychain" ? "The Keychain" : "The system secret store"} would not take the key from here. It is still in this app's profile, as plain text.`,
        });
      }
    };

    const remove = async () => {
      const gone = await keys.clear();
      if (!alive.current) return;
      setStatus(
        gone
          ? { kind: "idle" }
          : {
              kind: "error",
              text:
                keys.place() === "keychain"
                  ? "The Keychain would not give the key up. Remove it in Keychain Access (search for buzz-search1api)."
                  : keys.place() === "secret-service"
                    ? "The system secret store would not give the key up. Remove it with `secret-tool clear service buzz-search1api account search1api`, or in your keyring's own app."
                    : "This app could not remove the key from its profile.",
            },
      );
      setReplacing(false);
      setByHand(false);
      setDraft("");
    };

    const showInput = !saved || replacing;
    return (
      <section className="s1b-root" aria-label="Search1API">
        <p>
          Gives every agent in this app Search1API tools: <code>search1api_search</code> to search the live web,{" "}
          <code>search1api_news</code> for recent news, <code>search1api_crawl</code> to read a page in full, and{" "}
          <code>search1api_maps</code> to find places and businesses on Google Maps. With{" "}
          <code>search1api_render_results</code> they can show what they found as cards in their reply. The tools
          use your own Search1API key, which is kept on this computer and sent only to Search1API.
        </p>
        {saved && !replacing && (
          <p className="s1b-saved" data-place={place}>
            <strong>Key saved.</strong>{" "}
            {place === "keychain" || place === "secret-service"
              ? `It is kept in ${STORE_NAME[place]}. It is not shown again.`
              : store
                ? `It is in this app's profile, as plain text, because ${store === "keychain" ? "the Keychain" : "the system secret store (Secret Service)"} would not take it yet (it is tried again each time Buzz starts). Any other plugin you install could read it. It is not shown again.`
                : "It is in this app's profile, as plain text, because this system has no secret store the plugin can use: any other plugin you install could read it. It is not shown again."}
          </p>
        )}
        {showInput && (
          <form onSubmit={save} className="s1b-form">
            <label htmlFor="s1b-key">API key</label>
            <input
              id="s1b-key"
              type="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draft}
              placeholder="Paste your Search1API key"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="s1b-actions">
              <button type="submit" className="s1b-button" data-primary disabled={status.kind === "checking" || saving}>
                Save key
              </button>
              {replacing && (
                <button type="button" className="s1b-button" disabled={saving} onClick={cancel}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
        {byHand && (
          <div role="group" aria-label="Save the key in the Keychain by hand" className="s1b-form">
            <p>
              To put it in the Keychain yourself, run this in Terminal. It asks for the key (twice, showing nothing as you type), so the key is not in
              the command:
            </p>
            <code className="s1b-code">{KEYCHAIN_TERMINAL_COMMAND}</code>
            <div className="s1b-actions">
              <button type="button" className="s1b-button" onClick={() => void checkKeychain()}>
                Check Keychain
              </button>
            </div>
          </div>
        )}
        {saved && !replacing && (
          <div className="s1b-actions">
            <button type="button" className="s1b-button" disabled={status.kind === "checking"} onClick={async () => show(await ask())}>
              Test key
            </button>
            {store && place === "profile" && (
              <button type="button" className="s1b-button" data-primary disabled={status.kind === "checking"} onClick={() => void move()}>
                {store === "keychain" ? "Move to Keychain" : "Move to secret store"}
              </button>
            )}
            <button type="button" className="s1b-button" onClick={() => setReplacing(true)}>
              Replace key
            </button>
            <button type="button" className="s1b-button" onClick={() => void remove()}>
              Remove key
            </button>
          </div>
        )}
        {status.kind !== "idle" && (
          <p role={status.kind === "error" ? "alert" : "status"} data-tone={status.kind === "error" ? "error" : "ok"}>
            {status.kind === "checking" ? "Checking with Search1API…" : status.text}
          </p>
        )}
        <p className="s1b-muted">
          No key yet?{" "}
          <a href={GET_KEY_URL} target="_blank" rel="noopener noreferrer">
            Get one at app.s1.dev
          </a>{" "}
          and start with 100 free credits, no credit card required. A search, a news search or a page read costs 1 credit, and each search result read in full costs 1 more. A page of up to 20 places from Maps costs 3 credits.
        </p>
        {store === "keychain" ? (
          <p className="s1b-muted">
            On a Mac the key is kept in your Keychain, in an item named buzz-search1api. Buzz plugins are not sandboxed: a plugin that declares the{" "}
            <code>security</code> program could read it too, and its install review lists that. Install only plugins you trust.
          </p>
        ) : store === "secret-service" ? (
          <p className="s1b-muted">
            On Linux the key is kept in the system secret store (gnome-keyring, KWallet or another), in an item with the attributes service
            buzz-search1api and account search1api. If no Secret Service is running, it is kept in this app's profile as plain text instead, and this
            card says so. Install only plugins you trust.
          </p>
        ) : (
          <p className="s1b-muted">
            On this system the key is kept in this app's profile, as plain text. Buzz plugins are not sandboxed, so any other plugin you install could
            read it: install only plugins you trust.
          </p>
        )}
      </section>
    );
  };
}
