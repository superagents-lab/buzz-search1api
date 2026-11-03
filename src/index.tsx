import type { Context } from "./buzz";
import { createClient } from "./client";
import { createKeyStore, detectStore } from "./keys";
import { provideReact } from "./react";
import { createSettingsCard } from "./settings";
import { CSS } from "./styles";
import { createTools } from "./tools";
import { BLOCK_LANGUAGE, createRenderTool } from "./render";
import { ResultCards } from "./cards";

export const inject = ["react", "settingsCards", "agents", "host"];

export function apply(ctx: Context) {
  provideReact(ctx.react);

  // The Keychain is macOS's and the Secret Service is Linux's. Where the system has neither, the key can only be
  // kept in the profile, and the settings card says so.
  const keys = createKeyStore(window.localStorage, {
    store: detectStore(navigator.platform, navigator.userAgent),
    run: (command, input) => ctx.host.runCommand(command, input),
  });
  // `ctx.host.request` is the only way out, to the one origin the manifest declares (https://api.search1api.com).
  const client = createClient(
    (request) => ctx.host.request(request),
    async () => {
      await keys.ready;
      return keys.read();
    },
  );

  ctx.effect(() => {
    // [DOM] API v1 has no separate CSS and the host has no style service: one <style> element, removed with the plugin.
    const style = document.createElement("style");
    style.dataset.search1apiBuzz = "";
    style.textContent = CSS;
    document.head.append(style);
    return () => style.remove();
  });

  for (const tool of [...createTools(client), createRenderTool()]) ctx.agents.addTool(tool);

  // Cards need the conversation service; the tools work without it, so it is optional here.
  ctx.inject(["conversation"], (scope) => {
    scope.conversation.registerCodeBlock({
      id: "results",
      title: "Search1API results",
      matches: (language) => language.trim().toLowerCase() === BLOCK_LANGUAGE,
      component: ResultCards,
    });
  });

  ctx.settingsCards.register({
    id: "settings",
    title: "Search1API",
    group: "Plugins",
    component: createSettingsCard({ keys, client }),
  });
}
