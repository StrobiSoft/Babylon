import type { CommandExecutionSemantics, JsonObject } from './types.js';

export interface CommandReference {
  table_id: string;
  table_version: string;
  command_id: string;
}

export interface CommandContext {
  senderNodeId: string;
  messageId: string;
  attemptId: string;
  executionKey: string;
}

export interface CommandDefinition extends CommandReference {
  requiredCapability: string;
  executionSemantics: CommandExecutionSemantics;
  handler: (context: CommandContext) => Promise<JsonObject> | JsonObject;
}

function commandKey(reference: CommandReference): string {
  return `${reference.table_id}\u0000${reference.table_version}\u0000${reference.command_id}`;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError(`invalid ${field}`);
  }
}

export function parseCommandReference(body: JsonObject): CommandReference {
  const keys = Object.keys(body).sort();
  const expected = ['command_id', 'table_id', 'table_version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('command body must contain only table_id, table_version, and command_id');
  }

  const tableId = body['table_id'];
  const tableVersion = body['table_version'];
  const commandId = body['command_id'];
  assertIdentifier(tableId, 'table_id');
  assertIdentifier(tableVersion, 'table_version');
  assertIdentifier(commandId, 'command_id');

  return {
    table_id: tableId,
    table_version: tableVersion,
    command_id: commandId,
  };
}

export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>();

  register(definition: CommandDefinition): void {
    const key = commandKey(definition);
    if (this.#commands.has(key)) {
      throw new Error('duplicate command registration');
    }
    this.#commands.set(key, definition);
  }

  resolve(reference: CommandReference): CommandDefinition | undefined {
    return this.#commands.get(commandKey(reference));
  }
}
