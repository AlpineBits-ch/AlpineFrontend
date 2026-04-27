export interface CommandDef {
  name: string;
  description: string;
  params: { label: string; required: boolean }[];
  execute: (params: string) => string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'shrug',
    description: 'Append a shrug to your message',
    params: [{ label: 'message', required: false }],
    execute: (text) => text ? `${text} ¯\\_(ツ)_/¯` : '¯\\_(ツ)_/¯',
  },
];
