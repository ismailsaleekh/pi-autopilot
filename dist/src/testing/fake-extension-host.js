export class FakeCommandContext {
    notifications = [];
    ui = {
        notify: (message, kind) => {
            this.notifications.push({ message, kind });
        },
    };
}
export class FakeExtensionHost {
    commands = new Map();
    tools = new Map();
    messages = [];
    coordinationMessages = [];
    registerCommand(name, definition) {
        this.commands.set(name, definition);
    }
    registerTool(tool) {
        this.tools.set(tool.name, tool);
    }
    sendUserMessage(content, options) {
        this.messages.push({ content, deliverAs: options.deliverAs });
    }
    sendMessage(message, options) {
        this.coordinationMessages.push({ message, deliverAs: options.deliverAs, triggerTurn: options.triggerTurn });
    }
    requireCommand(name) {
        const command = this.commands.get(name);
        if (command === undefined)
            throw new Error(`Missing command ${name}`);
        return command;
    }
    requireTool(name) {
        const tool = this.tools.get(name);
        if (tool === undefined)
            throw new Error(`Missing tool ${name}`);
        return tool;
    }
}
