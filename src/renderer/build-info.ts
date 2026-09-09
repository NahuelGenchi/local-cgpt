/**
 * Read-only desktop build identity.
 *
 * These values are compile-time constants injected by electron.vite.config.ts. They never
 * come from the network, IPC, localStorage or user content. Tests that import renderer
 * modules without Vite get the explicit `unknown` fallback instead of inventing metadata.
 */
declare const __LOCAL_CGPT_APP_VERSION__: string;
declare const __LOCAL_CGPT_SOURCE_REVISION__: string;

export interface BuildIdentity {
  version: string;
  revision: string;
}

export function buildIdentity(): BuildIdentity {
  const version =
    typeof __LOCAL_CGPT_APP_VERSION__ === 'string' && __LOCAL_CGPT_APP_VERSION__.trim()
      ? __LOCAL_CGPT_APP_VERSION__.trim()
      : 'unknown';
  const revision =
    typeof __LOCAL_CGPT_SOURCE_REVISION__ === 'string' &&
    /^[0-9a-f]{7,40}$/i.test(__LOCAL_CGPT_SOURCE_REVISION__.trim())
      ? __LOCAL_CGPT_SOURCE_REVISION__.trim().toLowerCase()
      : 'unknown';
  return { version, revision };
}

function fact(label: string, value: string, title?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fact';
  const name = document.createElement('span');
  name.textContent = label;
  const code = document.createElement('code');
  code.textContent = value;
  if (title) code.title = title;
  row.append(name, code);
  return row;
}

/** Adds one compact, stable section to Health without becoming another source of app state. */
export function mountBuildIdentity(): void {
  if (document.getElementById('buildIdentity')) return;
  const healthFacts = document.getElementById('facts');
  if (!healthFacts) return;

  const identity = buildIdentity();
  const section = document.createElement('section');
  section.id = 'buildIdentity';
  section.className = 'facts';
  section.setAttribute('aria-label', 'Build identity');
  section.append(
    fact('App version', identity.version === 'unknown' ? 'unknown' : `v${identity.version}`),
    fact(
      'Source revision',
      identity.revision === 'unknown' ? 'unknown' : identity.revision.slice(0, 12),
      identity.revision === 'unknown' ? undefined : identity.revision
    )
  );
  healthFacts.insertAdjacentElement('afterend', section);
}
