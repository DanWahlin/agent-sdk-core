export function optionalPeerDependencyError(
  providerLabel: string,
  packageName: string,
  err: unknown,
): Error {
  const originalMessage = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
  const looksMissing =
    code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND'
    || originalMessage.includes(`Cannot find package '${packageName}'`)
    || originalMessage.includes(`Cannot find module '${packageName}'`);

  if (!looksMissing) {
    return err instanceof Error ? err : new Error(originalMessage);
  }

  const message = [
    `${providerLabel} provider requires optional peer dependency ${packageName}, but it is not resolvable from @codewithdan/agent-sdk-core.`,
    `Install ${packageName} in the same package/workspace scope where @codewithdan/agent-sdk-core is resolved.`,
    'In npm workspaces, if agent-sdk-core is hoisted to the workspace root, install the provider SDK in the root package.json; if agent-sdk-core is installed inside a workspace package, install the provider SDK in that same workspace package.',
    `Original error: ${originalMessage}`,
  ].join(' ');

  const wrapped = new Error(message);
  if (err instanceof Error) {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${err.stack ?? err.message}`;
  }
  return wrapped;
}

export async function importOptionalPeer<T>(providerLabel: string, packageName: string): Promise<T> {
  try {
    return await import(packageName) as T;
  } catch (err: unknown) {
    throw optionalPeerDependencyError(providerLabel, packageName, err);
  }
}
