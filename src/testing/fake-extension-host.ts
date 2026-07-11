import type { ContextBudgetToolDefinition } from '../core/context-budget.ts';
import type {
  ExtensionCommandContextLike,
  ExtensionCommandDefinitionLike,
  ExtensionHostLike,
  NotificationKind,
} from '../extension.ts';
import type { CoordinationMessageInjection } from '../core/coordination/supervisor.ts';

export interface SentUserMessage {
  readonly content: string;
  readonly deliverAs: 'followUp';
}

export interface SentCoordinationMessage {
  readonly message: CoordinationMessageInjection;
  readonly deliverAs: 'steer' | 'followUp';
  readonly triggerTurn: boolean;
}

export interface UiNotification {
  readonly message: string;
  readonly kind: NotificationKind | undefined;
}

export class FakeCommandContext implements ExtensionCommandContextLike {
  readonly notifications: UiNotification[] = [];
  readonly ui = {
    notify: (message: string, kind?: NotificationKind): void => {
      this.notifications.push({ message, kind });
    },
  };
}

export class FakeExtensionHost implements ExtensionHostLike {
  readonly commands = new Map<string, ExtensionCommandDefinitionLike>();
  readonly tools = new Map<string, ContextBudgetToolDefinition>();
  readonly messages: SentUserMessage[] = [];
  readonly coordinationMessages: SentCoordinationMessage[] = [];

  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void {
    this.commands.set(name, definition);
  }

  registerTool(tool: ContextBudgetToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  sendUserMessage(content: string, options: { readonly deliverAs: 'followUp' }): void {
    this.messages.push({ content, deliverAs: options.deliverAs });
  }

  sendMessage(message: CoordinationMessageInjection, options: { readonly deliverAs: 'steer' | 'followUp'; readonly triggerTurn: boolean }): void {
    this.coordinationMessages.push({ message, deliverAs: options.deliverAs, triggerTurn: options.triggerTurn });
  }

  requireCommand(name: string): ExtensionCommandDefinitionLike {
    const command = this.commands.get(name);
    if (command === undefined) throw new Error(`Missing command ${name}`);
    return command;
  }

  requireTool(name: string): ContextBudgetToolDefinition {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`Missing tool ${name}`);
    return tool;
  }
}
