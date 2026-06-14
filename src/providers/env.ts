const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'TERM',
]);

const DENIED_ENV_KEYS = new Set(['API_KEY', 'DATABASE_URL', 'VITE_API_KEY']);

export interface SafeChildEnvironmentOptions {
  prefixes: string[];
  extraEnv?: NodeJS.ProcessEnv;
  overrides?: NodeJS.ProcessEnv;
}

export function createSafeChildEnvironment(options: SafeChildEnvironmentOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const copyAllowed = ([key, value]: [string, string | undefined]) => {
    if (value === undefined || DENIED_ENV_KEYS.has(key)) return;
    if (SAFE_ENV_KEYS.has(key) || options.prefixes.some(prefix => key.startsWith(prefix))) {
      env[key] = value;
    }
  };

  for (const entry of Object.entries(process.env)) copyAllowed(entry);
  for (const entry of Object.entries(options.extraEnv ?? {})) copyAllowed(entry);
  for (const entry of Object.entries(options.overrides ?? {})) {
    const [key, value] = entry;
    if (value !== undefined) env[key] = value;
  }
  return env;
}
