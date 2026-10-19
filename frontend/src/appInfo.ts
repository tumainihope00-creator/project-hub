/**
 * Project Hub — product identity configuration.
 *
 * The single source of truth for product name, tagline, creator attribution,
 * repository links, logo references, description and version. Components must
 * read from here instead of hardcoding identity strings.
 *
 * The version is injected at build time by Vite (`define` in vite.config.ts)
 * from frontend/package.json — never edited here.
 */

export interface CreditEntry {
  name: string;
  url: string;
  role: string;
}

export interface AppInfo {
  name: string;
  tagline: string;
  description: string;
  /** SemVer injected from frontend/package.json at build time. */
  version: string;
  /** "2.0" style display version used in the sidebar wordmark. */
  versionShort: string;
  /**
   * Release channel. No release/publish pipeline is configured for this
   * project yet, so the About dialog shows an honest development state
   * instead of fabricating release information.
   */
  releaseChannel: 'development';
  creator: {
    displayName: string;
    profileUrl: string;
  };
  repositoryUrl: string;
  /**
   * Software license identifier. Verified against the repository: no LICENSE
   * file exists and no license field is declared in any package manifest, so
   * this stays null and the About dialog reports that honestly.
   */
  license: string | null;
  /** Asset references (scalable vector sources served from /public). */
  assets: {
    logo: string;
    favicon: string;
  };
  /** Third-party open-source components. Their licenses remain their own. */
  credits: CreditEntry[];
}

const version: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

export const APP_INFO: AppInfo = {
  name: 'Project Hub',
  tagline: 'Capture. Build. Ship.',
  description:
    'A personal command center for the full project lifecycle. Capture ideas, track requirements, tasks, issues and deployments, manage versioned AI prompts, and keep a complete history of every project from first idea to maintenance.',
  version,
  versionShort: version.split('.').slice(0, 2).join('.'),
  releaseChannel: 'development',
  creator: {
    displayName: 'Tumaini Kimtai',
    profileUrl: 'https://github.com/tumainihope00-creator'
  },
  repositoryUrl: 'https://github.com/tumainihope00-creator/project-hub',
  license: null,
  assets: {
    logo: '/logo.svg',
    favicon: '/favicon.svg'
  },
  credits: [
    { name: 'React', url: 'https://react.dev', role: 'UI library (MIT)' },
    { name: 'Vite', url: 'https://vite.dev', role: 'Build tool and dev server (MIT)' },
    { name: 'React Router', url: 'https://reactrouter.com', role: 'Client routing (MIT)' },
    { name: 'Express', url: 'https://expressjs.com', role: 'HTTP server (MIT)' },
    { name: 'Prisma', url: 'https://www.prisma.io', role: 'ORM (Apache-2.0)' },
    { name: 'PostgreSQL', url: 'https://www.postgresql.org', role: 'Database (PostgreSQL License)' },
    { name: 'Recharts', url: 'https://recharts.org', role: 'Charts (MIT)' },
    { name: 'lucide-react', url: 'https://lucide.dev', role: 'Interface icons (ISC)' },
    { name: 'Inter', url: 'https://rsms.me/inter', role: 'Typeface (SIL OFL 1.1)' }
  ]
};
