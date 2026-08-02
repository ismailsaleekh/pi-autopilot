declare module "@earendil-works/pi-coding-agent" {
  export interface EventBus {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  }

  export interface ExtensionContext {
    readonly hasUI?: boolean;
    readonly mode?: string;
    readonly ui: { notify(message: string, level?: string): void | Promise<void> };
    readonly sessionManager: { getSessionId(): string };
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface ToolDefinition {
    readonly name: string;
    readonly label?: string;
    readonly description?: string;
    readonly promptSnippet?: string;
    readonly promptGuidelines?: readonly string[];
    readonly parameters?: unknown;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown> | unknown;
  }

  export interface ExtensionAPI {
    readonly events: EventBus;
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
    registerCommand(name: string, definition: { readonly description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }): void;
    registerTool(definition: ToolDefinition): void;
    appendEntry(name: string, value: unknown): void;
    sendMessage(message: string | Record<string, unknown>, options?: string | Record<string, unknown>): void | Promise<void>;
    getActiveTools(): Iterable<string>;
  }

  export function defineTool<T extends ToolDefinition>(definition: T): T;
}
