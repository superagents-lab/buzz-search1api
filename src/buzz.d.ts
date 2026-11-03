// The part of Buzz's plugin API this plugin uses, trimmed from block/buzz-app
// (src/plugins/author.ts, src/features/{host,settings,agents}/service.ts and
// src/buzz-mcp/session-tools.ts). Block ships the full types as a preview package
// built from its own repository; this copy keeps the build reproducible from this
// repository alone. Update it with the host it was written against.
import type * as ReactNamespace from "react";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** 1 to 180000; the host's default is 30 seconds. */
  timeoutMs?: number;
}>;

export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type Host = {
  request(input: HostRequest): Promise<HostResponse>;
  /** Runs a command the manifest declares, with the program and arguments it fixes; `null` is any failure. */
  runCommand(id: string, input?: string): Promise<string | null>;
};

/** What a tool call gives back to the agent: text, or data with a media type. */
export type ToolReply = string | Readonly<{ data: string; type: string; text?: string }>;

/** A tool added to every agent session in the app. The name is lowercase and no Buzz tool's. */
export type AddedTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Runs as the agent. A throw is a tool error for the agent to correct. */
  call(client: unknown, context: unknown, args: Record<string, unknown>): Promise<ToolReply>;
}>;

export type Agents = {
  addTool(tool: AddedTool): void;
};

export type SettingsCard = Readonly<{
  id: string;
  title: string;
  group?: string;
  component: ReactNamespace.ComponentType<{ active(): boolean }>;
}>;

export type CodeBlockRenderer = Readonly<{
  id: string;
  title: string;
  matches(language: string): boolean;
  component: ReactNamespace.ComponentType<{ code: string; language: string }>;
}>;

export type Conversation = {
  registerCodeBlock(renderer: CodeBlockRenderer): void;
};

export type Context = {
  react: typeof ReactNamespace;
  host: Host;
  agents: Agents;
  navigation: { open(target: { version: 1; kind: "settings"; section?: string }): Promise<unknown> };
  settingsCards: { register(card: SettingsCard): void };
  /** Runs `callback` with a scope that has `deps` once they are all present, and again whenever they come back. */
  inject(deps: string[], callback: (scope: Context) => void): void;
  /** Present only inside an `inject(["conversation"], ...)` scope. */
  conversation: Conversation;
  /** Runs `setup` now and its returned cleanup when the plugin's scope ends. */
  effect(setup: () => () => void): void;
};

// The classic JSX transform names the factory `React`, which here is a value, not the
// namespace TypeScript looks the JSX types up in. Point it at @types/react's.
declare global {
  namespace JSX {
    type Element = ReactNamespace.JSX.Element;
    type ElementClass = ReactNamespace.JSX.ElementClass;
    type LibraryManagedAttributes<C, P> = ReactNamespace.JSX.LibraryManagedAttributes<C, P>;
    interface ElementAttributesProperty extends ReactNamespace.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactNamespace.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactNamespace.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactNamespace.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactNamespace.JSX.IntrinsicElements {}
  }
}
