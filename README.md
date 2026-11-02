# Search1API

Give every agent in Buzz live web search, news search and full-page reading, with your own Search1API key. Agents answer from current sources and cite the links they used.

## Getting started

1. In the Buzz desktop app, open **Settings → Plugins → Manage plugins**, choose **Add**, enter `superagents-lab/buzz-search1api` and choose **Find**. Pick **Search1API**, review what it asks for, and choose **Install plugin**.
2. Open **Settings → Plugins → Search1API**, paste your API key and choose **Save key**. No key yet? [Get one at app.s1.dev](https://app.s1.dev/?utm_source=buzz&utm_medium=plugin) and start with 100 free credits, no credit card required.
3. Mention an agent and ask about something current, such as "@researcher what changed in the latest Next.js release? Cite your sources."

---

## What agents get

| Tool | What it does | Credits |
| --- | --- | --- |
| `search1api_search` | Searches the live web. Agents can pick a source (Google by default, or Bing, GitHub, Reddit, YouTube, WeChat and more), scope it to sites or a recent time window, and read the top results in full. | 1, plus 1 per result read in full |
| `search1api_news` | Searches recent news, or Hacker News discussions. | 1 |
| `search1api_crawl` | Reads one page and returns its main content as text. | 1 |

Buzz adds the tools to every agent session in the app (Claude, Codex, Goose and Pi agents), and agents load them when they need them.

## Your key

- The key is checked with Search1API before it is saved (`GET /usage`, which spends no credits) and is never shown again.
- On macOS it is kept in your Keychain (an item named `buzz-search1api`); on Linux in the Secret Service (gnome-keyring, KWallet), with the attributes `service buzz-search1api` and `account search1api`. Where neither is available, it is kept in the app profile in plain text, and the settings card says so.
- It is sent only to `https://api.search1api.com`, the one origin the manifest declares, in the `Authorization` header. It is never put in a URL, an error message or a log.
- Buzz plugins run as trusted code, not in a sandbox. Read `plugin.js` before installing: it is one plain JavaScript file built from `src/`.

## Developing

```sh
pnpm install
pnpm build   # type-checks src/ and writes plugin.js
pnpm test    # unit tests, including the built plugin.js against a stand-in Buzz context
```

Buzz never runs a build, so the built `plugin.js` is committed next to its source. Rebuild before you push.

To try a local change, load this folder in **Settings → Plugins → Manage plugins → Add → Load from folder**, or point the repository import at your branch.

## Credits

The key storage (`src/keys.ts`), the settings-card flow and the key-store test harness are adapted from the Linear plugin in [0xnfrith/buzz-plugins](https://github.com/0xnfrith/buzz-plugins), under the Apache License 2.0. See `NOTICE`.

## License

Apache License 2.0.
