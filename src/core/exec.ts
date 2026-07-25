/**
 * Thin subprocess abstraction over execa. Every module that shells out (yt-dlp,
 * ffmpeg) depends on {@link CommandRunner} rather than execa directly, so tests
 * inject a fake runner and never spawn real binaries.
 */
import { execa } from 'execa';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunOptions {
  /** When false, a non-zero exit resolves (caller inspects exitCode) instead of throwing. */
  reject?: boolean;
  cwd?: string;
}

export interface CommandRunner {
  run(file: string, args: string[], opts?: CommandRunOptions): Promise<CommandResult>;
}

/** Default runner backed by execa. */
export const execaRunner: CommandRunner = {
  async run(file, args, opts) {
    const res = await execa(file, args, {
      reject: opts?.reject ?? true,
      cwd: opts?.cwd,
    });
    return {
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
      exitCode: res.exitCode ?? 0,
    };
  },
};
